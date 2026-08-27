'use strict';
/**
 * redemptions.js — spending Watch Points, and the two alert endpoints that put
 * the result on screen.
 *
 * The order of operations here is the whole lesson, so it is worth stating
 * before any code:
 *
 *   1. DEBIT FIRST, and conditionally. If the balance is short we stop before
 *      anything else happens. A debit that comes after the alert means a
 *      viewer with 0 points can spam the overlay.
 *   2. PERSIST THE REDEMPTION ROW, with its own id, BEFORE any network call.
 *      That id becomes the idempotency key for everything downstream. If you
 *      generate it at send time you have nothing stable to retry with, and
 *      nothing to reconcile against after a crash.
 *   3. CREDIT THE STREAMER'S BOARD via `currency-events` (economy.js). Alerts
 *      are pixels; this is the row that counts.
 *   4. DECORATE with alerts. If this fails, the redemption still happened.
 *
 * DISPLAY-ONLY MEANS DISPLAY-ONLY. `alerts/rich` and `alerts/custom` are
 * written with effect policy `display_only` server-side: no goal progress, no
 * subathon time, no leaderboard entry, no tip total, never returned by
 * paid-messages, never on a donation webhook. If you want a redemption to
 * COUNT, it has to go through `currency-events` — which is exactly why step 3
 * exists and is not optional.
 *
 * THE ASYMMETRY BETWEEN THE TWO ALERT ENDPOINTS.
 *   alerts/rich    takes `externalId` (REQUIRED). PowerChat dedupes retries.
 *                  Retry it as hard as you like.
 *   alerts/custom  takes NO idempotency key. PowerChat cannot dedupe it. A
 *                  retry fires a SECOND alert on the streamer's overlay, and
 *                  after a timeout you cannot tell whether you need one. The
 *                  only correct handling is to claim the send locally before
 *                  the request and never retry it.
 */
const { randomUUID } = require('node:crypto');
const { PowerChatApiError } = require('../../src/powerchat');

/** POST /alerts/custom limits. */
const MAX_ACTOR_NAME = 32;
const MAX_ALERT_MESSAGE = 250;
/** POST /alerts/rich limits. */
const MAX_RICH_TITLE = 48;
const MIN_DURATION_MS = 1000;
const MAX_DURATION_MS = 30_000;
const MAX_EMOJIS = 12;

/**
 * A catalog a streamer might plausibly ship on day one.
 *
 * `deliveredBy` is the field that decides refund policy. An `overlay` reward
 * is delivered by overlay-state.js and the alert is only an announcement, so a
 * failed alert costs the viewer nothing. An `alert` reward IS the alert — if
 * it never renders, the viewer paid for nothing and we owe them a refund.
 */
const DEFAULT_CATALOG = {
  hydrate: {
    name: 'Hydrate!',
    cost: 250,
    deliveredBy: 'alert',
    title: 'HYDRATE',
    effect: 'none',
    accentColor: '#38BDF8',
    durationMs: 4000,
  },
  confetti: {
    name: 'Confetti drop',
    cost: 500,
    deliveredBy: 'alert',
    title: 'CONFETTI',
    effect: 'confetti',
    accentColor: '#F59E0B',
    durationMs: 6000,
  },
  takeover: {
    name: 'Colour takeover',
    cost: 2000,
    deliveredBy: 'overlay',
    title: 'COLOUR TAKEOVER',
    effect: 'emote-rain',
    emojis: ['💜', '✨'],
    accentColor: '#7C3AED',
    durationMs: 15_000,
    // The overlay tints itself for this long. See overlay-state.js.
    effectHoldMs: 30_000,
  },
};

function clamp(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function createRedemptions(options = {}) {
  const { client, streamer, economy } = options;
  const catalog = options.catalog ?? DEFAULT_CATALOG;
  const now = options.now ?? (() => Date.now());
  const onEffect = options.onEffect ?? (() => {});
  /** Custom alerts are noisy and share the ~30/min alert bucket with rich
   *  alerts. Off by default; run.js turns it on to demonstrate the guard. */
  const shoutWithCustomAlert = options.shoutWithCustomAlert ?? false;

  /**
   * redemptionId -> row.
   * In production this is a `redemptions` table with primary key `id`, plus a
   * UNIQUE index on (viewer_id, client_request_id) so a viewer double-clicking
   * "redeem" creates one row rather than two. The row is committed BEFORE the
   * first outbound call, which is what lets a crashed process finish the job
   * on restart instead of losing the points.
   */
  const redemptions = new Map();

  /**
   * redemptionId -> true, claimed BEFORE we call `alerts/custom`.
   * In production this is a `custom_alert_claims` table with a UNIQUE index on
   * redemption_id, and the INSERT itself is what wins the race between two
   * workers — checking a Map and then sending is only safe because this
   * process is single-threaded.
   */
  const customAlertClaims = new Set();

  const stats = { redeemed: 0, refused: 0, refunded: 0, richFailed: 0, customSkipped: 0 };

  /**
   * `alerts/rich` retry policy. Safe to be aggressive: `externalId` means a
   * retry of a request that secretly succeeded is deduped, not duplicated.
   */
  async function fireRichAlert(redemption, reward) {
    const body = {
      title: clamp(reward.title || reward.name, MAX_RICH_TITLE),
      message: clamp(
        `${redemption.displayName} spent ${redemption.cost} Watch Points`,
        MAX_ALERT_MESSAGE,
      ),
      effect: reward.effect ?? 'none',
      accentColor: reward.accentColor,
      durationMs: Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, reward.durationMs ?? 5000)),
      // REQUIRED. The persisted redemption id, so this is stable across every
      // retry and across a process restart.
      externalId: redemption.id,
      occurredAt: new Date(redemption.createdAt).toISOString(),
    };
    // `emojis` is only read by the emote-rain effect, and is capped at 12.
    if (reward.effect === 'emote-rain' && reward.emojis) {
      body.emojis = reward.emojis.slice(0, MAX_EMOJIS);
    }
    // An imageUrl that is not an absolute https:// URL is silently dropped to
    // "no image" rather than failing the alert — decoration must never cost
    // you the notification. Omit it entirely rather than send a bad one.
    if (typeof reward.imageUrl === 'string' && reward.imageUrl.startsWith('https://')) {
      body.imageUrl = reward.imageUrl;
    }

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await client.richAlert(streamer, body);
        return { ok: true };
      } catch (err) {
        if (err instanceof PowerChatApiError && err.status === 403) {
          // `alerts:rich` is a SEPARATE scope from `alerts:trigger`; holding
          // one does not grant the other. Not retryable, and re-authorizing is
          // the only fix, so surface it and stop.
          return { ok: false, terminal: true, reason: 'scope', message: err.message };
        }
        const retryable = !(err instanceof PowerChatApiError) || err.isRetryable;
        if (!retryable)
          return { ok: false, terminal: true, reason: 'rejected', message: err.message };
        if (attempt === 4)
          return { ok: false, terminal: false, reason: 'exhausted', message: err.message };
        // 30/min is the tightest bucket in the API, so back off generously.
        const delay = Math.round(
          Math.min(20_000, 1500 * 2 ** (attempt - 1)) * (0.5 + Math.random()),
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return { ok: false, terminal: false, reason: 'exhausted' };
  }

  /**
   * `alerts/custom` — the one write in this API with no idempotency key.
   *
   * The claim is taken BEFORE the request and is never released. On a timeout
   * we genuinely do not know whether the alert rendered, and for a decorative
   * alert one that is missing is far cheaper than one that fires twice on a
   * live overlay. So: exactly one attempt, ever, per redemption.
   */
  async function fireCustomAlert(redemption, reward) {
    if (customAlertClaims.has(redemption.id)) {
      stats.customSkipped += 1;
      return { ok: false, reason: 'already_claimed' };
    }
    customAlertClaims.add(redemption.id);
    try {
      await client.customAlert(streamer, {
        actorName: clamp(redemption.displayName, MAX_ACTOR_NAME),
        message: clamp(`redeemed ${reward.name}`, MAX_ALERT_MESSAGE),
        // Presentation only. `usd`/`eur`/`gbp` are rejected here precisely so
        // a display alert can never be mistaken for money downstream; `xts` is
        // ISO 4217's reserved "for testing" code. We are showing a POINTS
        // price, so this is the right shape for it.
        amountCents: redemption.cost,
        currency: 'xts',
      });
      return { ok: true };
    } catch (err) {
      // Deliberately no retry. See the comment above the function.
      return { ok: false, reason: 'failed', message: err.message };
    }
  }

  /**
   * The product operation: a viewer spends points on an effect.
   * Every branch that returns early has already left the ledger consistent.
   */
  async function redeem({ viewerId, displayName, rewardKey, note }) {
    const reward = catalog[rewardKey];
    if (!reward) {
      stats.refused += 1;
      return { ok: false, reason: 'unknown_reward' };
    }

    // 1 — conditional debit. Nothing else happens until this succeeds.
    if (!economy.debit(viewerId, reward.cost)) {
      stats.refused += 1;
      return { ok: false, reason: 'insufficient_points', balance: economy.balanceOf(viewerId) };
    }

    // 2 — persist the row, with its id, before any network call.
    const redemption = {
      id: randomUUID(),
      viewerId,
      displayName,
      rewardKey,
      rewardName: reward.name,
      cost: reward.cost,
      note: note ?? null,
      createdAt: now(),
      state: 'pending',
    };
    redemptions.set(redemption.id, redemption);
    stats.redeemed += 1;

    // 3 — the credit that actually counts. A failure here is logged, not
    // fatal: the viewer got their effect either way, and the stable external
    // id means a later reconciliation sweep can replay it safely.
    const spend = await economy.publishSpend(redemption);

    // 4 — decoration.
    const rich = await fireRichAlert(redemption, reward);
    if (!rich.ok) stats.richFailed += 1;

    let custom = null;
    if (shoutWithCustomAlert) custom = await fireCustomAlert(redemption, reward);

    // The overlay-delivered part of the reward. This runs regardless of the
    // alerts: overlay-state.js is our own rail and does not depend on them.
    if (reward.deliveredBy === 'overlay') {
      onEffect({
        redemptionId: redemption.id,
        rewardKey,
        label: reward.title || reward.name,
        accentColor: reward.accentColor,
        by: displayName,
        until: redemption.createdAt + (reward.effectHoldMs ?? 15_000),
      });
    }

    // Refund only when the reward WAS the alert and the alert is definitively
    // gone. An exhausted-retry result is not definitive — it may yet have
    // landed — so we do not refund on that, or a flaky minute would hand out
    // free points for effects that did render.
    if (reward.deliveredBy === 'alert' && !rich.ok && rich.terminal) {
      economy.refund(viewerId, reward.cost);
      redemption.state = 'refunded';
      stats.refunded += 1;
      return { ok: false, reason: `alert_${rich.reason}`, refunded: true, redemption };
    }

    redemption.state = 'delivered';
    return { ok: true, redemption, spend, rich, custom };
  }

  function history() {
    return [...redemptions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  return { catalog, redeem, history, stats };
}

module.exports = { createRedemptions, DEFAULT_CATALOG };
