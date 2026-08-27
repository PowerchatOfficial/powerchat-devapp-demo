'use strict';
/**
 * overlay-state.js — how the creator's browser source learns what your backend
 * knows, without you running a realtime channel of your own.
 *
 * THE PROBLEM. The streamer added your overlay to OBS as a browser source. It
 * is a static page on a machine you do not control. It has no database, no
 * session, and — critically — no safe place to hold an access token, because
 * anything the page can read the streamer can read, and often screen-shares.
 * Meanwhile your backend is the only thing that knows the points board and
 * which effect is currently running.
 *
 * THE BRIDGE. `POST /overlay-session` stores one small JSON blob, scoped to
 * (this streamer, this app). `GET /overlay-session` reads it back. Two
 * clients, one app, one blob. Your backend writes; your overlay reads.
 *
 * WHAT IT IS NOT: storage. It is a Redis key with a TTL and every constraint
 * follows from that.
 *   · <= 8KB serialized. A state pointer, not a CDN.
 *   · ttlSeconds 1-3600, default 300. It EXPIRES. A GET after expiry returns
 *     null, not an error, so `null` must always render your idle state.
 *   · ONE SLOT per app per streamer, and a POST REPLACES the whole blob — it
 *     does not merge. Exactly one process may own this write. Two writers will
 *     silently overwrite each other and the overlay will flicker between two
 *     versions of the truth.
 *
 * THE TTL IS A FEATURE, NOT AN INCONVENIENCE. If your backend dies mid-stream,
 * the overlay stops seeing stale state within a minute or two instead of
 * showing a frozen scoreboard for the rest of the night. That is only true if
 * you treat the write as a HEARTBEAT and refresh it well before it expires —
 * which is what `start()` below does, at a third of the TTL, so two missed
 * beats still leave a margin.
 */
const { PowerChatApiError } = require('../../src/powerchat');

const MAX_BLOB_BYTES = 8192;
const MIN_TTL_SECONDS = 1;
const MAX_TTL_SECONDS = 3600;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function createOverlayState(options = {}) {
  const { client, streamer, economy } = options;
  const now = options.now ?? (() => Date.now());
  const ttlSeconds = Math.min(
    MAX_TTL_SECONDS,
    Math.max(MIN_TTL_SECONDS, options.ttlSeconds ?? 120),
  );
  const boardSize = options.boardSize ?? 5;

  /**
   * The effect currently painting the overlay, or null.
   * In production this is a row in your own `overlay_effects` table with an
   * `expires_at` column — not because PowerChat needs it, but because your
   * backend has to survive a restart and know what the overlay is showing.
   */
  let activeEffect = null;

  const capability = { overlay: true, lastError: null };
  const stats = { writes: 0, trimmed: 0, failures: 0 };
  let timer = null;
  let lastExpiresInSeconds = null;

  /** Called by redemptions.js when an overlay-delivered reward is bought. */
  function setEffect(effect) {
    activeEffect = effect;
  }

  function currentEffect(atMs = now()) {
    if (activeEffect && activeEffect.until <= atMs) activeEffect = null;
    return activeEffect;
  }

  /**
   * The view model — everything the overlay needs to draw ONE frame, and
   * nothing else. Ship a rendered view, not your database rows: the overlay
   * should never have to compute anything, and 8KB disappears fast if you
   * start sending raw records.
   *
   * `schema` earns its byte. The overlay is a cached page on someone else's
   * machine and can be an old build for weeks; a version tag is how the new
   * backend keeps the old overlay from rendering garbage.
   */
  function viewModel(atMs = now()) {
    const effect = currentEffect(atMs);
    return {
      schema: 1,
      currency: 'Watch Points',
      effect: effect
        ? {
            label: effect.label,
            accentColor: effect.accentColor,
            by: effect.by,
            // Absolute, so the overlay can expire the effect itself between
            // our writes. Without it a takeover would visibly outlive its
            // purchase whenever a heartbeat is late.
            untilIso: new Date(effect.until).toISOString(),
          }
        : null,
      board: economy.leaderboard(boardSize).map((row) => ({ name: row.name, points: row.points })),
      updatedAt: new Date(atMs).toISOString(),
    };
  }

  /**
   * Fit the view model into 8KB by shedding the least important thing first.
   *
   * Check the size YOURSELF. The server answers an oversized blob with a 400,
   * and discovering that from a live overlay at 2am — because one viewer set a
   * very long display name — is a bad way to find out. Degrading the board is
   * always better than failing the write, because failing the write also loses
   * the ACTIVE EFFECT, which is the part the viewer actually paid for.
   */
  function fit(model) {
    const clone = { ...model, board: [...model.board] };
    while (byteLength(clone) > MAX_BLOB_BYTES && clone.board.length > 0) {
      clone.board.pop();
      clone.truncated = true;
      stats.trimmed += 1;
    }
    if (byteLength(clone) > MAX_BLOB_BYTES) {
      // Nothing left to shed. This means the fixed part of the view model is
      // too big, which is a bug in the model rather than a runtime condition.
      throw new Error('Overlay view model exceeds 8KB with an empty board — shrink the model.');
    }
    return clone;
  }

  /**
   * One write. Also our liveness signal, so it runs on a timer even when
   * nothing changed.
   */
  async function publish(atMs = now()) {
    if (!capability.overlay) return { ok: false, reason: 'capability_off' };
    const model = fit(viewModel(atMs));
    try {
      const result = await client.putOverlaySession(streamer, model, ttlSeconds);
      stats.writes += 1;
      // Read the TTL the server actually used rather than assuming ours
      // survived — it clamps instead of rejecting, so a request for 7200 comes
      // back as 3600 and a heartbeat sized for 7200 would let the blob expire.
      lastExpiresInSeconds = result?.expiresInSeconds ?? ttlSeconds;
      return { ok: true, bytes: byteLength(model), expiresInSeconds: lastExpiresInSeconds };
    } catch (err) {
      stats.failures += 1;
      if (err instanceof PowerChatApiError && err.status === 403) {
        // `overlay:write` covers both directions. A 403 means it was never
        // requested in the authorize call, or the streamer switched the
        // capability off. Stop writing; keep serving the app.
        capability.overlay = false;
        capability.lastError = err.message;
        return { ok: false, reason: 'scope', message: err.message };
      }
      if (err instanceof PowerChatApiError && err.status === 400) {
        // Almost always an oversized blob or a ttlSeconds outside 1-3600.
        return { ok: false, reason: 'rejected', message: err.message };
      }
      // 429/5xx: do nothing clever. The next heartbeat is the retry, and it
      // will carry FRESHER state than a replay of this one would have.
      return { ok: false, reason: 'transient', message: err.message };
    }
  }

  /**
   * What the overlay page itself does. Kept here so the two halves of the
   * contract sit next to each other in one file.
   */
  async function readBack() {
    const session = await client.getOverlaySession(streamer);
    if (!session) {
      // Expired, never written, or written by a different app: all three look
      // identical and all three mean "render the idle overlay". Never treat
      // this as an error, or every overlay reload during a quiet minute
      // becomes a crash.
      return { present: false, model: null, ageMs: null };
    }
    const ageMs = Date.now() - Date.parse(session.updatedAt);
    return { present: true, model: session.data, updatedAt: session.updatedAt, ageMs };
  }

  /**
   * Heartbeat at a third of the TTL. Two consecutive failures then still leave
   * the blob alive, so a single blip does not blank the streamer's overlay.
   */
  function start(onResult) {
    if (timer) return;
    const periodMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
    timer = setInterval(() => {
      publish().then(
        (result) => onResult?.(result),
        (err) => onResult?.({ ok: false, reason: 'threw', message: err.message }),
      );
    }, periodMs);
    timer.unref?.();
    return periodMs;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function snapshot() {
    return { ttlSeconds, lastExpiresInSeconds, overlayEnabled: capability.overlay, ...stats };
  }

  return { setEffect, currentEffect, viewModel, fit, publish, readBack, start, stop, snapshot };
}

module.exports = { createOverlayState, MAX_BLOB_BYTES };
