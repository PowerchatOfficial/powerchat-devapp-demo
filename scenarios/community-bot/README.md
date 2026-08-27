# Scenario — a community bot for Discord or Slack

## The product

A creator has a Discord with four thousand people in it. Most of them are not watching right now,
and the ones who are do not know the other three thousand exist.

So you build the bot that fixes both. It does exactly two things:

**It announces.** When someone tips, subscribes, or follows, a line appears in `#stream-activity`:

```
💸 HoboViewer tipped $25.00 — "keep going"
🎁 GenerousViewer gifted 5 subs (Tier 1)
👋 12 new followers — Rita, Len, Sam, Ada, Jo, +7 more
```

**It keeps a live board.** One pinned message in `#live-now` that edits itself while the stream is
up — viewer count, goal progress, the last few chat lines — and quietly goes stale when it ends.

Those two features look similar and are built on completely different machinery, because they have
completely different requirements. The announcement of a $25 tip **must not be missed**, ever, even
if the bot was being redeployed at that exact second. The pinned board is allowed to miss things; it
just has to be current.

## When to use which

This is the decision the scenario exists to teach.

|                     | **Webhooks** (`bot.js`)                                      | **SSE** (`live-feed.js`)                     |
| ------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| Delivery            | At-least-once, retried up to 8 times over ~24h until you ack | Best-effort while you are connected          |
| If you are down     | You get it when you come back                                | You never learn it happened                  |
| Authenticated       | HMAC-signed per delivery                                     | The connection is; individual events are not |
| Frequency           | Low                                                          | High                                         |
| Use for             | Money, memberships, anything you act on                      | Viewer counts, chat, goal bars, live UI      |
| Cost of a duplicate | High — dedupe on `X-PowerChat-Delivery-Id`                   | Low                                          |
| Cost of a miss      | High                                                         | Zero                                         |

The rule that falls out of the table: **never credit money from SSE.** Goal topics visibly carry
money moving and it is tempting to read a tip off one. But an SSE event has no delivery guarantee,
no signature, and no replay past the server's short buffer — if your process was restarting you
simply never saw it, and nothing will ever tell you so. Money is confirmed once, by the signed
`donation.completed` webhook, in `bot.js`. `live-feed.js` draws pictures.

## Files

| File           | What it owns                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| `bot.js`       | The `node:http` receiver: verify → dedupe → ack → announce, plus the outbox   |
| `live-feed.js` | The SSE gateway: `Last-Event-ID` resume, the idle watchdog, throttled renders |

Both take a pluggable `deliver()` / `render()` that logs instead of hitting a chat platform, so you
can run either with no Discord or Slack setup at all.

## Run it

```bash
# terminal 1 — the webhook receiver
POWERCHAT_WEBHOOK_SECRET=pcw_... node scenarios/community-bot/bot.js

# terminal 2 — a public HTTPS URL, because PowerChat will not deliver to localhost
ngrok http 4000     # or cloudflared / tailscale funnel
```

Register `https://<tunnel>/webhooks/powerchat` as your receiver in the dashboard, then press **Send
test webhook**. It fires one fully signed delivery with `data.isTest = true` — which this bot routes
to `#integration-testing` with a `[TEST]` marker rather than the community channel, proving both
halves of the `isTest` rule before any real money exists.

```bash
# the live feed (separate process, separate concerns)
POWERCHAT_ACCESS_TOKEN=... POWERCHAT_STREAMER=... node scenarios/community-bot/live-feed.js
node scenarios/community-bot/live-feed.js chat,view-count,goal
```

Scopes: `webhooks:events` for `bot.js`; `stream:read` for `live-feed.js`, plus `chat:read` if you
want the `chat` topic.

### Where the real chat platform goes

`deliver()` in `bot.js` and `render()` in `live-feed.js` are the only two places that know about
Discord or Slack. Replacing them is one `fetch` each:

- **Discord** — `POST process.env.DISCORD_WEBHOOK_URL`, body `{ content: text }`
- **Slack** — `POST process.env.SLACK_WEBHOOK_URL`, body `{ text }`

Both URLs are bearer credentials: anyone holding one can post to the channel. Environment only,
never the repo, never a log line. For the pinned board, `render()` should be an **edit**
(`PATCH /channels/:id/messages/:id`) rather than a new post, or you fill the channel with a hundred
near-identical snapshots an hour.

## What to watch happen — the webhook side

```
verify  →  dedupe  →  ACK 202  →  announce (asynchronously)
```

**Verify over the raw bytes, before touching a single field.** The signature is an HMAC-SHA256 of
`"<timestamp>.<raw body>"`. Re-serializing parsed JSON changes the bytes and no signature will ever
match. This is not ceremony: an unverified receiver is an open endpoint anyone on the internet can
post fake donations to, and this bot announces donations to a room full of people. A bad signature
gets a `400`, which is **terminal** — PowerChat will not retry it, which is exactly what you want.

**Dedupe on `X-PowerChat-Delivery-Id`.** Delivery is at-least-once and that id is stable across
retries of the same delivery. Skip this step and one retried delivery is one duplicate "$50 tip!" in
the community channel.

**Ack fast, then work.** A slow receiver gets retried; ~20 consecutive failures trips a circuit
breaker and a `410` disables your endpoint permanently. But acking early is a **trade**: once you
have returned 2xx, PowerChat considers the event delivered and will never send it again, so if your
announcement then fails the retry is _your_ problem. That is why `bot.js` has an outbox with its own
bounded backoff and a dead-letter, rather than a bare `deliver()` call. Ack early and own the retry.

### The four payload rules the formatting encodes

- **A tip with a message fires two webhooks.** `donation.completed` **and** `paid_message.created`,
  identical data, _different delivery ids_ — so the deduper cannot save you; they are two genuinely
  distinct deliveries of one event. `bot.js` announces on `donation.completed` and explicitly does
  nothing on `paid_message.created`. Handle both and you double-count every tip that came with a
  message.
- **`isTest` means no money moved.** The streamer's free test method, a page with no payout provider
  connected, and dashboard test fires all arrive `isTest: true`. Announcing one as real is
  announcing money that does not exist. It goes to a staging channel, marked, never to the
  community room.
- **`isAnonymous` is not advisory.** `donorName` may still be populated on the payload, and printing
  it because it happens to be there is how a bot outs someone who paid to stay unnamed. Branch on
  the flag, never on the presence of the name.
- **A gift bomb is one event, and `subscriberName` is the gifter.** `giftCount` carries the size.
  Announcing per-recipient means inventing recipients you were never told about.

Two smaller ones: follows are **coalesced** into a 20-second window, because a raid should be one
line and not forty; and `goal.completed` progress is serialized _at delivery time_ — PowerChat
stores no payload snapshot — so a retry can legitimately report a higher number than the first
attempt. Read it as "where the goal is now", never as a replay of the original moment.

## What to watch happen — the SSE side

**`Last-Event-ID` is the whole exercise.** Every event carries an id; hand the last one back on
reconnect and the server replays what you missed during the gap. Reconnect without it and the gap is
silently dropped, which looks exactly like nothing having happened. `live-feed.js` records the id
_before_ processing the event, so a throwing handler costs you one reprocessed event instead of
everything after it.

**The idle watchdog, and an honest word about it.** PowerChat sends heartbeats — but they are SSE
_comment_ lines (`: ping`), and `src/powerchat.js` skips them without surfacing an event, as every
conforming SSE client does. So from the application's point of view **a quiet channel and a
half-open socket are the same observation: nothing arrives.** There is no way to tell them apart,
and the watchdog does not pretend to. After five idle minutes it simply tears the socket down and
reconnects, because a dead TCP connection can otherwise sit there for a very long time before the
kernel notices, and reconnecting is cheap and — with `Last-Event-ID` — always safe: at worst you
reconnect to a healthy stream and the replay hands you nothing, because you missed nothing. The
pinned message shows its own age for the same reason: a board with no timestamp is
indistinguishable from a bot that died an hour ago.

**A missing scope costs one feature, not the feed.** The `chat` topic needs `chat:read` _on top of_
`stream:read` and is by far the usual cause of a 403 here. `live-feed.js` drops `chat` from the topic
list and reconnects with the rest instead of dying.

**Renders are throttled to one per five seconds.** Chat arrives far faster than any chat platform
lets you edit a message; bursts coalesce and the trailing state still renders.

## What this deliberately does not do

- **No real Discord or Slack calls.** `deliver()` and `render()` log. Swapping them is the one edit.
- **No durable stores.** The deduper, the outbox, the follow buffer, and `lastEventId` are all in
  memory and every one is annotated with the table it should be: `webhook_deliveries` with a unique
  index on `delivery_id` (`INSERT ... ON CONFLICT DO NOTHING`, announce only if a row was inserted —
  which is what makes it correct behind a load balancer), `announcement_outbox`, and a
  `stream_cursors` row for the resume point. A restart is exactly when you need `lastEventId`, and
  in-memory is exactly when you do not have it.
- **No OAuth flow.** Tokens come from the environment; `server.js` has the real connect and refresh.
  For a long-running SSE consumer, build the client with `getAccessToken` rather than a fixed token,
  or a token that expires mid-stream makes every reconnect fail with the same dead credential.
- **No commands or slash handlers.** This bot is output-only.
- **No money credited anywhere but `donation.completed`.**
