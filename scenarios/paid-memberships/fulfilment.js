'use strict';
/**
 * PAID MEMBERSHIPS — steps 3 and 4: believing the money, and catching what
 * you missed.
 *
 * Two ways in, one door:
 *
 *   PUSH   the signed `donation.completed` webhook. Real time, authoritative,
 *          and at-least-once — so it can arrive twice, and it can not arrive
 *          at all if your server was busy being redeployed.
 *   PULL   `paidMessages()`, the same confirmed money as a cursor-paginated
 *          ledger. Slow, complete, and always there.
 *
 * Both funnel into ONE function, `creditOrder()`, whose entire job is to be
 * safe to call twice. That is the design: never write two granting paths,
 * because the day they disagree is the day a member is charged and locked
 * out, or granted a year for free.
 *
 * What is NOT a way in:
 *   · the return redirect (anyone can type that URL — see server.js)
 *   · `paid_message.created` (a tip WITH a message fires BOTH that and
 *     donation.completed, same data, different delivery ids — credit one)
 *   · anything with isTest: true (a rehearsal from the dashboard)
 */
const { MEMBERSHIP, withRateLimitRetry } = require('./checkout');

const DAY_MS = 24 * 60 * 60 * 1000;
/** An intent dies after an hour; give a payment that started at 59:59 room to
 *  confirm before we call the order abandoned. */
const ABANDON_GRACE_MS = 15 * 60 * 1000;
const RECONCILE_PAGE_SIZE = 50;

/**
 * Memberships, and the events already spent on them.
 *
 * IN PRODUCTION THIS IS TWO TABLES:
 *   memberships(user_id PK, state, period_ends_at, updated_at)
 *   membership_credits(event_id PK, user_id, ref, credited_at)   -- UNIQUE on event_id
 *
 * The second table is not bookkeeping, it is the safety rail: a UNIQUE INDEX
 * on event_id is what makes "credit this donation" survive being called from
 * a webhook retry and a reconciliation sweep at the same time, on two
 * machines, with no lock between them. The insert either succeeds or violates
 * the constraint, and the violation means "someone else already did it".
 */
function createMembershipStore() {
  const byUser = new Map();
  const creditedEventIds = new Set();

  return {
    get(userId) {
      return byUser.get(userId) ?? null;
    },

    list() {
      return [...byUser.values()];
    },

    hasCredited(eventId) {
      return Boolean(eventId) && creditedEventIds.has(eventId);
    },

    /**
     * Extend (or start) a membership period. Called ONLY after an order has
     * been claimed, so "extend" can never run twice for one payment.
     */
    extend(userId, { now, ref, eventId, source }) {
      const existing = byUser.get(userId);
      // Extend from the current period end when the member renewed early,
      // from now when they had lapsed. Renewing early must not cost them the
      // time they already paid for.
      const from = existing && existing.periodEndsAt > now ? existing.periodEndsAt : now;
      const record = {
        userId,
        state: 'active',
        periodEndsAt: from + MEMBERSHIP.periodDays * DAY_MS,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        lastOrderRef: ref,
        lastEventId: eventId,
        lastSource: source,
        periods: (existing?.periods ?? 0) + 1,
      };
      byUser.set(userId, record);
      if (eventId) creditedEventIds.add(eventId);
      return record;
    },
  };
}

/**
 * The single granting path. Every caller — webhook, sweep, a future admin
 * "re-run this order" button — goes through here.
 *
 * Idempotency is enforced twice on purpose, because the two guards fail in
 * different directions:
 *   1. `creditedEventIds` catches the SAME donation arriving again.
 *   2. `orders.claim()` catches the same ORDER being fulfilled again, even by
 *      a different event id (a support tool, a bad backfill, a bug).
 * Either one alone leaves a hole; together, granting twice is a no-op.
 *
 * @returns {{ granted: boolean, reason: string, order?: object, membership?: object }}
 */
function creditOrder({ orders, memberships }, { ref, eventId, amountCents, source, now }) {
  if (!ref) {
    return { granted: false, reason: 'no ref — this tip did not come from one of our links' };
  }

  if (memberships.hasCredited(eventId)) {
    return { granted: false, reason: `event ${eventId} was already credited` };
  }

  const existing = orders.get(ref);
  if (!existing) {
    // A ref we never minted. Either another app's traffic (impossible — refs
    // are app-scoped) or our own order store lost its memory in a restart.
    // Refusing is correct: we do not know who to grant to. Alert on this.
    return { granted: false, reason: `unknown ref ${ref} — no order on file` };
  }
  if (existing.state === 'paid') {
    return { granted: false, reason: `order ${ref} is already paid` };
  }
  if (existing.state === 'abandoned') {
    // A confirmation for an order we already wrote off. The money is real, so
    // this is not a refusal on the merits — it is a refusal to guess. Someone
    // paid an intent we thought had expired, or the sweep and the payment
    // raced. Surface it: a human (or a job with an audit trail) revives the
    // order and credits the event id in one transaction.
    return { granted: false, reason: `order ${ref} was marked abandoned — needs manual review` };
  }

  // The price check. The intent pinned the amount server-side, so a mismatch
  // is not "the user paid the wrong amount" — it means something is off
  // (a hand-built link, a different product's ref, a currency surprise) and
  // the right move is to refuse and look, not to guess.
  if (amountCents !== existing.priceCents) {
    return {
      granted: false,
      reason: `amount ${amountCents} does not match the ${existing.priceCents} we minted`,
    };
  }

  const order = orders.claim(ref, { eventId, at: now });
  if (!order) return { granted: false, reason: `order ${ref} was claimed by someone else first` };

  const membership = memberships.extend(order.userId, { now, ref, eventId, source });
  return { granted: true, reason: 'granted', order, membership };
}

/**
 * Handle one verified `donation.completed`.
 *
 * By the time we are here the signature has been checked and the delivery id
 * deduped (see server.js). What is left is deciding whether this particular
 * money is OUR money.
 */
function handleDonationCompleted(event, { orders, memberships, now = Date.now() } = {}) {
  const d = event?.data ?? {};

  // A test fire from the dashboard carries a real-looking payload. It is the
  // first thing to check, before any lookup, because a test that grants a
  // membership is a free membership generator.
  if (d.isTest) return { granted: false, reason: 'isTest — rehearsal, never fulfil' };

  // `appPurpose` is echoed back only to the app that minted the intent. One
  // app can sell several things; this is how we know which product was bought
  // without trusting the amount alone.
  if (d.appPurpose && d.appPurpose !== MEMBERSHIP.purpose) {
    return { granted: false, reason: `purpose ${d.appPurpose} is not a membership` };
  }

  return creditOrder(
    { orders, memberships },
    {
      ref: d.appExternalRef,
      eventId: d.eventId,
      // `amountCents` is in the tip's own currency; `amountUsdCents` is the
      // normalised value. We priced in USD cents through the intent, so
      // amountCents is the field that has to match what we minted.
      amountCents: d.amountCents,
      source: 'webhook',
      now,
    },
  );
}

/**
 * The reconciliation sweep — the thing that makes the whole integration
 * boring to operate.
 *
 * Runs on a timer and after every deploy. It answers two questions:
 *   1. Did any confirmed payment never reach us as a webhook? (Circuit
 *      breaker tripped, endpoint 500'd, tunnel was down, we were redeploying.)
 *      `paidMessages()` is the same confirmed, non-test money, and every row
 *      echoes our `appExternalRef`, so we can credit it now with no guessing.
 *   2. Which pending orders are just abandoned carts? An intent expires after
 *      an hour; past that plus a grace window, nobody is going to pay it.
 *
 * It is SAFE TO RUN REPEATEDLY, and safe to run while webhooks are arriving,
 * because it credits through `creditOrder()` like everything else. Running it
 * twice in a row grants nothing the second time.
 */
async function reconcile(client, streamer, { orders, memberships, now, maxPages = 20 } = {}) {
  const at = now ?? Date.now();
  const summary = { pagesRead: 0, rowsSeen: 0, granted: [], skipped: 0, abandoned: [] };

  const pending = orders.listPending();

  // Rows come back newest-first, so there is no point paging past the oldest
  // order we are still waiting on. On a busy channel this is the difference
  // between reading one page and reading the whole donation history every
  // five minutes.
  // reduce, not Math.min(...spread): a channel with tens of thousands of
  // pending orders would blow the argument limit, and that is exactly the
  // channel you least want the sweep to crash on.
  const oldestPendingAt = pending.reduce(
    (oldest, order) => Math.min(oldest, order.mintedAt),
    Number.POSITIVE_INFINITY,
  );

  let cursor;
  while (pending.length && summary.pagesRead < maxPages) {
    const page = await withRateLimitRetry(
      () => client.paidMessages(streamer, { limit: RECONCILE_PAGE_SIZE, cursor }),
      { label: 'paid-messages' },
    );
    summary.pagesRead += 1;
    const rows = page?.rows ?? [];
    if (!rows.length) break;

    let reachedTheOldestOrder = false;
    for (const row of rows) {
      summary.rowsSeen += 1;
      if (Date.parse(row.occurredAt) < oldestPendingAt) reachedTheOldestOrder = true;

      // Rows with no ref are tips from somewhere else entirely — the
      // creator's own audience. They are not ours to credit.
      if (!row.appExternalRef) continue;
      if (!orders.get(row.appExternalRef)) continue;

      const result = creditOrder(
        { orders, memberships },
        {
          ref: row.appExternalRef,
          eventId: row.eventId,
          amountCents: row.amountCents,
          source: 'reconciliation',
          now: at,
        },
      );
      if (result.granted) {
        summary.granted.push({ ref: row.appExternalRef, userId: result.order.userId });
      } else {
        summary.skipped += 1;
      }
    }

    // A null cursor is the server saying "that was the last page" — trust it
    // rather than inferring the end from a short page.
    if (!page.nextCursor || reachedTheOldestOrder) break;
    cursor = page.nextCursor;
  }

  // Abandoned carts. Do this AFTER the grant pass, so a payment sitting in
  // the ledger is always found before its order is written off.
  for (const order of orders.listPending()) {
    if (at > order.expiresAt + ABANDON_GRACE_MS) {
      orders.abandon(order.ref, at);
      summary.abandoned.push(order.ref);
    }
  }

  return summary;
}

module.exports = {
  ABANDON_GRACE_MS,
  createMembershipStore,
  creditOrder,
  handleDonationCompleted,
  reconcile,
};
