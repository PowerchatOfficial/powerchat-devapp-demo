'use strict';
/**
 * economy.js — the Watch Points ledger, and the ONLY module in this scenario
 * that touches the `currency:write` rail.
 *
 * POINTS ARE NOT MONEY, and PowerChat enforces that server-side rather than by
 * convention. `POST /currency-events` carries a currency your app DECLARED in
 * the developer portal. It credits the streamer's points leaderboard and the
 * channel-points goal, and nothing else: no dollar value is ever computed, no
 * tip total moves, no subathon time is added. The money rail is `POST /tips`,
 * it requires a declared `unitsPerUsd` rate, and it is deliberately absent
 * from this scenario — viewers earn Watch Points by sitting still, so a
 * convertible Watch Point would mean this app was minting currency.
 *
 * THE LEDGER IS YOURS. PowerChat is not your bank and this endpoint is not a
 * balance store: there is no "read my currency" call, because the numbers are
 * yours to hold. Balances live here; PowerChat only ever hears a summary of
 * them. That asymmetry is what makes the failure handling below possible — if
 * a publish fails, the viewer's balance is still exactly right and we can
 * simply decline to publish.
 *
 * IDEMPOTENCY, WHICH IS THE ENTIRE REASON FOR THE BATCHING.
 * Accrual is continuous, but publishing happens once per EARN WINDOW (default
 * five minutes). A window's id comes from wall-clock time, so the external id
 * for one publish is
 *
 *     watchpoints:earn:<windowId>:<viewerId>
 *
 * and it is byte-identical on every retry of that window, forever. A blind
 * retry after a timeout is therefore safe — you cannot tell whether the first
 * attempt landed, and with a stable id you do not need to. Mint a fresh id per
 * attempt instead and one timed-out request permanently inflates a leaderboard
 * and a goal bar that belong to somebody else. That is the single most common
 * way an integration corrupts numbers it does not own.
 */
const { PowerChatApiError } = require('../../src/powerchat');

const DEFAULTS = {
  /** Must match a currency you declared in the portal, WITHOUT a unitsPerUsd
   *  rate. A rate would make it tip-eligible, which is the opposite of what a
   *  free watch-time currency should be. */
  currencyKey: 'watch_points',
  idPrefix: 'watchpoints',
  pointsPerMinute: 10,
  windowSeconds: 300,
  /** Never credit more than this much elapsed time in one observation. If the
   *  process was asleep for an hour, the viewer did not watch for an hour —
   *  they were simply unobserved, and paying out for the gap is how a restart
   *  turns into a leaderboard scandal. */
  maxCreditedGapMs: 90_000,
  /** currency-events share a ~60/min write budget with tips, subscriptions and
   *  view-count. One flush may not spend more than this, so a busy channel
   *  degrades into "fewer rows published" instead of a 429 storm. */
  maxPublishPerFlush: 20,
  /** Turn this off above ~50 concurrently-earning viewers. See the README:
   *  earning is a private number, and only SPENDING really deserves a row on
   *  the streamer's board. */
  publishEarnings: true,
  maxAttemptsPerRow: 4,
};

const MAX_REDEEMER_NAME = 48; // POST /currency-events: redeemerName is 1-48
const MAX_REWARD_NAME = 64; //  POST /currency-events: rewardName is <=64
const MAX_AMOUNT = 1_000_000_000; // POST /currency-events: amount is 1..1e9

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with jitter.
 *
 * PowerChat sends `Retry-After` and `RateLimit-Reset` on a 429, and you should
 * prefer them — but `src/powerchat.js` throws a `PowerChatApiError` that does
 * not carry response headers, so this scenario cannot read them without
 * forking the client. Jittered backoff is the honest fallback; the jitter
 * matters because every worker in your fleet gets rate limited at the same
 * instant and would otherwise retry at the same instant too.
 */
function backoffMs(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + Math.random()));
}

function clampName(value, max, fallback) {
  const text = String(value ?? '').trim() || fallback;
  return text.length > max ? text.slice(0, max) : text;
}

function createEconomy(options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { client, streamer } = settings;
  const now = settings.now ?? (() => Date.now());
  const windowMs = settings.windowSeconds * 1000;

  /**
   * viewerId -> { displayName, balance, lifetime, carryMs, lastSeenAt }
   *
   * In production this is a `viewer_balances` table with primary key
   * (app_id, viewer_id), and every debit is a single conditional UPDATE
   * (`SET balance = balance - $cost WHERE viewer_id = $id AND balance >= $cost`)
   * so two workers redeeming at once cannot both win. An in-memory Map is not
   * durable: restart this process and every balance is gone.
   */
  const ledger = new Map();

  /**
   * windowId -> Map(viewerId -> units). The window currently filling up.
   * In production these are increments on the same row as the balance, or a
   * `pending_earnings` table keyed (window_id, viewer_id).
   */
  const openWindows = new Map();

  /**
   * Sealed windows awaiting publish.
   * In production this is an `earn_publications` table with a UNIQUE index on
   * (app_id, window_id, viewer_id) — exactly the tuple the external id is
   * built from — so a crash mid-flush resumes instead of dropping the queue,
   * and two workers cannot claim the same row. Here it is an array, so a
   * restart loses whatever had not been published yet.
   */
  const outbox = [];

  /**
   * Whether the streamer's grant still lets us write currency. A streamer can
   * switch an individual capability off without revoking the whole grant, and
   * that looks exactly like a missing scope: a 403. When it happens we stop
   * publishing and keep accruing. A missing scope must degrade a feature, not
   * crash the app — the viewer's points are still real to us.
   */
  const capability = { currency: true, lastError: null };

  const stats = { published: 0, deduped: 0, dropped: 0, skippedOverBudget: 0 };

  // -------------------------------------------------------------- accrual

  function ensureViewer(viewerId, displayName) {
    let row = ledger.get(viewerId);
    if (!row) {
      row = { displayName, balance: 0, lifetime: 0, carryMs: 0, lastSeenAt: null };
      ledger.set(viewerId, row);
    }
    if (displayName) row.displayName = displayName;
    return row;
  }

  /**
   * Call this on your presence tick with everyone currently watching.
   *
   * Accrual is derived from ELAPSED TIME rather than counted in ticks, because
   * a tick that fires late (GC pause, event-loop stall, a slow flush) would
   * otherwise silently under-pay. The gap is capped so a tick that fires very
   * late does not over-pay either.
   */
  function observe(viewers, atMs = now()) {
    const windowId = Math.floor(atMs / windowMs);
    let earned = 0;
    for (const viewer of viewers) {
      const row = ensureViewer(viewer.viewerId, viewer.displayName);
      const elapsed =
        row.lastSeenAt === null ? 0 : Math.min(atMs - row.lastSeenAt, settings.maxCreditedGapMs);
      row.lastSeenAt = atMs;
      if (elapsed <= 0) continue;

      // Carry the remainder rather than rounding each tick: rounding down
      // every few seconds is how a viewer watches for an hour and earns
      // nothing at all.
      row.carryMs += elapsed;
      const perPoint = 60_000 / settings.pointsPerMinute;
      const points = Math.floor(row.carryMs / perPoint);
      if (points <= 0) continue;
      row.carryMs -= points * perPoint;
      row.balance += points;
      row.lifetime += points;
      earned += points;

      const bucket = openWindows.get(windowId) ?? new Map();
      bucket.set(viewer.viewerId, (bucket.get(viewer.viewerId) ?? 0) + points);
      openWindows.set(windowId, bucket);
    }
    return { windowId, earned };
  }

  /** A viewer who left: stop the clock so they do not earn through the gap. */
  function forget(viewerId) {
    const row = ledger.get(viewerId);
    if (row) row.lastSeenAt = null;
  }

  // ----------------------------------------------------- window lifecycle

  /**
   * Move every window that can no longer receive points into the outbox.
   * Sealing is separate from flushing on purpose: a window must be CLOSED
   * before it is published, or the external id would name a total that later
   * grows, and the second publish would be deduped away as a duplicate of the
   * smaller first one.
   */
  function sealWindows(atMs = now()) {
    const currentWindow = Math.floor(atMs / windowMs);
    let sealed = 0;
    for (const [windowId, bucket] of openWindows) {
      if (windowId >= currentWindow) continue;
      for (const [viewerId, units] of bucket) {
        if (units <= 0) continue;
        outbox.push({
          windowId,
          viewerId,
          units: Math.min(units, MAX_AMOUNT),
          displayName: ledger.get(viewerId)?.displayName ?? viewerId,
          attempts: 0,
        });
        sealed += 1;
      }
      openWindows.delete(windowId);
    }
    return sealed;
  }

  // ------------------------------------------------------------ publishing

  /**
   * One write, with the retry policy this API actually wants.
   *
   *   403  a scope was never requested, or the streamer switched the
   *        capability off. Retrying cannot fix either. Stop publishing.
   *   400  the body is wrong (undeclared currency, name too long). Retrying
   *        an identical body forever is a poison pill — drop the row.
   *   429  back off with jitter and try again; the stable external id makes
   *        that safe even if the first attempt secretly succeeded.
   *   5xx  same, and likewise safe.
   */
  async function send(fn, row) {
    for (;;) {
      row.attempts += 1;
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        if (err instanceof PowerChatApiError && err.status === 403) {
          capability.currency = false;
          capability.lastError = err.message;
          return { ok: false, terminal: true, reason: 'forbidden', error: err };
        }
        const retryable = !(err instanceof PowerChatApiError) || err.isRetryable;
        if (!retryable) {
          return { ok: false, terminal: true, reason: 'rejected', error: err };
        }
        if (row.attempts >= settings.maxAttemptsPerRow) {
          return { ok: false, terminal: false, reason: 'exhausted', error: err };
        }
        await sleep(backoffMs(row.attempts));
      }
    }
  }

  /**
   * Publish sealed windows. Safe to call on a timer and safe to call twice —
   * every row carries an external id that is stable for all time.
   */
  async function flush() {
    if (!settings.publishEarnings) {
      const skipped = outbox.splice(0, outbox.length).length;
      return { published: 0, skipped, disabled: false };
    }
    if (!capability.currency) {
      // Drain rather than grow forever. The balances are unaffected: the
      // streamer just stopped seeing our board.
      const skipped = outbox.splice(0, outbox.length).length;
      stats.dropped += skipped;
      return { published: 0, skipped, disabled: true };
    }

    let published = 0;
    let budget = settings.maxPublishPerFlush;
    const keep = [];

    while (outbox.length) {
      const row = outbox.shift();
      if (budget <= 0) {
        // Over the per-flush budget. We do NOT queue these for later: the
        // balance is already correct locally, and a leaderboard that lags an
        // hour behind is worse than one that quietly skips a window. Failing
        // open here is what keeps us inside the rate limit.
        stats.skippedOverBudget += 1;
        continue;
      }
      budget -= 1;

      const externalId = `${settings.idPrefix}:earn:${row.windowId}:${row.viewerId}`;
      const result = await send(
        () =>
          client.sendCurrencyEvent(streamer, {
            currency: settings.currencyKey,
            amount: row.units,
            redeemerName: clampName(row.displayName, MAX_REDEEMER_NAME, 'Viewer'),
            rewardName: clampName('Watch time', MAX_REWARD_NAME, 'Watch time'),
            externalId,
            // The time the points were EARNED, not the time we got around to
            // publishing them. A backfill that stamps `now` rewrites history.
            occurredAt: new Date(row.windowId * windowMs).toISOString(),
          }),
        row,
      );

      if (result.ok) {
        published += 1;
        stats.published += 1;
        continue;
      }
      if (result.terminal) {
        stats.dropped += 1;
        if (result.reason === 'forbidden') {
          // Put the row back so a later re-grant can pick it up, then stop.
          keep.push(row);
          break;
        }
        continue;
      }
      keep.push(row); // exhausted retries — try again on the next flush
    }

    outbox.unshift(...keep);
    return { published, skipped: outbox.length, disabled: !capability.currency };
  }

  /**
   * Publish a SPEND. This is the event that genuinely belongs on the
   * streamer's points leaderboard: somebody chose to burn a balance on
   * something visible. `redemption.id` is already a persisted, unique row id
   * on our side, so it is the external id — no extra bookkeeping, and a retry
   * of a redemption can never award a second leaderboard entry.
   */
  async function publishSpend(redemption) {
    if (!capability.currency) return { ok: false, reason: 'capability_off' };
    const row = { attempts: 0 };
    const result = await send(
      () =>
        client.sendCurrencyEvent(streamer, {
          currency: settings.currencyKey,
          amount: Math.min(redemption.cost, MAX_AMOUNT),
          redeemerName: clampName(redemption.displayName, MAX_REDEEMER_NAME, 'Viewer'),
          rewardName: clampName(redemption.rewardName, MAX_REWARD_NAME, 'Reward'),
          message: redemption.note ? String(redemption.note).slice(0, 250) : undefined,
          externalId: `${settings.idPrefix}:spend:${redemption.id}`,
          occurredAt: new Date(redemption.createdAt).toISOString(),
        }),
      row,
    );
    if (result.ok) {
      stats.published += 1;
      return { ok: true, eventId: result.value?.eventId ?? null };
    }
    return { ok: false, reason: result.reason, message: result.error?.message ?? null };
  }

  // ----------------------------------------------------------- ledger reads

  function balanceOf(viewerId) {
    return ledger.get(viewerId)?.balance ?? 0;
  }

  /**
   * Conditional debit. Returns false rather than throwing when the balance is
   * short, because "not enough points" is an ordinary product outcome, not an
   * error. In production the whole function is one UPDATE with the balance
   * check in the WHERE clause — that single statement is what makes it atomic
   * under concurrency, not this comparison.
   */
  function debit(viewerId, cost) {
    const row = ledger.get(viewerId);
    if (!row || row.balance < cost) return false;
    row.balance -= cost;
    return true;
  }

  /** Compensating credit for a redemption that could not be delivered. */
  function refund(viewerId, cost) {
    const row = ledger.get(viewerId);
    if (!row) return false;
    row.balance += cost;
    return true;
  }

  function leaderboard(limit = 5) {
    return [...ledger.entries()]
      .map(([viewerId, row]) => ({ viewerId, name: row.displayName, points: row.lifetime }))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  function snapshot() {
    return {
      viewers: ledger.size,
      pendingPublishes: outbox.length,
      currencyEnabled: capability.currency,
      lastError: capability.lastError,
      ...stats,
    };
  }

  return {
    settings,
    observe,
    forget,
    sealWindows,
    flush,
    publishSpend,
    balanceOf,
    debit,
    refund,
    leaderboard,
    snapshot,
  };
}

module.exports = { createEconomy, backoffMs, DEFAULTS };
