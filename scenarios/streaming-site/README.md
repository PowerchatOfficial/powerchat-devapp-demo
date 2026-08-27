# Scenario: an independent streaming site

## The product

You run a live-streaming site. Creators go live on it, and it has everything a streaming site has:
its own chat room, its own concurrent-viewer count, its own follow button, and paid channel
memberships with tiers, renewals, and gifting.

Your creators do not stream only on your site. They multistream, and they already have an overlay
set — alert box, chat box, viewer chip, sub goal, subathon timer — built in PowerChat and pointed at
Twitch and Kick. Today your site is a hole in that overlay: a viewer who follows on your site
triggers nothing, your chat is invisible next to the Twitch chat, and the viewer chip undercounts
the audience by however many people are watching you.

**The behaviour you are shipping:** a creator connects your site once, and from then on your chat
appears in their chat overlay beside Twitch and Kick, your viewers are counted in their viewer chip,
your follows fire their follow alert and move their follow goal, and your memberships fire their sub
alert and add subathon time — with the same alerts, the same sounds, the same goals. One overlay set,
regardless of where they stream. Nothing for the creator to configure per platform.

That is what this scenario builds.

---

## The data flow

```
  YOUR SITE (site.js)              BRIDGE (bridge.js)                        POWERCHAT
  ═════════════════════            ══════════════════════════════            ═══════════════════

  chat_messages                    dedupe on derived messageId
     └─ 'chat' ─────────────────▶  ├─ resolve avatar → absolute https  ──▶  POST /chat        202
                                   ├─ initials for the placeholder            │
                                   └─ meter: 100/min, DROP overflow           └─▶ chat overlay
                                                                                  (moderated —
                                                                                   202 ≠ shown)

  viewer_sessions                  coalesce every join/leave
     └─ 'viewers' ──────────────▶  ├─ debounce changes to ≥5s        ──────▶  POST /view-count
                                   ├─ heartbeat ≤30s (server expires 90s)     └─▶ viewer chip
                                   └─ post null when the stream ends

  follows                          externalId = site user id
     └─ 'follow' ───────────────▶  └─ queue + retry, never drop      ──────▶  POST /follows
                                                                              └─▶ follow alert
                                                                                  + follow goal

  memberships                      externalId = user id + TERM
     └─ 'membership' ───────────▶  ├─ isResub on a renewal           ──────▶  POST /subscriptions
  gifts                            │                                          └─▶ sub alert
     └─ 'gift' ─────────────────▶  └─ ONE event, giftCount = N                    + sub goal
                                                                                  + subathon time

                                   ┌──────────────────────────────┐
                                   │ shared across all four rails │
                                   │  · capability gating (403)   │
                                   │  · 429 / 5xx backoff+jitter  │
                                   │  · outbox for durable rails  │
                                   │  · lifecycle: live → offline │
                                   └──────────────────────────────┘
```

The left column is the half you already have. The right column is PowerChat. Everything worth reading
is in the middle.

---

## The files

| File        | What it is                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site.js`   | Your existing product, in miniature: a channel, viewers, chat, followers, memberships, on an EventEmitter. Imports nothing from PowerChat on purpose — map it onto your own system and delete it. |
| `bridge.js` | The integration. Everything that turns four POST endpoints into something you can leave running during a real broadcast.                                                                          |
| `run.js`    | Wires the two together and plays a scripted ~60-second broadcast so you can watch the whole lifecycle in one command.                                                                             |

---

## Scopes, and why each one

Request these in the `scope` parameter of your `/oauth/authorize` call. Registering them on the app is
only a ceiling — a grant carries what that one authorize call asked for and the streamer consented to.

| Scope                 | Why this scenario needs it                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `chat:write`          | Put your chat room into the creator's unified chat overlay beside Twitch and Kick.                                  |
| `chat:read`           | Read history back to find out which of those messages moderation actually kept. `chat:write` alone cannot tell you. |
| `viewcount:write`     | Your concurrent viewers as their own branded chip, added into the creator's total.                                  |
| `follows:write`       | New followers on your site fire the creator's follow alert and move their follow goal.                              |
| `subscriptions:write` | Memberships, renewals, and gift bombs fire the sub alert and credit sub goals and subathon time.                    |

Not used here, and deliberately: `tips:write` is a different rail (real money — see the tipping
scenario), and `currency:write` is for declared virtual points, which a plain streaming site does not
have. `alerts:trigger` and `alerts:rich` are display-only and never credit a goal, so a real follow
must never be reported that way.

A creator can also switch an individual capability off in their dashboard without revoking anything —
keeping your viewer count while muting your chat, for instance. That reads as a 403 on one endpoint
while the others keep working, so the bridge disables that one mirror and carries on.

---

## Running it

```bash
cp .env.example .env          # from the repo root
# fill in POWERCHAT_ACCESS_TOKEN and POWERCHAT_STREAMER (node server.js gets you a token)

node scenarios/streaming-site/run.js
node scenarios/streaming-site/run.js --fast     # the same script in ~9s
```

Optional: `SITE_PUBLIC_ORIGIN=https://cdn.yoursite.tv` — the public origin your avatar paths resolve
against. It defaults to a placeholder CDN, so the demo's avatars will 404 and render as letters, which
is itself the lesson in the gotchas below.

Ctrl-C at any point. The interrupt takes exactly the same shutdown path as the end of a stream, so
the heartbeat stops and the viewer count is cleared instead of being left stale.

---

## What to watch happen

The run prints a timeline: when, which rail, what was mirrored, and what PowerChat answered.

**+0s — the stream goes live.** The view count posts immediately rather than at the first heartbeat,
so the chip appears when the stream does.

**+1s to +15s — viewers arrive and chat flows.** Six viewers join. The bridge does _not_ post a view
count per join: it coalesces and only posts when the number changed and at least 5 seconds have
passed, or when the heartbeat comes due. Each chat message shows what PowerChat answered
(`{"accepted":true}`) — accepted, not displayed.

**+18s and +26s — a membership and its renewal.** Same person, same tier, eight seconds apart, standing
in for two consecutive billing terms. Two alerts, because the idempotency key contains the term.

**+30s — a gift bomb.** Five memberships, one event, `giftCount: 5`.

**+42s — the site redelivers its last three messages.** This is the part that only a scenario can show.
The bridge logs three "duplicate suppressed" lines and sends nothing. Change the message id to a
`randomUUID()` and re-run: all three post again, each with a cheerful 202, and the creator's overlay
shows everything twice.

**+50s — the read-back.** Every send answered 202. This reads `chat/history` and reports how many of
those messages are genuinely there.

**+54s — the stream ends.** The bridge drains what is in flight and posts `count: null`.

---

## The joins — what a single-endpoint example cannot show

**Idempotency keys are derived, never minted.** Every key comes from an id your product already has:
`ovl:<site message id>`, `ovl-user:<site user id>`, `ovl-member:<user id>:<term>`, `ovl-gift:<gift id>`.
A key generated at send time is unique per _attempt_, which is the wrong grain — and there are three
routine ways to get a second attempt: a request that times out and is retried, an at-least-once
internal bus, and a bridge that restarts mid-broadcast and replays its backlog. Derived keys make all
three no-ops. That is also what makes retrying a timeout safe at all: you cannot know whether the
first attempt landed, and with a derived key you do not need to.

**Chat is dropped; memberships are queued.** They share nothing but a base URL. Chat has a hard rate
ceiling (~120/min shared with reads) that a busy room exceeds easily, and chat that arrives four
minutes late is worse than chat that never arrives — so it is metered and the overflow is counted and
dropped. A membership is worth real money to the creator, so it is queued, retried with backoff, and
parked in an outbox if it still fails. Same client, opposite policies, decided by what the data is
worth late.

**Membership keys carry the term.** Keying on the subscriber alone works perfectly for one month and
then silently swallows every renewal forever. The creator does not get an error; their resub alerts
just stop. The term comes from your billing system — the same value that decides when you charge them
again.

**A view count is a heartbeat, not a value.** Set it once and the server's freshness sweep clears it 90
seconds later, dropping the chip to 0 in the middle of a live stream. But mirroring every join and
leave 1:1 burns the whole 60/min write budget on a number nobody can read that fast. The bridge
resolves this as a small state machine: post when the number changed (no more than every 5s), post
anyway every 30s, and post `null` — not `0` — when the stream ends.

**Chat state and membership state are the same problem.** Mirrored chat carries
`isSubscriber: site.isMember(user.id)`, read live at send time, so someone who subscribed twenty
seconds ago is badged correctly on their next message. Neither endpoint's example can show that,
because it is a join between two of them.

**A 403 is a routing decision, not an exception.** Missing scope and a capability the creator switched
off both surface as 403, and both are permanent for this grant. The bridge disables that one mirror,
logs it once, and keeps the other three running. Retrying per event turns one configuration problem
into a rate-limit problem and a log nobody can read.

**Your integration cannot be allowed to crash your product.** Every site listener is wrapped, so a bug
in the mirror is a log line, not an outage on the site itself.

---

## Operational gotchas

**`202` on chat means accepted for moderation, not displayed.** Blocked words, blocked chatters, AI
moderation and duplicate-id rejection all run _after_ the response, with no per-message callback. If
your product tells creators "your chat appears on the overlay", the `chat:read` read-back is the only
thing that can keep that promise. The run reports the real number at the end.

**A bad avatar is silent.** PowerChat does not error on an avatar it cannot fetch; it renders a letter
placeholder. So a bridge shipping `/media/avatars/u_1041.png`, or a `data:` URI, or an absolute URL
still pointing at `localhost:8080`, looks perfectly healthy — 202 on everything — while every chatter
from your site shows up faceless beside the Twitch users who have pictures, and the creator concludes
your integration is the broken one. `resolveAvatarUrl` in `bridge.js` handles all four shapes and
returns `null` rather than something unfetchable, because with no `avatarUrl` at all the fallback
decides what the placeholder says.

**Display names wear decoration.** `[MOD] pixel fox`, `(VIP) Hex Wright`, `★ saltmarsh`. Naive initials
give `[M`, `(V` and `★`, so every moderator on the overlay ends up with the same bracket.
`avatarFallbackFrom` strips the tag, takes initials, and falls back to the handle — the one field that
is always plain.

**A gift bomb is one event.** `isGift: true` with `giftCount: 5`, keyed on the gift's own id, and
`subscriberName` is the _gifter_ — that is the name the alert celebrates. Sending five separate
membership events fires five alerts and credits the sub goal five times for a single action by a
single person. The recipients' own renewals next month are ordinary membership events again.

**`count: null` ends the stream; `count: 0` does not.** Zero means live with an empty room and keeps the
chip on screen for up to 90 more seconds. This is why the SIGINT path matters: a bridge that is
`SIGKILL`ed never posts the null, and the creator's page advertises a finished stream.

**Rate limits are per app, not per process.** Two bridge processes each politely staying under 60/min
add up to 120/min and both start getting 429s. The in-memory budget in `bridge.js` says so at the
point where it would need to become a shared counter.

**`Retry-After` is not visible through this client.** `src/powerchat.js` does not surface response
headers, so `backoffDelay` falls back to full-jitter exponential backoff and reads a retry hint from
the error envelope when one is present. If you fork the client, plumb `Retry-After` and the
`RateLimit-*` headers through and prefer the server's number to a guess.

**Never retry a non-429 4xx.** A 400 is a malformed payload; retrying it four times produces four
malformed payloads and nothing else. Only 429, 5xx and transport failures are retried here.

---

## What this scenario deliberately does not do

- **No money.** No tips, no checkout links, no donation webhooks. A membership is a _membership_
  event; if your site also takes real money for a creator, that is `POST /tips` on a different rail
  with a `unitsPerUsd` currency, and reporting the same event through both double-counts it.
- **No inbound direction.** Nothing here receives webhooks or opens the SSE gateway. This bridge only
  pushes; a site that also wants to react to PowerChat events adds a signed receiver.
- **No chat sampling strategy.** Overflow is dropped and counted. A real room at 400 messages a minute
  wants a policy — members and moderators first, or a per-chatter cap — and that policy is yours.
- **No durability.** Every store is a `Map` or an array with a comment naming the table and unique
  index it stands in for. Restart the process and the outbox is gone. The _derived ids_ are what make
  a restart survivable, not the in-memory sets.
- **No multi-creator fan-out.** One channel, one token. A real deployment holds a token per connected
  creator, refreshes each independently, and keeps the rate budget per app across all of them.
- **No token refresh.** `run.js` uses a static access token for readability. In production pass
  `getAccessToken` to `PowerChatClient` so a 401 refreshes and replays transparently — and remember
  refresh tokens rotate on every use.
