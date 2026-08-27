# PowerChat Developer API — examples

Every way to talk to the [PowerChat](https://powerchat.live) Developer API, in one small
zero-dependency repo you can read in a sitting.

PowerChat is a streamer alerts / overlays / donations service. The Developer API lets your app plug
into it in two directions: send your chat, viewer counts, subs, and virtual currency **into** a
streamer's overlays, and receive signed webhooks, live events, and donation confirmations **out** of
PowerChat. This repo demonstrates both, end to end, against the real API.

**Who it is for**

| You are                                                           | Start with                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------ |
| Building an integration and want a working reference              | `server.js` plus the [examples table](#examples)             |
| Building a streaming platform that should feed PowerChat overlays | `03-send-chat.js`, `05-view-count.js`, `07-subscriptions.js` |
| Taking money and needing confirmation                             | `11-tip-checkout-link.js` plus [Webhooks](#webhooks)         |
| On the PowerChat team, testing the API                            | Everything — this doubles as the end-to-end harness          |

There are **no dependencies**. Node 22 built-ins only (`fetch`, `node:http`, `node:crypto`). No
install step, no lockfile drift, no supply chain.

---

## 60-second quickstart

```bash
git clone <this repo>
cd powerchat-demo
cp .env.example .env
# register an app (below), paste the client id + secret into .env
node server.js          # → control UI on http://127.0.0.1:4000, webhook receiver on :4001
```

Open <http://127.0.0.1:4000>, click **Connect PowerChat**, consent on the PowerChat screen, and the
page comes back with your streamer name and granted scopes. Every button on it now works.

`server.js` runs **two listeners**: the control server (UI, OAuth, `/api/*`) binds to `127.0.0.1`
only, and the webhook receiver (one signed route, nothing else) binds to `0.0.0.0:4001`. Only the
webhook port is ever tunneled — see [Webhooks](#webhooks) for why.

Registering the app is the only step that is not in this repo:

1. Sign in to PowerChat and enable **two-factor authentication** (Dashboard → Security). App
   registration requires it — an authenticator app or a passkey; recovery questions do not count.
2. User menu → **Developer API** → create an app.
3. Set a redirect URI of exactly `http://localhost:4000/oauth/callback`. Redirect URIs are
   **exact-match** — scheme, host, port, path, and query. No wildcards, no prefix matching. The
   callback lands on the loopback control server, so the registered URI is a `localhost` one —
   never the tunnel hostname.
4. Tick the scopes you want. This demo requests all of them so every button works; a real app should
   request the narrowest set it needs.
5. Copy the **client id** (`pca_…`) into `POWERCHAT_CLIENT_ID` and the **client secret** (`pcs_…`)
   into `POWERCHAT_CLIENT_SECRET`. The secret is shown exactly once — only a hash is kept. Public
   clients (SPA, mobile, desktop) skip the secret entirely and rely on PKCE.

Your app starts in **sandbox**: everything works, but only against your own account. That is not a
crippled mode — every endpoint, webhook, and SSE topic behaves exactly as it will in production. Ship
against sandbox first, then submit for review.

---

## Platform vs Integration

The API is split in two directions, and which scopes you request decides which tab streamers find
your app on in their dashboard.

|                         | PLATFORM (data goes **in**)                                                                                     | INTEGRATION (data comes **out**)                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is              | Your app behaves like Twitch or Kick: your chat, viewers, subs, and currency merge into the streamer's overlays | Your app reacts to what happens on PowerChat: signed webhooks, live events, reads, display-only alerts                                                      |
| Typical app             | A streaming site, a game, a second-screen platform                                                              | A Discord bot, a goal tracker, a merch store, a membership system                                                                                           |
| Scopes                  | `chat:write`, `viewcount:write`, `subscriptions:write`, `follows:write`, `currency:write`, `tips:write`         | `webhooks:events`, `alerts:trigger`, `alerts:rich`, `overlay:write`, `checkout:attribute`, `stream:read`, `profile:read`, `chat:read`, `paid_messages:read` |
| Streamer sees you under | Platforms                                                                                                       | Integrations                                                                                                                                                |

One app can do both. This demo does.

---

## Scopes

Scopes are granted **per streamer** on the consent screen and checked live on every request — if a
streamer shrinks or revokes a grant it applies within about 30 seconds, even to tokens already
issued.

| Scope                 | Unlocks                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| _(none)_              | `GET /me` — which streamer this token belongs to, and its actual scopes        |
| `profile:read`        | Public profile, live status, tip page URL                                      |
| `chat:read`           | Recent unified chat history (every platform merged)                            |
| `chat:write`          | Send chat into the unified chat overlay, moderated like platform chat          |
| `paid_messages:read`  | Confirmed donation history (moderated message text only)                       |
| `viewcount:write`     | Your viewer count as its own branded chip, counted toward the streamer's total |
| `subscriptions:write` | Your memberships fire sub alerts and credit goals + subathon time              |
| `follows:write`       | Your new followers fire follow alerts and credit follow goals                  |
| `currency:write`      | Redemptions in your **declared** virtual currencies — points, never money      |
| `tips:write`          | Monetary tips in a declared currency carrying a `unitsPerUsd` rate             |
| `alerts:trigger`      | Fire display-only test and custom alerts                                       |
| `alerts:rich`         | Display-only rich alerts: image, effect, colors                                |
| `overlay:write`       | Store and read back a short-TTL JSON blob for your own overlay                 |
| `checkout:attribute`  | Tag tip-page checkouts so donation webhooks echo your reference                |
| `stream:read`         | The live SSE gateway                                                           |
| `webhooks:events`     | Signed event deliveries to your registered receiver                            |

Streamers can switch **individual capabilities off** without revoking the whole grant — keeping your
view count while muting your chat, for example. A disabled capability behaves exactly like a missing
scope. Design for any subset being off.

---

## Examples

Every script is standalone, prints what it is doing, and needs only `POWERCHAT_ACCESS_TOKEN` and
`POWERCHAT_STREAMER` in `.env`. Run one, read it, adapt it.

The ones that run longer than an access token lives (~10 minutes) — `05-view-count.js`,
`13-live-stream-sse.js`, and every scenario server — also want `POWERCHAT_REFRESH_TOKEN` and
`POWERCHAT_CLIENT_ID` (+ `_SECRET` for a confidential app). They build the client on the refreshing
`getAccessToken` path from `src/credentials.js`: a 401 triggers one refresh, and the rotated pair is
written back to `.env` before the new token is used. A fixed token in a long-running process just
stops working ten minutes in.

| #   | Command                                 | What it shows                                                          |
| --- | --------------------------------------- | ---------------------------------------------------------------------- |
| 01  | `node examples/01-whoami.js`            | `GET /me` — the identity bootstrap, and the fastest way to debug a 403 |
| 02  | `node examples/02-profile.js`           | Public profile and live status                                         |
| 03  | `node examples/03-send-chat.js`         | Send chat, then read it back to see whether moderation kept it         |
| 04  | `node examples/04-chat-history.js`      | Recent unified chat across every connected platform                    |
| 05  | `node examples/05-view-count.js`        | Report viewers on a heartbeat that outlives the access token           |
| 06  | `node examples/06-follows.js`           | Report a new follower with an idempotency key                          |
| 07  | `node examples/07-subscriptions.js`     | Subs, gift subs, resubs, and declared tiers                            |
| 08  | `node examples/08-currency-and-tips.js` | The points rail vs the money rail, and why they are different          |
| 09  | `node examples/09-alerts.js`            | Test, custom, and rich alerts — display-only, never credited           |
| 10  | `node examples/10-overlay-session.js`   | Store a JSON blob your own overlay reads back                          |
| 11  | `node examples/11-tip-checkout-link.js` | Server-minted checkout intents, and correlating a tip to your user     |
| 12  | `node examples/12-paid-messages.js`     | Cursor-paginated donation history                                      |
| 13  | `node examples/13-live-stream-sse.js`   | The SSE gateway: event names, `Last-Event-ID` replay, real reconnects  |

Each also has an npm script (`npm run example:whoami`, `npm run example:send-chat`, …) if you prefer.

The shared code they all use lives in `src/`:

| File                 | Contents                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/powerchat.js`   | The whole REST + SSE surface as one client, with a `PowerChatApiError` that tells you whether to refresh, retry, or give up |
| `src/oauth.js`       | Authorization-code flow with PKCE (S256), refresh, revoke, discovery                                                        |
| `src/webhooks.js`    | Signature verification (millisecond timestamps), at-least-once dedupe, event dispatch                                       |
| `src/credentials.js` | Rotating `getAccessToken` for long-running scripts — single-flight refresh, rotated pair persisted to `.env`                |
| `src/config.js`      | `.env` loading with a readable failure when something is missing                                                            |

`npm test` (`node --test`) pins the two things that are easiest to get subtly wrong: a webhook signed
exactly the way PowerChat signs verifies (and stale / tampered / wrong-secret ones do not), and a
burst of 401s produces exactly one refresh-token rotation.

`docs/API-COVERAGE.md` maps every endpoint to the example that exercises it. A row without an example
is a gap in the harness.

---

## Scenarios — build a product, not a call

The numbered examples above teach one endpoint each. The folders in `scenarios/` teach something the
examples cannot: how the calls **join up** inside a real product — the ordering, the state kept
between them, what happens on restart, and what happens when a webhook never arrives.

Start with whichever resembles what you are building.

| Scenario                                                 | The product                                                                                                                                                                                 | Run                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [`streaming-site/`](scenarios/streaming-site/)           | An independent streaming site mirroring its own chat, viewer counts, follows, and memberships into the creator's PowerChat overlays — so one overlay set works no matter where they stream. | `npm run scenario:streaming-site:fast` |
| [`paid-memberships/`](scenarios/paid-memberships/)       | A site selling a fixed-price $5/month membership through the creator's tip page, without becoming a payment processor.                                                                      | `npm run scenario:paid-memberships`    |
| [`charity-campaign/`](scenarios/charity-campaign/)       | A fundraiser microsite: live total, donor wall that respects anonymity, milestone celebrations on the overlay.                                                                              | `npm run scenario:charity-campaign`    |
| [`interactive-overlay/`](scenarios/interactive-overlay/) | A viewer-rewards layer — earn points by watching, spend them to trigger on-stream effects.                                                                                                  | `npm run scenario:interactive-overlay` |
| [`community-bot/`](scenarios/community-bot/)             | A community bot announcing creator activity, plus a live "what's happening now" feed.                                                                                                       | `npm run scenario:community-bot`       |

Each folder has its own README that opens with the product and its user-visible behaviour, then
shows the wiring. They are deliberately opinionated about the things that are easy to get wrong:

- **Idempotency keys are derived, never invented.** A random id per attempt turns one retry into two
  follows and inflates the creator's goals.
- **Money is confirmed, never assumed.** The signed webhook is the only authority; the return
  redirect is a UX convenience anyone can forge.
- **Reconciliation is a first-class path.** Every money scenario can rebuild its state from
  `paid-messages` after a missed webhook or a restart, and is safe to re-run.
- **Failure is modelled.** Missing scopes, 429s, duplicate deliveries, and mid-flow restarts are
  handled the way production code would handle them, not ignored.

---

## Gotchas that will bite you

These are not edge cases. They are the things developers actually get wrong, in the order they
usually get them wrong.

**Registered is not requested.** A scope on your app registration is only a ceiling. Every
`/oauth/authorize` call must list each scope it wants in `scope=`, and the grant carries only what
was requested _and_ consented. The classic miss: build the webhook flow, later add `chat:write` to
the registration, never widen the authorize request — and every intake call 403s while the dashboard
insists you have the scope. Diff `GET /me` against the endpoint requirement; the grant is the truth.

**`externalId` and `messageId` are required idempotency keys.** Chat, follows, subscriptions,
currency events, tips, and rich alerts all take one. Retrying with the same id dedupes instead of
creating a second event, a second alert, a second goal credit, and a second webhook. If your source
has no native id, generate and persist one _before_ you send. Omitting it is a 400, not a default.

**`202` on chat means accepted for moderation, not displayed.** Acceptance means your message entered
the pipeline — blocks, AI moderation, profanity, duplicate-id checks. It can be dropped afterwards
with no per-message status and no webhook. To confirm display, read `GET /chat/history` back; a
message absent about two seconds after a 202 was moderated away. Watching the overlay is not a
check: it renders live messages only, often with a short on-screen TTL.

**Tip checkout: always mint the link server-side.** Every `GET /tip-checkout-link` call mints a
**single-use, one-hour checkout intent** and returns a URL carrying only an opaque `app_intent`
token — with terms (`amount_cents`, `purpose`, `redirect_uri`) or without. Terms are server-held and
tamper-proof: the tip page renders the amount read-only and refuses a submit that does not match.
One intent funds exactly one tip, so mint a fresh link per viewer journey. Do **not** hand-build
`…/tip?app_client_id=…&app_ref=…` when you need to know who paid: that URL travels through the
viewer's browser, so anyone can swap `app_ref` for someone else's order id. PowerChat treats a
hand-built ref as untrusted input and does **not** surface it as `appExternalRef`.

**`ref` is your correlation id — and only a minted one is authoritative.** Up to 128 characters,
yours to choose (your user id, an order id). Pass it to `tipCheckoutLink()` and it comes back as
`appExternalRef` on the `donation.completed` webhook and on `paid-messages` (and as `app_ref` on the
return redirect, which is a hint, never proof). It is scoped per app — only you ever see your own
refs — and it survives an anonymous tip, which is often the only way to know who tipped.

**The webhook is the only authoritative confirmation.** Never credit anything from the return
redirect: anyone can type that URL. Even on the webhook, check `amountCents` and `data.isTest` before
unlocking anything — `isTest` is true when **no money moved** (the streamer's free test method, a
page with no payout provider, dashboard test fires).

**A tip with a message fires two webhooks.** `donation.completed` **and** `paid_message.created`,
with identical data and different delivery ids. Credit money on `donation.completed` only; treat
`paid_message.created` as the display event. Handle both and you double-count every tip that came
with a message.

**View counts go stale in 90 seconds.** Re-post at least that often while live. A freshness sweep
clears stale counts and your chip drops to 0 until the next report. Post `count: null` when the
stream ends.

**Points and money are different rails.** `currency-events` carries your declared virtual currencies
— alerts and leaderboards, never money. `tips` is monetary: a declared currency with a `unitsPerUsd`
rate (100 units = $1, bit-style), converted to USD server-side, crediting tip alerts, goals, subathon
time, and totals — but never leaderboards, by design. Declaring a currency is a dashboard step
separate from holding the scope: with `currency:write` but no declared key you get a 400 "Unknown
currency", which is not an auth problem and re-authorizing will not fix it.

**Refresh tokens rotate on every use.** Replaying an already-rotated refresh token revokes the entire
family — reuse detection assumes theft. Persist the new pair atomically before you use the new access
token. And refresh on a **401**, not on your clock: a token can be rejected before its `expires_in`
elapses when consent or credentials change.

**Rate limits are per-app sliding windows.** Roughly 120/min for reads and chat, 60/min for subs,
currency, tips, and view counts, 30/min for alert triggering. Every response carries
`RateLimit-Limit`, `RateLimit-Remaining`, and `RateLimit-Reset` — read them instead of guessing, and
back off on 429.

**Every 2xx REST body is `{ "data": … }`.** Reading fields off the top level gives you `undefined`
everywhere. `src/powerchat.js` unwraps `data` for you; if you write your own client, do the same.

---

## Webhooks

Webhooks are how you find out that something actually happened. Configure one receiver per app in the
dashboard (optionally with an event-type allowlist) and you get a signing secret (`pcw_…`, shown
once) for `POWERCHAT_WEBHOOK_SECRET`.

PowerChat only delivers to a public HTTPS URL, so local development needs a tunnel — but tunnel
**only the webhook port**:

```bash
node server.js            # terminal 1 — control UI on 127.0.0.1:4000, webhook receiver on :4001
ngrok http 4001           # terminal 2 — any tunnel works: cloudflared, localtunnel, tailscale funnel
```

Why the split matters: the control server holds the streamer's grant, and every button on the page
is a token-backed mutation — send chat as this streamer, fire alerts, mint checkout links. Exposing
that listener puts those actions one HTTP request away from the internet. So `server.js` binds it to
loopback, requires a per-browser session cookie (HttpOnly, SameSite=Strict) on every `/api/*` call and
on `/connect`, binds the OAuth `state` and PKCE verifier to that session, and refuses any mutation
whose `Origin` is not its own or whose body is not `application/json`. The webhook receiver, on its
own port, serves one route and trusts nothing but the signature — that is the only thing a tunnel
should ever see. The same split applies to the scenario servers (`paid-memberships` runs its
storefront and sweep on a loopback admin port, separate from the tunneled webhook/return port).

Register `https://<your-tunnel>/webhooks/powerchat` as the receiver, paste the signing secret into
`.env`, restart the server, and press **Send test webhook** in the dashboard. It fires one fully
signed sample delivery (`data.isTest` true, delivery id prefixed `whtest_`) and shows you the live
HTTP response from your receiver — the fastest way to prove your signature check, dedupe, and
handler wiring before any real money is involved.

What the receiver in `server.js` does, and what yours must do:

| Rule                                | Why                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify over the **raw bytes**       | The signature is an HMAC-SHA256 of `"<timestamp>.<raw body>"`, where `<timestamp>` is the exact text of the `X-PowerChat-Timestamp` header. Re-serializing parsed JSON changes the bytes and no signature will ever match.                    |
| Reject stale timestamps             | `X-PowerChat-Timestamp` is unix time in **milliseconds** (`String(Date.now())` on the sender). Compare in milliseconds; anything outside a 15-minute window is a replay. Comparing `Date.now() / 1000` to it rejects every genuine delivery.  |
| Compare timing-safely               | `crypto.timingSafeEqual`, after a length check.                                                                                                                                                                                               |
| Dedupe on `X-PowerChat-Delivery-Id` | Delivery is **at-least-once** and the id is stable across retries of the same delivery. This demo dedupes in memory; use a unique index in your database.                                                                                     |
| Answer 2xx fast, work afterwards    | Transient failures retry up to 8 times on a capped exponential backoff (5s doubling toward a 1h ceiling, roughly a 24h tail). A `4xx` is terminal. About 20 consecutive failures trips a circuit breaker, and a `410` disables your endpoint. |

Deliveries are serialized fresh at each attempt, not snapshotted — `goal.updated` reports progress as
of _that_ attempt, so a retry can legitimately show newer state than the first send. Treat a webhook
as an at-least-once signal keyed by `id`, never as an immutable replay of the original moment.

---

## Running against a local PowerChat

Point `POWERCHAT_BASE_URL` at whichever host you want:

| Target                      | `POWERCHAT_BASE_URL`                    |
| --------------------------- | --------------------------------------- |
| Production                  | `https://powerchat.live`                |
| Your own instance           | `https://your-host`                     |
| Local PowerChat development | the dev tunnel URL, **not** `localhost` |

The last row is a real trap: in local PowerChat development the API is reached through the dev tunnel
URL. Calling `localhost` from your server can hit a placeholder site or split-DNS and return bare HTML
404s. If the browser works but your backend 404s, that is the cause — the API always answers with a
JSON error envelope, never bare HTML, so HTML means you are talking to the wrong host. Register a
redirect URI on the same host you are pointing at; exact-match means one registered URI per
environment.

---

## Repository layout

```
server.js            the runnable demo: loopback control server (OAuth, UI, API) + public webhook receiver
public/index.html    the browser UI — one file, inline CSS and JS, no build step
src/                 the shared client, OAuth, credentials, webhook verification, and config
examples/            one standalone script per API surface (the API tour)
scenarios/           complete product-shaped integrations (the product tour)
test/                `node --test` — webhook round trip, refresh single-flight
docs/                the endpoint-to-example coverage matrix
```

---

## Contributing an example

Examples are the point of this repo, and a good one is short.

1. Name it `NN-topic.js`, taking the next free number.
2. Keep it **dependency-free** — Node 22 built-ins only, CommonJS, 2-space indent.
3. Use `src/powerchat.js` rather than hand-rolling requests, and `requireConfig(...)` so a missing
   variable fails with a sentence instead of an empty `Bearer`.
4. Print what you are doing and what came back. Someone should learn the endpoint by reading the
   output next to the source.
5. Comment the **why**, not the what. If a line encodes a gotcha, say which one — that is the value a
   reader cannot get from the reference docs.
6. Never print a token, client secret, or webhook secret. Redact if you must show one.
7. Add a row to the table above, an `example:` script in `package.json`, and a row in
   `docs/API-COVERAGE.md`.

Bug reports that come with a failing example are the most useful kind.

---

## About

This is an official example repository maintained by the PowerChat team. It is the reference
implementation we point developers at, and the harness we use to exercise the Developer API end to
end.

The canonical, always-current API reference is served by PowerChat itself:

|                      |                                  |
| -------------------- | -------------------------------- |
| Rendered docs        | Dashboard → Developer API → Docs |
| JSON                 | `GET /api/dev/v1/docs`           |
| Agent-ready markdown | `GET /api/dev/v1/docs/prompt.md` |

If this repo and those docs ever disagree, the docs are right — and that is a bug here worth filing.

Licensed under the [MIT License](LICENSE).
