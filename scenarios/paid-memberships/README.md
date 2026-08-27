# Paid memberships, paid through someone else's tip page

## The product

You run a site with a **$5/month membership**. Members get the private Discord, the
archive, the thing. You want to sell it today, and you do not want to become a payment
processor to do it: no card numbers, no PCI scope, no chargeback queue, no merchant
account application that takes eleven days.

The creator you are building for already takes money on PowerChat. So route the payment
through their tip page, and unlock the membership when PowerChat tells you — with a
signature — that the money landed.

From the member's side it is four seconds:

1. They click **Join**.
2. They land on the creator's tip page with **$5.00 already filled in and locked**.
3. They pay, and come back to your "confirming…" page.
4. A second later it says **Membership active**.

That last second is the entire integration. This scenario is what happens inside it.

## Why the fixed-price link is the whole idea

The naive version of this hands the user a tip link and hopes they type `5.00`. Then you
are reading amounts off donations and guessing which ones were meant to be memberships,
someone tips $4.99 by accident, and you are doing customer support on a rounding error.

Instead, pass `amountCents` (plus `purpose` and `redirectUri`) to
`tipCheckoutLink()`. PowerChat mints a **checkout intent** server-side and hands back a
URL carrying nothing but an opaque `app_intent` token:

- the amount is **not in the URL**, so there is nothing for the browser to edit;
- the tip page renders $5.00 read-only and refuses a submit that does not match;
- the intent is **single-use** and **expires in one hour**;
- your `ref` rides along invisibly and comes back on the confirmation.

You get a fixed-price product with tamper-proof terms, and PowerChat keeps the money
rails. Mint a fresh link per click — one intent funds exactly one tip, and replaying a
consumed one is a `400` your second user would experience as "your site is broken".

## What it wires

| Surface                      | Scope                | Why it is here                                                     |
| ---------------------------- | -------------------- | ------------------------------------------------------------------ |
| `GET /tip-checkout-link`     | `checkout:attribute` | Mints the $5 single-use intent and carries your order id as `ref`. |
| `donation.completed` webhook | `webhooks:events`    | The **only** authoritative "the money landed".                     |
| `GET /paid-messages`         | `paid_messages:read` | The pull-side ledger the reconciliation sweep reads.               |

Three surfaces. The rest is your own state machine, which is the part the numbered
examples in `examples/` cannot show you.

## The files

- **`checkout.js`** — the price, the order store, and minting one intent per attempt.
  Also the 429 retry policy, because a "Join" button is exactly where a rate limit finds
  you.
- **`fulfilment.js`** — one granting path (`creditOrder`) that both the webhook and the
  reconciliation sweep call, plus the sweep itself.
- **`server.js`** — a `node:http` app that ties the routes together, on **two listeners**: a
  public one for the webhook, the return page, and the order-status poll (the one you tunnel),
  and a loopback-only admin one for the storefront, `/join`, and the sweep — the routes that
  mint intents and spend API budget, and that a real product keeps behind its own login.

## Run it

```bash
cp ../../.env.example ../../.env      # from the repo root: cp .env.example .env
# fill in POWERCHAT_ACCESS_TOKEN, POWERCHAT_STREAMER, POWERCHAT_WEBHOOK_SECRET

# webhooks only reach a public HTTPS URL, so tunnel first — ONLY the public port (4010).
# The admin listener (127.0.0.1:4012) serves the storefront and the sweep and is never exposed.
ngrok http 4010

# register BOTH on your app in the dashboard:
#   redirect URI : https://<tunnel>/membership/return   (exact match, or 403 on mint)
#   webhook URL  : https://<tunnel>/webhooks/powerchat
export MEMBERSHIP_RETURN_URI=https://<tunnel>/membership/return

node scenarios/paid-memberships/server.js
```

What is where, and why:

| Listener               | Routes                                                                       | Reachable from                             |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| public `0.0.0.0:4010`  | `POST /webhooks/powerchat`, `GET /membership/return`, `GET /api/orders/:ref` | PowerChat and the payer's browser (tunnel) |
| admin `127.0.0.1:4012` | `GET /`, `GET /join`, `POST /admin/reconcile`, `GET /api/log`                | your machine only                          |

`/join` mints an intent and allocates an order per call and `/admin/reconcile` pages through
`paid-messages` on the app's read budget, so neither belongs on a port the internet can reach.
On the admin side they are additionally guarded the way a loopback service still has to be —
requests a browser labels cross-site (`Sec-Fetch-Site`, a foreign `Origin`) are refused, `/join`
is rate limited per caller, and the sweep is **single-flight**: a second press while one is running
joins the running sweep instead of starting another. The order-status poll validates the raw
reference against the `ord_<32 hex>` shape before any lookup (never `decodeURIComponent` on an
untrusted path — `%` alone throws), and every request runs inside an error boundary that answers
500 rather than letting an exception end the process. This server also builds its client on the
refreshing `getAccessToken` path (`src/credentials.js`) — it runs for hours, an access token lives
ten minutes, and the timer sweep would otherwise start failing with 401.

Requested scopes must include `checkout:attribute`, `paid_messages:read` and
`webhooks:events`. **Registered is not requested** — a scope ticked on your app does
nothing until it appears in the `scope=` parameter of the authorize call the streamer
consented to. `GET /me` lists what you actually hold; the mint will 403 until it does.

## What to watch happen

Open `http://127.0.0.1:4012/` (the admin listener), type a user id, press **Join**, and read
the server log next to the browser.

1. **Mint.** `minted ord_9f… for u_1001` — and note the logged URL says
   `app_intent=redacted`. That token is a single-use bearer credential for a $5 charge;
   it belongs in a `Location` header and nowhere else.
2. **Pay.** You are on PowerChat now. The amount field is locked.
3. **Return.** The confirming page appears and starts polling. Watch it say
   _waiting for confirmation…_ — the browser is back, the money is real, and this app
   still refuses to grant anything.
4. **Webhook.** `GRANTED u_1001 via ord_9f… (webhook)`. The membership appears on `/`.
5. **Tip with a message instead**, and you will see a second line:
   `paid_message.created ignored (would double-count)`. Same tip, two deliveries, two
   delivery ids. Only one of them is money.
6. **Press Join, pay, and press it again with the same user** — the second grant extends
   the period rather than restarting it, and the two orders stay distinct.
7. **Press "Run the reconciliation sweep" twice.** The first may recover something; the
   second recovers nothing. That is the property worth having. Press it twice _quickly_ and
   the second reply says it joined the running sweep — overlapping sweeps are coalesced,
   never run side by side.

To see a recovery for real, stop the server while you pay, then start it again and press
the sweep — with a durable order store, that payment is found in `paid-messages` and
granted late. With the in-memory Map in this demo it logs `unknown ref`, which is the
lesson, not a bug (see below).

## The failures this handles, and how

**A missed webhook.** Your box was redeploying; the endpoint 500'd twenty times and
tripped the circuit breaker; the tunnel died. The sweep pages `paidMessages()` — the same
confirmed, non-test money, newest first, every row echoing your `appExternalRef` — and
credits anything still pending. It runs on boot and every five minutes, and it stops
paging once rows are older than your oldest pending order, so it stays cheap on a busy
channel.

**A duplicate delivery.** Deliveries are at-least-once. `X-PowerChat-Delivery-Id` is
stable across retries of one delivery, so it is deduped at the door. But the duplicate
that actually bites is _not_ a retry: a tip **with a message** fires
`donation.completed` **and** `paid_message.created`, identical data, different delivery
ids. Only `donation.completed` is treated as money.

**Granting twice.** Guarded in two places, because they fail differently:
`creditedEventIds` catches the same donation arriving again, and `orders.claim()` is a
compare-and-set that only returns on the first `pending → paid` transition. In SQL that
is `UPDATE … WHERE ref = $1 AND state = 'pending' RETURNING *` — act only if a row comes
back. Never read-then-write; two deliveries can read `pending` in the same millisecond.

**A test fire.** `isTest: true` is checked before anything else. A dashboard rehearsal
that grants a membership is a free membership generator.

**A wrong amount.** The intent pinned the price server-side, so a mismatch is not a user
paying oddly — it means something is off (a hand-built link, another product's ref). The
order is left pending and flagged, not guessed at.

**A 403 on mint.** Almost always one of two things, and the error message says both: the
scope was never _requested_, or the `redirect_uri` is not registered character for
character. Never retried — a 4xx will fail identically forever.

**A 429.** Retried with exponential backoff **and jitter**; without jitter every request
limited at the same moment retries at the same moment and trips the limiter again. Only
429 and 5xx are retried.

**The return redirect.** Handled by being ignored. It is an unauthenticated `GET` in a
browser: bookmarkable, editable, forwardable. It shows a spinner and polls your own order
state, which only a verified webhook can change.

## What a restart costs you, and what a durable version stores

Everything here lives in `Map`s that die with the process, and that is deliberate — you
can read the whole state machine without a schema. It is also the one thing you must
change first.

Persist two tables:

```sql
CREATE TABLE membership_orders (
  ref         TEXT PRIMARY KEY,        -- your correlation id; UNIQUE
  user_id     TEXT NOT NULL,
  state       TEXT NOT NULL,           -- pending | paid | abandoned
  price_cents INTEGER NOT NULL,
  minted_at   TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  event_id    TEXT UNIQUE              -- set once, at fulfilment
);

CREATE TABLE membership_credits (
  event_id    TEXT PRIMARY KEY,        -- UNIQUE: one donation, one credit, forever
  user_id     TEXT NOT NULL,
  ref         TEXT NOT NULL REFERENCES membership_orders(ref),
  credited_at TIMESTAMPTZ NOT NULL
);
```

Those two unique indexes _are_ the idempotency. They make double-granting impossible
across retries, across the webhook racing the sweep, across two app servers with no lock
between them: the insert either succeeds or violates the constraint, and the violation
means someone else already did the work.

Store the delivery id too (`webhook_deliveries(delivery_id PRIMARY KEY)`) if you want the
door-level dedupe to survive a restart as well. `createDeliveryDeduper()` in
`src/webhooks.js` is a `Set` and says so.

Order of writes matters as much as the schema: the pending order is written **before**
the user is redirected. Redirect first and a fast payer produces a webhook for a `ref`
you have never heard of — and "unknown ref" is a refusal, not a retry.

## What this deliberately does not do

- **No recurring billing.** PowerChat tips are one-shot payments; there is no mandate to
  charge next month. This sells a 30-day period and it is on you to ask again. Do not
  reach for `POST /subscriptions` to fix that — that endpoint tells PowerChat about a
  membership that exists on _your_ platform so the creator's alerts and goals fire. It
  moves no money and confirms nothing.
- **No refunds or chargebacks.** They exist. Decide who eats them before launch.
- **No proration, no plan changes, no tax.** One price, one period.
- **No display-only alerts.** Nothing here calls `test-alerts`, `alerts/custom`, or
  `alerts/rich`: they put pixels on an overlay and never credit a goal, a total, or a
  leaderboard. They cannot confirm a payment and must never be used as though they could.
- **No crediting from the redirect.** Said three times in this repo on purpose.
