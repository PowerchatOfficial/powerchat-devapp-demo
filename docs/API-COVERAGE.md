# API coverage & the OpenVibe.Live reference integration

Two things live in this file:

1. **The coverage matrix** — every way to talk to the PowerChat Developer API, and which example
   here demonstrates it. This is the checklist that keeps the demo honest: if a row has no example,
   the demo is not finished.
2. **What we learned from OpenVibe.Live** — the first real third-party integration built on this
   API. It is open source, it runs in production, and the problems it hit are the problems the next
   developer will hit. Those lessons are baked into the examples rather than left to be rediscovered.

## Coverage matrix

Legend — **Demo**: the example script here. **OpenVibe**: whether the production reference
integration exercises that path (measured by inspecting `server/integrations/powerchat-*.js`).

| Direction   | Endpoint                                            | Scope                 | Demo                           | OpenVibe |
| ----------- | --------------------------------------------------- | --------------------- | ------------------------------ | -------- |
| Auth        | `GET /oauth/authorize` (PKCE S256)                  | —                     | `server.js` `/connect`         | yes      |
| Auth        | `POST /oauth/token` (code + refresh)                | —                     | `src/oauth.js`                 | yes      |
| Auth        | `POST /oauth/revoke`                                | —                     | `src/oauth.js`                 | yes      |
| Auth        | `GET /oauth/.well-known/oauth-authorization-server` | —                     | `src/oauth.js` `discover()`    | no       |
| Read        | `GET /me`                                           | none                  | `01-whoami.js`                 | **no**   |
| Read        | `GET /streamers/:u/profile`                         | `profile:read`        | `02-profile.js`                | yes      |
| Read        | `GET /streamers/:u/chat/history`                    | `chat:read`           | `04-chat-history.js`           | **no**   |
| Read        | `GET /streamers/:u/paid-messages`                   | `paid_messages:read`  | `12-paid-messages.js`          | **no**   |
| Read        | `GET /streamers/:u/overlay-session`                 | `overlay:write`       | `10-overlay-session.js`        | **no**   |
| Platform    | `POST /streamers/:u/chat`                           | `chat:write`          | `03-send-chat.js`              | yes      |
| Platform    | `POST /streamers/:u/view-count`                     | `viewcount:write`     | `05-view-count.js`             | yes      |
| Platform    | `POST /streamers/:u/follows`                        | `follows:write`       | `06-follows.js`                | yes      |
| Platform    | `POST /streamers/:u/subscriptions`                  | `subscriptions:write` | `07-subscriptions.js`          | yes      |
| Platform    | `POST /streamers/:u/currency-events`                | `currency:write`      | `08-currency-and-tips.js`      | yes      |
| Platform    | `POST /streamers/:u/tips`                           | `tips:write`          | `08-currency-and-tips.js`      | yes      |
| Integration | `POST /streamers/:u/test-alerts`                    | `alerts:trigger`      | `09-alerts.js`                 | yes      |
| Integration | `POST /streamers/:u/alerts/custom`                  | `alerts:trigger`      | `09-alerts.js`                 | yes      |
| Integration | `POST /streamers/:u/alerts/rich`                    | `alerts:rich`         | `09-alerts.js`                 | **no**   |
| Integration | `POST /streamers/:u/overlay-session`                | `overlay:write`       | `10-overlay-session.js`        | **no**   |
| Integration | `GET /streamers/:u/tip-checkout-link`               | `checkout:attribute`  | `11-tip-checkout-link.js`      | **no**   |
| Integration | `GET /streamers/:u/stream` (SSE)                    | `stream:read`         | `13-live-stream-sse.js`        | **no**   |
| Integration | Signed webhooks (inbound)                           | `webhooks:events`     | `server.js`, `src/webhooks.js` | yes      |

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
  bytes — re-serializing parsed JSON would break the signature.
- **Scope-gated, best-effort sends.** Every push checks the stored connection for the scope first and
  no-ops when it is missing, then surfaces a live 403 onto the connection's `last_error` so the
  dashboard can prompt a reconnect. A missing scope degrades a feature; it never throws.
- **Refresh on expiry, not on failure.** Tokens carry `token_expires_at`; the client refreshes ahead
  of time instead of treating a 401 as an outage.

### Gotchas it encodes — each one is now a comment in this repo

| Gotcha                                 | What actually happens                                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avatar URLs must be absolute `http(s)` | PowerChat silently treats relative paths, `data:`/`blob:`, or bare values as "no avatar" and renders an initial-letter placeholder. OpenVibe resolves site-relative paths against its public base URL and upgrades its own host to `https`. |
| Monetary currencies need `unitsPerUsd` | `POST /tips` 400s with "no USD rate" unless the declared currency carries a rate. OpenVibe declares Vibes bit-style at `unitsPerUsd=100` (100 Vibes = $1).                                                                                  |
| Points and money are different rails   | `currency-events` is for declared virtual points and never touches money; `tips` is monetary, credits goals/subathon/totals — and never leaderboards.                                                                                       |
| `202` on chat is not "displayed"       | Acceptance means the message entered the moderation pipeline. It can still be dropped with no callback. Read `chat/history` back to confirm.                                                                                                |
| Registered ≠ requested                 | A scope must appear in the `scope` parameter of the authorize call. Registering it on the app does nothing on its own — the classic cause of a surprise 403.                                                                                |

## Keeping this file honest

When a new endpoint ships, add its row here **and** an example that exercises it. A row without a
demo is a gap in both the documentation and the test harness.
