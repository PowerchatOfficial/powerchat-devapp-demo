'use strict';
/**
 * PAID MEMBERSHIPS — step 1 of the loop: mint a checkout, remember why.
 *
 * The product sells one thing: a $5/month membership. It does not want to be
 * a payment processor, so the money moves on the creator's PowerChat tip page
 * and this app only ever learns that it landed.
 *
 * The whole trick is a correlation id. PowerChat has never heard of our users,
 * so we attach our own id (`ref`) on the way in and read it back on the way
 * out — on the webhook as `appExternalRef`, on the return redirect as
 * `app_ref`, and on every paid-messages row. This file owns the "on the way
 * in" half: minting the intent and writing the PENDING order that the rest of
 * the loop looks up.
 *
 * Nothing here grants anything. A minted intent is a question, not an answer.
 */
const { randomUUID } = require('node:crypto');
const { PowerChatApiError } = require('../../src/powerchat');

/**
 * The product definition, in ONE place. The price is stated here, sent to
 * PowerChat here, and checked against the webhook here — three uses, one
 * constant, so they can never drift apart. A membership that costs $5 at
 * mint time and is verified against $4.99 at fulfilment time is a bug that
 * only shows up in production, at 2am, as "nobody can join".
 */
const MEMBERSHIP = {
  priceCents: 500,
  /** Our own vocabulary, echoed back as `appPurpose`. Namespaced because one
   *  app can sell several things through the same tip page. */
  purpose: 'membership_monthly',
  periodDays: 30,
};

/** PowerChat gives an intent one hour. We read `expiresAt` off the response
 *  rather than assuming — this fallback only covers a malformed reply. */
const INTENT_FALLBACK_TTL_MS = 60 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry the way the rate limiter actually wants to be treated.
 *
 * Reads are ~120/min and checkout links live in that bucket, so a burst of
 * "Join" clicks is the realistic way to trip it. Two rules:
 *   · Only 429 and 5xx are retryable. A 400 or a 403 will fail identically
 *     forever, and retrying it just burns the rest of the budget.
 *   · Back off with JITTER. Without it, every request that got limited at the
 *     same moment retries at the same moment and trips the limiter again.
 *
 * PowerChat sends `Retry-After` on a 429, but the shared client in `src/`
 * unwraps the body and drops the response headers, so we honour a
 * `retryAfterSeconds` hint if the error body carries one and otherwise back
 * off ourselves. A production client should keep the header — it is the
 * server telling you exactly how long to wait, which always beats a guess.
 */
async function withRateLimitRetry(fn, { attempts = 4, baseDelayMs = 500, label = 'request' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof PowerChatApiError && err.isRetryable;
      if (!retryable || attempt === attempts) throw err;
      const hinted = Number(err.details?.retryAfterSeconds);
      const delay = Number.isFinite(hinted)
        ? hinted * 1000
        : baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[checkout] ${label} got ${err.status}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * The order book: every checkout we have ever minted, and what became of it.
 *
 * IN PRODUCTION THIS IS A TABLE, not a Map:
 *
 *   CREATE TABLE membership_orders (
 *     ref          TEXT PRIMARY KEY,          -- UNIQUE INDEX on ref
 *     user_id      TEXT NOT NULL,
 *     state        TEXT NOT NULL,             -- pending | paid | abandoned
 *     price_cents  INTEGER NOT NULL,
 *     minted_at    TIMESTAMPTZ NOT NULL,
 *     expires_at   TIMESTAMPTZ NOT NULL,
 *     event_id     TEXT UNIQUE                -- set once, on fulfilment
 *   );
 *
 * The two unique indexes are the whole idempotency story. `ref` unique means
 * one checkout attempt can never be represented twice; `event_id` unique
 * means one PowerChat donation can never be spent on two memberships. This
 * Map imitates them and loses everything on restart, which is exactly the
 * failure the reconciliation sweep in `fulfilment.js` exists to survive.
 */
function createOrderStore() {
  const byRef = new Map();

  return {
    create(order) {
      // A ref collision would mean two users sharing one checkout. It cannot
      // happen with a UUID, but the check is free and the alternative is
      // silent cross-account fulfilment.
      if (byRef.has(order.ref)) throw new Error(`duplicate order ref ${order.ref}`);
      byRef.set(order.ref, { ...order, state: 'pending', eventId: null });
      return byRef.get(order.ref);
    },

    get(ref) {
      return byRef.get(ref) ?? null;
    },

    /**
     * The compare-and-set that makes granting idempotent. Returns the order
     * only on the FIRST pending -> paid transition; a replayed webhook, or a
     * reconciliation sweep racing a webhook, gets null and grants nothing.
     *
     * In SQL this is literally:
     *   UPDATE membership_orders SET state='paid', event_id=$2
     *    WHERE ref=$1 AND state='pending' RETURNING *;
     * and you act only if a row came back. Do not read-then-write: two
     * deliveries can read "pending" at the same instant.
     */
    claim(ref, { eventId, at }) {
      const order = byRef.get(ref);
      if (!order || order.state !== 'pending') return null;
      order.state = 'paid';
      order.eventId = eventId;
      order.paidAt = at;
      return order;
    },

    /** Pending past its intent expiry: the user walked away. Not an error. */
    abandon(ref, at) {
      const order = byRef.get(ref);
      if (!order || order.state !== 'pending') return null;
      order.state = 'abandoned';
      order.abandonedAt = at;
      return order;
    },

    listPending() {
      return [...byRef.values()].filter((o) => o.state === 'pending');
    },

    list() {
      return [...byRef.values()];
    },
  };
}

/**
 * An opaque, single-attempt order id.
 *
 * Deliberately NOT the bare user id. The ref travels through the viewer's
 * browser in a URL, so it should mean nothing to anyone but us — and a fresh
 * link per attempt needs a fresh key, or a user who clicks Join twice
 * overwrites their own pending order. The user id lives in the order row,
 * which is where a lookup belongs anyway.
 */
function newOrderRef() {
  return `ord_${randomUUID().replace(/-/g, '')}`;
}

/**
 * Mint a fresh, single-use, fixed-price checkout for one join attempt.
 *
 * Passing amountCents / purpose / redirectUri makes PowerChat mint a CHECKOUT
 * INTENT server-side: the returned URL carries only an opaque `app_intent`
 * token, the terms are held server-side and cannot be edited by the viewer,
 * the tip page renders $5.00 read-only, and the submit is refused if it does
 * not match. That is what lets us price a product through someone else's tip
 * page without trusting the browser with the price.
 *
 * One intent funds ONE tip and dies after an hour. Never cache one and hand
 * it to a second user — the replay is a 400 and they will think you are
 * broken. Minting is cheap; mint per click.
 */
async function mintMembershipCheckout(client, streamer, { userId, redirectUri, orders, now }) {
  if (!userId) throw new Error('mintMembershipCheckout needs a userId');
  const mintedAt = now ?? Date.now();
  const ref = newOrderRef();

  let link;
  try {
    link = await withRateLimitRetry(
      () =>
        client.tipCheckoutLink(streamer, {
          ref,
          redirectUri, // MUST exactly match a registered redirect URI, or 403
          amountCents: MEMBERSHIP.priceCents,
          purpose: MEMBERSHIP.purpose,
        }),
      { label: 'tip-checkout-link' },
    );
  } catch (err) {
    // Turn the two failures that actually happen into sentences a developer
    // can act on, and let anything else surface unchanged.
    if (err instanceof PowerChatApiError && err.status === 403) {
      throw new Error(
        'PowerChat refused the checkout link (403). Either `checkout:attribute` was never ' +
          'REQUESTED in the authorize call (registering it on the app is not enough), or ' +
          `the redirect_uri "${redirectUri}" is not registered on the app character for character.`,
      );
    }
    throw err;
  }

  const expiresAt = Date.parse(link.expiresAt ?? '') || mintedAt + INTENT_FALLBACK_TTL_MS;

  // Write the PENDING order BEFORE the user can possibly pay. If we redirected
  // first and stored second, a fast payer could produce a webhook for a ref we
  // have never heard of — and "unknown ref" is a refusal, not a retry.
  const order = orders.create({
    ref,
    userId,
    priceCents: MEMBERSHIP.priceCents,
    purpose: MEMBERSHIP.purpose,
    mintedAt,
    expiresAt,
    intentUrl: link.url,
  });

  return { order, url: link.url, expiresAt };
}

/**
 * For logs. The `app_intent` token is a single-use bearer credential for a
 * $5 charge — it does not belong in a log line, a Sentry breadcrumb, or a
 * support ticket.
 */
function redactIntentUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('app_intent')) {
      url.searchParams.set('app_intent', 'redacted');
    }
    return url.toString();
  } catch {
    return '<unparseable url>';
  }
}

module.exports = {
  MEMBERSHIP,
  createOrderStore,
  mintMembershipCheckout,
  newOrderRef,
  redactIntentUrl,
  withRateLimitRetry,
};
