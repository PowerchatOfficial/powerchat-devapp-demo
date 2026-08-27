# A charity fundraiser microsite

## The product

The creator is doing a twelve-hour charity stream for an animal shelter. The goal is
**$5,000**. They need three things, and they need them by Saturday:

- a **public page** — `raised so far`, a progress bar, and a donor wall — that they can
  link in chat and that a local newspaper might screenshot;
- a **celebration on the overlay** when the total crosses $500, $1,000, $2,500 and
  $5,000, because a milestone nobody sees is a milestone that does not raise money;
- a number that is **correct**, including after you redeploy the site at hour nine.

Donations already land on the creator's PowerChat tip page. This microsite listens, adds
up, and puts the total on a screen.

## Why the number is the hard part

Everything else here is a `<div>` with a width. The total is the product, and there are
four honest ways to get it wrong:

1. **Floats.** `raised += 12.34` a thousand times and the fundraiser is visibly wrong on
   a screen behind someone's head. Money is integer cents from the webhook to the HTML.
2. **Native amounts.** A donation's `amountCents` is in _its own currency_. Summing them
   across currencies produces a number with no meaning. `amountUsdCents` is the
   normalised value and the only one this campaign adds up.
3. **Counting twice.** A tip with a message arrives as `donation.completed` **and**
   `paid_message.created` — same data, different delivery ids, so delivery-id dedupe
   will not save you. Retries and the startup backfill can also re-deliver the same
   money. Everything dedupes on `eventId`.
4. **Starting from zero.** Restart the process at hour nine and a naive counter tells
   several hundred donors their money vanished. The boot sequence rebuilds the total from
   PowerChat before the page is served.

## What it wires

| Surface                      | Scope                | Why it is here                                                  |
| ---------------------------- | -------------------- | --------------------------------------------------------------- |
| `donation.completed` webhook | `webhooks:events`    | Real-time, signed, authoritative money.                         |
| `GET /paid-messages`         | `paid_messages:read` | The startup backfill — confirmed, non-test money, newest first. |
| `POST /alerts/rich`          | `alerts:rich`        | The milestone card on the overlay. Display only.                |

## The files

- **`campaign.js`** — the ledger: `applyDonation` (the only function allowed to change
  the total), the donor wall, milestone crossing, the backfill, and the public page as a
  plain string.
- **`server.js`** — a `node:http` app: the page, a JSON feed for an overlay, and the
  webhook receiver.

## Run it

```bash
# from the repo root, with .env filled in
ngrok http 4020
# register https://<tunnel>/webhooks/powerchat as your app's webhook endpoint
node scenarios/charity-campaign/server.js
```

Requested scopes: `webhooks:events`, `paid_messages:read`, `alerts:rich`. Note that
`alerts:rich` is **separate from** `alerts:trigger` — holding one does not grant the
other — and that **registered is not requested**: a scope only exists once it appeared in
the authorize call's `scope` parameter. `GET /me` is the source of truth.

The campaign's goal and milestones are the `createCampaign({ … })` call at the top of
`server.js`. Everything is in integer cents there too: `500_000` is $5,000.

## What to watch happen

1. **Boot.** `backfill: 3 page(s), 128 donation(s), total $2,310.00, 3 milestone(s)
seeded silently`. Three milestones were already crossed historically and **no alerts
   fired** — a restart must not empty six months of confetti onto a live overlay.
2. **Open `http://localhost:4020/`.** The total, the bar, the donor wall. The page
   refreshes itself every 15 seconds; `/api/campaign` is the same numbers for an OBS
   browser source.
3. **Have someone tip.** `+$25.00 -> $2,335.00 (46%)` and the wall updates.
4. **Tip anonymously.** The wall says **Anonymous**. There is no name stored on that
   record to leak — see below.
5. **Cross a milestone.** `milestone $2,500.00 announced (display only)` and a card
   appears on the overlay. Check the creator's tip goal afterwards: **it has not moved
   because of the alert**. It moved because of the donation.
6. **Restart the server.** The total comes back identical, and the milestones do not
   re-announce.

## The failures this handles, and how

**A replayed webhook re-firing a milestone.** The `externalId` on the rich alert is
derived from the campaign and the threshold — `campaign_shelter_2026:milestone:100000` —
never from the donation that crossed it and never random. `alerts/rich` dedupes on that
key, so even if our in-memory `firedMilestones` is lost in a restart, PowerChat drops the
second announcement. The overlay is protected by the key, not by our memory.

**One large gift clearing three milestones.** Crossing is computed from the **total**
against every unfired milestone, not from "did this donation step over the line", so all
three fire and a replay fires none.

**An anonymous donor.** When `isAnonymous` is true the name is **not stored** — the donor
record holds `null`, and `donorWall()` renders `Anonymous`. Storing the name and hiding
it in the template is one careless `JSON.stringify` in a future JSON endpoint away from
being on the public page. The only shape the rest of the app can see is the redacted one.

**A hostile donor name or message.** The donor wall is user-generated content on a page
the creator will put on stream. Every value is HTML-escaped.

**The alert endpoint failing.** A missing celebration and a missing donation are not the
same size of problem. `announceMilestones` swallows alert failures with a loud log —
including the specific hint for a `403`, which almost always means `alerts:rich` was
never requested — and the total stands regardless. Alerts are the tightest bucket in the
API (~30/min, because an alert storm is indistinguishable from an attack on an overlay),
so 429s back off with jitter; a 403 is never retried.

**A failed backfill.** The page does not show a confidently wrong total. It shows the
figure with a banner saying totals are still syncing, and the backfill retries every 30
seconds. Webhooks arriving in the meantime are counted normally — the `eventId` dedupe
means the eventual backfill will not count them twice, so the two paths overlap freely.

**A forged POST.** Every delivery is verified over the raw bytes before a single field is
read. Anyone who can reach the URL could otherwise add a zero to a charity's public
total.

**A slow handler.** Verify, dedupe, **ack 202**, then count. A receiver that is slow or
throws gets retried, and about twenty consecutive failures trips a circuit breaker that
disables the endpoint. A fundraiser whose webhook endpoint has been disabled is a
fundraiser that has stopped counting.

## What a durable version stores

The campaign lives in one object with a `Set` and an array, which is readable and wrong.
Persist:

```sql
CREATE TABLE campaign_donations (
  event_id     TEXT PRIMARY KEY,       -- UNIQUE: one donation, counted once, forever
  campaign_id  TEXT NOT NULL,
  usd_cents    INTEGER NOT NULL,       -- amountUsdCents, never amountCents
  display_name TEXT,                   -- NULL when the donor chose anonymity
  is_anonymous BOOLEAN NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE campaign_milestones (
  campaign_id TEXT NOT NULL,
  cents       INTEGER NOT NULL,
  fired_at    TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (campaign_id, cents)     -- one announcement per threshold
);
```

Then make the displayed total `SELECT sum(usd_cents) FROM campaign_donations WHERE
campaign_id = $1`, or maintain a counter **in the same transaction** as the insert. A
total that cannot be recomputed from its rows is a total you cannot defend when a donor
emails asking where their $50 went — and on a charity stream, someone will.

## What this deliberately does not do

- **Alerts never credit anything.** `alerts/rich`, `alerts/custom` and `test-alerts` are
  display-only: no goal progress, no subathon time, no leaderboard entry, no tip totals,
  never returned by `paid-messages`. That is enforced server-side. The milestone card is
  a celebration of money that was already counted by the tip itself — it is not, and
  cannot be, a way to move the creator's numbers.
- **It does not touch the creator's goals.** If the fundraiser should drive a PowerChat
  tip goal, the donations already do that on their own. This microsite is a second,
  independent view of the same money.
- **No `POST /tips` or `POST /currency-events`.** Those are for money and points
  originating on _your_ platform. This campaign observes money that originated on
  PowerChat; posting it back would double it.
- **No payouts, no receipts, no tax handling.** The charity's own processor does that.
  This is a scoreboard.
- **No authentication on the public page.** It is meant to be public. Do not add the
  donor list's raw records to it.
