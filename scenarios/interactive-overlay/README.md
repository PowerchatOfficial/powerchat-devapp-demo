# Scenario — an interactive viewer-rewards overlay

## The product

You run a watch-along site. People sit in a stream for an hour and, right now, get nothing for it.

So you build **Watch Points**. Viewers earn 10 of them per minute of watch time, silently, just by
being there. A panel next to the player shows their balance and a short menu of things they can buy:

| Reward              | Cost | What the viewer sees                                         |
| ------------------- | ---- | ------------------------------------------------------------ |
| **Hydrate!**        | 250  | A card slides across the stream telling the creator to drink |
| **Confetti drop**   | 500  | Confetti over the stream, their name on it                   |
| **Colour takeover** | 2000 | The overlay recolours to their pick for thirty seconds       |

Two things have to be true or the product does not work. The creator must see it happen on their
own overlay in OBS, in front of an audience — a reward nobody else notices is not worth 2000 points.
And the balances have to be right, because the moment a viewer sees a redemption charged twice, the
economy is dead.

Nothing here is money. Watch Points are free, unlimited, and worth nothing outside your site.

## How PowerChat delivers it

Three surfaces, each doing one job:

- **`POST /currency-events`** (`currency:write`) — your _declared_ virtual currency. It fires an
  alert and credits the streamer's points leaderboard and channel-points goal. It never computes a
  dollar value, never moves a tip total, never adds subathon time. This is the rail free points
  belong on.
- **`POST /alerts/rich`** (`alerts:rich`) and **`POST /alerts/custom`** (`alerts:trigger`) — the
  moment on screen. Both are display-only, enforced server-side: pixels, and nothing else.
- **`POST` / `GET /overlay-session`** (`overlay:write`) — an 8KB JSON blob with a TTL that your
  backend writes and the creator's browser source reads. It is how a static page on someone else's
  machine learns what your backend knows, without you shipping it a token or running a socket
  server.

The one surface deliberately **not** here is `POST /tips`. Tips are monetary — a currency carrying a
`unitsPerUsd` rate, converted to USD server-side. Watch Points are earned by sitting still. Put them
on the money rail and you are minting currency into somebody's real donation totals.

## Files

| File               | What it owns                                                              |
| ------------------ | ------------------------------------------------------------------------- |
| `economy.js`       | The ledger, earn windows, and the only code that touches `currency:write` |
| `redemptions.js`   | The catalog, the conditional debit, and the two alert endpoints           |
| `overlay-state.js` | The view model, the 8KB fit, and the TTL heartbeat                        |
| `run.js`           | Six simulated minutes of the whole loop, in a few real seconds            |

## Run it

```bash
# No account needed — every request is printed instead of sent
node scenarios/interactive-overlay/run.js --dry-run

# Against the real API
POWERCHAT_ACCESS_TOKEN=... POWERCHAT_STREAMER=... \
  POWERCHAT_POINTS_CURRENCY=watch_points \
  node scenarios/interactive-overlay/run.js
```

Scopes: `currency:write`, `alerts:rich`, `overlay:write` (add `alerts:trigger` and `SHOUT=1` to see
the custom-alert guard fire). Declare your points currency in the developer portal first —
**without** a `unitsPerUsd` rate, so it can never be sent to `/tips` by accident. With the scope but
no declared key you get a `400 Unknown currency`, which re-authorizing will not fix.

## What to watch happen

```
observe … observe      points accrue locally; nothing leaves the process
sealWindows            a window closes and becomes publishable
flush                  one currency-event per viewer per window
redeem                 debit → persist → currency-event → alerts → overlay
publish                the blob, refreshed on a heartbeat
readBack               what the browser source actually sees
```

**Earning is batched; the batch is what makes the retry safe.** Accrual is continuous, but a publish
happens once per five-minute _earn window_. The window id comes from wall-clock time, so the
idempotency key is

```
watchpoints:earn:<windowId>:<viewerId>
```

— byte-identical on every retry of that window, forever. That is the point. After a timeout you
cannot tell whether the first attempt landed, and with a stable key you do not need to: replay it.
Mint a fresh id per attempt and one flaky request permanently inflates a leaderboard and a goal bar
that belong to someone else. A window is **sealed before it is published**, too, because publishing
an open window would name a total that later grows — and the correcting write would be deduped away
as a duplicate of the smaller one.

**The ledger is yours; PowerChat's board is a lossy projection of it.** There is no "read my
currency" endpoint, because the numbers are not stored there. So when a publish fails, the viewer's
balance is still exactly right and the correct response is to _not publish_ — which is what
`maxPublishPerFlush` does when a channel has more earners than the ~60/min write budget allows. Past
roughly fifty concurrently-earning viewers, set `publishEarnings: false` and let **spending** be the
only thing that reaches the streamer's board. Spending is the interesting number anyway.

**The two alert endpoints are not interchangeable.**

|                         | `alerts/rich`              | `alerts/custom`                           |
| ----------------------- | -------------------------- | ----------------------------------------- |
| Idempotency key         | `externalId`, **required** | **none**                                  |
| A retry after a timeout | deduped                    | fires a **second** alert                  |
| Correct policy          | retry hard                 | claim locally, send **once**, never retry |

`redemptions.js` claims the custom-alert send in a set _before_ the request and never releases the
claim. On a timeout you genuinely cannot know whether the alert rendered, and for decoration a
missing alert is far cheaper than a duplicate one on a live overlay.

**The overlay blob is a cache, not a database.** `ttlSeconds` is 1–3600 and it _expires_; a `GET`
after expiry returns `null`, which always means "render the idle overlay" and never means "error".
That expiry is a feature: if your backend dies mid-stream the overlay goes quiet within a minute
instead of showing a frozen scoreboard all night. It only works if you treat the write as a
heartbeat, so `overlay-state.js` republishes at **a third of the TTL** — two missed beats and there
is still margin. It also reads back `expiresInSeconds` rather than trusting its own number, because
the server clamps instead of rejecting.

Three more things the blob will teach you the hard way otherwise:

- **One slot per app per streamer, and a POST replaces the whole blob.** It does not merge. Exactly
  one process may own this write, or two writers overwrite each other and the overlay flickers
  between two truths.
- **8KB, checked by you.** `overlay-state.js` sheds leaderboard rows until it fits and only then
  writes. Degrading the board beats failing the write, because a failed write also loses the
  _active effect_ — the part the viewer actually paid for.
- **Ship a rendered view, not database rows.** The effect carries an absolute `untilIso` so the
  overlay can expire it on its own between heartbeats.

**Failures, and what each one should do.** Every one of these is in the code:

| Failure                      | Handling                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403` on currency or overlay | The scope was never requested, or the streamer switched that capability off — the two are indistinguishable. Stop publishing, keep accruing. A missing scope degrades a feature; it never throws.                                                                     |
| `429`                        | Back off exponentially **with jitter** — every worker gets limited at the same instant and would otherwise retry at the same instant. `Retry-After` is better, but `src/powerchat.js` does not surface response headers, and the code says so rather than pretending. |
| `400`                        | Never retried. An identical body will be rejected identically forever; that is a poison pill, so the row is dropped and logged.                                                                                                                                       |
| Process restart              | Everything in memory is gone. See below.                                                                                                                                                                                                                              |
| Insufficient points          | Not an error. Debit first, conditionally; return a refusal and make no request at all.                                                                                                                                                                                |
| Reward undeliverable         | Refund **only** when the reward _was_ the alert and the alert is definitively gone. An exhausted retry is not definitive — it may yet have landed — so a flaky minute must not hand out free points.                                                                  |

**Restart.** Every in-memory store is annotated with the table it should be:

- balances → `viewer_balances`, PK `(app_id, viewer_id)`, debited with a single conditional `UPDATE`
  so two concurrent redemptions cannot both win;
- sealed windows → `earn_publications` with a **unique index on `(app_id, window_id, viewer_id)`** —
  exactly the tuple the external id is built from;
- redemptions → `redemptions`, the row committed _before_ the first outbound call;
- custom-alert claims → `custom_alert_claims`, unique on `redemption_id`, where the `INSERT` is what
  wins the race between two workers.

The PowerChat side is already safe to replay. Your side is the half that has to remember.

## What this deliberately does not do

- **No money.** No `/tips`, no checkout links, no `unitsPerUsd`. For the money rail see
  `examples/08-currency-and-tips.js` (the two rails side by side) and
  `examples/11-tip-checkout-link.js` (attribution and confirmation).
- **No token storage or refresh.** `run.js` takes a token from the environment. Real multi-streamer
  storage and rotation live in `server.js`.
- **No real presence system.** `run.js` fakes a 15-second presence tick on a virtual clock.
- **No overlay HTML.** Only the backend half of the contract, plus `readBack()` showing exactly what
  the browser source would receive.
- **No spend-side webhook.** Points are ours; nothing about them needs a durable confirmation from
  PowerChat.
