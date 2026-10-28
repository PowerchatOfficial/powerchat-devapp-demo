# API coverage & the OpenVibe.Live reference integration

> **Two ways to read this repo.** The numbered scripts in `examples/` are the API tour — one
> endpoint each, the smallest correct call. The folders in `scenarios/` are the product tour —
> complete integrations for a believable product, showing how the calls join up, what state lives
> between them, and what happens when something fails. Start with a scenario that resembles what
> you are building; drop into the numbered examples when you need one endpoint's exact shape.

Two things live in this file:

1. **The coverage matrix** — every way to talk to the PowerChat Developer API, and which example
   here demonstrates it. This is the checklist that keeps the demo honest: if a row has no example,
   the demo is not finished.
2. **What we learned from OpenVibe.Live** — the first real third-party integration built on this
   API. It is open source, it runs in production, and the problems it hit are the problems the next
   developer will hit. Those lessons are baked into the examples rather than left to be rediscovered.

## Coverage matrix

Legend — **Demo**: the example script, scenario, or shared client method here. **OpenVibe**: whether the production reference
integration exercises that path (measured by inspecting `server/integrations/powerchat-*.js`).

| Direction   | Endpoint                                                       | Scope                 | Demo                                                    | OpenVibe |
| ----------- | -------------------------------------------------------------- | --------------------- | ------------------------------------------------------- | -------- |
| Auth        | `GET /oauth/authorize` (PKCE S256)                             | —                     | `server.js` `/connect`                                  | yes      |
| Auth        | `POST /oauth/token` (code + refresh)                           | —                     | `src/oauth.js`                                          | yes      |
| Auth        | `POST /oauth/revoke`                                           | —                     | `src/oauth.js`                                          | yes      |
| Auth        | `GET /oauth/.well-known/oauth-authorization-server`            | —                     | `src/oauth.js` `discover()`                             | no       |
| Read        | `GET /me`                                                      | none                  | `01-whoami.js`                                          | **no**   |
| Read        | `GET /streamers/:u/profile`                                    | `profile:read`        | `02-profile.js`                                         | yes      |
| Read        | `GET /streamers/:u/chat/history`                               | `chat:read`           | `04-chat-history.js`                                    | **no**   |
| Read        | `GET /streamers/:u/paid-messages`                              | `paid_messages:read`  | `12-paid-messages.js`                                   | **no**   |
| Read        | `GET /streamers/:u/overlay-session`                            | `overlay:write`       | `10-overlay-session.js`                                 | **no**   |
| Platform    | `POST /streamers/:u/chat`                                      | `chat:write`          | `03-send-chat.js`                                       | yes      |
| Platform    | `POST /streamers/:u/view-count`                                | `viewcount:write`     | `05-view-count.js`                                      | yes      |
| Platform    | `POST /streamers/:u/follows`                                   | `follows:write`       | `06-follows.js`                                         | yes      |
| Platform    | `POST /streamers/:u/subscriptions`                             | `subscriptions:write` | `07-subscriptions.js`                                   | yes      |
| Platform    | `POST /streamers/:u/currency-events`                           | `currency:write`      | `08-currency-and-tips.js`                               | yes      |
| Platform    | `POST /streamers/:u/tips`                                      | `tips:write`          | `08-currency-and-tips.js`                               | yes      |
| Integration | `POST /streamers/:u/test-alerts`                               | `alerts:trigger`      | `09-alerts.js`                                          | yes      |
| Integration | `POST /streamers/:u/alerts/custom`                             | `alerts:trigger`      | `09-alerts.js`                                          | yes      |
| Integration | `POST /streamers/:u/alerts/rich`                               | `alerts:rich`         | `09-alerts.js`                                          | **no**   |
| Integration | `POST /streamers/:u/overlay-session`                           | `overlay:write`       | `10-overlay-session.js`                                 | **no**   |
| Integration | `GET /streamers/:u/tip-checkout-link` (always mints an intent) | `checkout:attribute`  | `11-tip-checkout-link.js`                               | **no**   |
| Integration | `GET /streamers/:u/stream` (SSE)                               | `stream:read`         | `13-live-stream-sse.js`                                 | **no**   |
| Bot | `POST /bot/messages` | `bot:write` | `14-bot-commands.js` | — |
| Bot | `POST /bot/run` | `bot:write` | `14-bot-commands.js, queue-bot/bot.js` | — |
| Bot | `GET /bot/commands` | `bot:commands` | `src/powerchat.js` | — |
| Bot | `PUT /bot/commands/:name` | `bot:commands` | `14-bot-commands.js, src/powerchat.js` | — |
| Bot | `DELETE /bot/commands/:name` | `bot:commands` | `src/powerchat.js` | — |
| Widgets | `GET /variables` | `overlay:write` | `15-widgets-and-variables.js, src/powerchat.js` | — |
| Widgets | `PUT /variables/:key` | `overlay:write` | `15-widgets-and-variables.js, src/powerchat.js` | — |
| Widgets | `DELETE /variables/:key` | `overlay:write` | `src/powerchat.js` | — |
| Widgets | `POST /widget-events` | `overlay:write` | `15-widgets-and-variables.js` | — |
| Data | `GET /stats` | `data:read` | `16-viewer-data.js` | — |
| Data | `PUT /stats/:key` | `data:write` | `16-viewer-data.js, src/powerchat.js` | — |
| Data | `DELETE /stats/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /stats/:key/leaderboard` | `data:read` | `16-viewer-data.js` | — |
| Data | `GET /items` | `data:read` | `16-viewer-data.js` | — |
| Data | `PUT /items/:key` | `data:write` | `16-viewer-data.js, src/powerchat.js` | — |
| Data | `DELETE /items/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /items/:key/holders` | `data:read` | `src/powerchat.js` | — |
| Data | `GET /viewers/:platform/:viewerId` | `data:read` | `16-viewer-data.js` | — |
| Data | `POST /transactions` | `data:write` | `16-viewer-data.js` | — |
| Data | `GET /lists` | `data:read` | `queue-bot/bot.js` | — |
| Data | `PUT /lists/:key` | `data:write` | `queue-bot/bot.js, src/powerchat.js` | — |
| Data | `DELETE /lists/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /lists/:key/entries` | `data:read` | `16-viewer-data.js, queue-bot/bot.js` | — |
| Data | `POST /lists/:key/entries` | `data:write` | `16-viewer-data.js, queue-bot/bot.js` | — |
| Data | `DELETE /lists/:key/entries/:id` | `data:write` | `src/powerchat.js` | — |
| Data | `POST /lists/:key/next` | `data:write` | `16-viewer-data.js` | — |
| Data | `POST /lists/:key/draw` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /rewards` | `data:read` | `src/powerchat.js` | — |
| Data | `PUT /rewards/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `DELETE /rewards/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `POST /rewards/:key/redeem` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /redemptions` | `data:read` | `src/powerchat.js` | — |
| Data | `POST /redemptions/:id` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /documents/:scope/:collection` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /documents/channel/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `PUT /documents/channel/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `PATCH /documents/channel/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `DELETE /documents/channel/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /documents/viewer/:platform/:viewerId/:collection/:key` | `data:write` | `16-viewer-data.js, src/powerchat.js` | — |
| Data | `PUT /documents/viewer/:platform/:viewerId/:collection/:key` | `data:write` | `16-viewer-data.js, src/powerchat.js` | — |
| Data | `PATCH /documents/viewer/:platform/:viewerId/:collection/:key` | `data:write` | `16-viewer-data.js, src/powerchat.js` | — |
| Data | `DELETE /documents/viewer/:platform/:viewerId/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /app/documents/:collection` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /app/documents/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `PUT /app/documents/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `PATCH /app/documents/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `DELETE /app/documents/:collection/:key` | `data:write` | `src/powerchat.js` | — |
| Data | `GET /ledger` | `data:read` | `16-viewer-data.js` | — |
| Bot | `GET /streamers/:u/stream?topics=bot` (SSE) | `stream:read`, `bot:commands` | `14-bot-commands.js` | — |
| Data | `GET /streamers/:u/stream?topics=data` (SSE) | `stream:read`, `data:read` | `src/powerchat.js` | — |
| Widgets | `GET /streamers/:u/stream?topics=widgets` (SSE) | `stream:read` | `src/powerchat.js` | — |
| Integration | Signed webhooks (inbound, ms timestamps)                       | `webhooks:events`     | `server.js`, `src/webhooks.js`, `test/webhooks.test.js` | yes      |

Six surfaces have **no** production exercise anywhere before this repo: `/me`, `chat/history`,
`paid-messages`, `alerts/rich`, `overlay-session`, `tip-checkout-link`, and the SSE gateway. Those
are exactly the rows most likely to hide bugs, which is a large part of why this demo exists — it is
a test harness as much as a teaching tool.

## What OpenVibe.Live got right (and we copied)

`OpenVibe.Live` is an open-source streaming platform that plugs into PowerChat as a pseudo-platform.
Its integration lives in five files under `server/integrations/` and is worth reading in full. The
patterns below are reproduced here because they are correct and non-obvious:

- **PKCE with `S256`, plus the client secret for confidential apps.** PowerChat rejects `plain`
  outright. OpenVibe stores the verifier server-side keyed by `state` and verifies `state` on return.
- **Webhook verification done properly**: HMAC-SHA256 over `"<timestamp>.<raw body>"`, a 15-minute
  timestamp window checked _before_ the comparison, and a timing-safe compare. It reads the raw
  bytes — re-serializing parsed JSON would break the signature. The one detail that is easy to
  miss: `X-PowerChat-Timestamp` is **milliseconds**, so the window is compared in milliseconds
  (`test/webhooks.test.js` pins the round trip against a delivery signed the way the backend
  signs).
- **Scope-gated, best-effort sends.** Every push checks the stored connection for the scope first and
  no-ops when it is missing, then surfaces a live 403 onto the connection's `last_error` so the
  dashboard can prompt a reconnect. A missing scope degrades a feature; it never throws.
- **Refresh on expiry, not on failure.** Tokens carry `token_expires_at`; the client refreshes ahead
  of time instead of treating a 401 as an outage. This repo's `src/credentials.js` does both — the
  clock is an optimisation, the 401 is the trigger — and every long-running example and scenario
  (view-count heartbeat, SSE consumers, the scenario servers) is built on that path rather than on a
  fixed ~10-minute token.

### Gotchas it encodes — each one is now a comment in this repo

| Gotcha                                 | What actually happens                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatar URLs must be absolute `http(s)` | PowerChat silently treats relative paths, `data:`/`blob:`, or bare values as "no avatar" and renders an initial-letter placeholder. OpenVibe resolves site-relative paths against its public base URL and upgrades its own host to `https`. |
| Monetary currencies need `unitsPerUsd` | `POST /tips` 400s with "no USD rate" unless the declared currency carries a rate. OpenVibe declares Vibes bit-style at `unitsPerUsd=100` (100 Vibes = $1).                                                                                  |
| Points and money are different rails   | `currency-events` is for declared virtual points and never touches money; `tips` is monetary, credits goals/subathon/totals — and never leaderboards.                                                                                       |
| `202` on chat is not "displayed"       | Acceptance means the message entered the moderation pipeline. It can still be dropped with no callback. Read `chat/history` back to confirm.                                                                                                |
| Registered ≠ requested                 | A scope must appear in the `scope` parameter of the authorize call. Registering it on the app does nothing on its own — the classic cause of a surprise 403.                                                                                |

## Scenarios — the product tour

Each folder is a small but coherent integration for a real product shape, not an endpoint demo.

| Scenario                         | The product                                                                                                                                         | PowerChat surfaces it joins                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `scenarios/streaming-site/`      | An independent streaming site (the OpenVibe.Live shape) mirroring its own chat, viewer counts, follows, and memberships into the creator's overlays | chat, view-count, follows, subscriptions, chat/history       |
| `scenarios/paid-memberships/`    | A site selling a fixed-price $5/month membership through the creator's tip page without becoming a payment processor                                | tip-checkout-link (intents), webhooks, paid-messages         |
| `scenarios/charity-campaign/`    | A fundraiser microsite with a live total, a donor wall, and milestone celebrations                                                                  | webhooks, paid-messages, alerts/rich                         |
| `scenarios/interactive-overlay/` | A viewer-rewards layer: earn points by watching, spend them to trigger on-stream effects                                                            | currency-events, alerts/rich, alerts/custom, overlay-session |
| `scenarios/community-bot/`       | A community bot announcing creator activity and keeping a live view (dispatching on `chat.message` / `view-count.updated`)                          | webhooks, SSE gateway                                        |
| `scenarios/serverless-rpg/`       | One-time declarations for an RPG answered by PowerChat                                                                                               | stats, items, bot commands                                  |
| `scenarios/queue-bot/`            | A custom chat site forwards lines to the bot and reads a join queue                                                                                  | bot/run, lists                                               |

The scenarios are where the _joins_ live — idempotency across retries, reconciliation after a missed
webhook, lifecycle on restart, and the ordering constraints that a single endpoint call can never
show you.

## Keeping this file honest

When a new endpoint ships, add its row here **and** an example that exercises it. A row without a
demo is a gap in both the documentation and the test harness.
