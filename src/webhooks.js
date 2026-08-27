'use strict';
/**
 * Inbound webhook verification + dispatch.
 *
 * PowerChat signs every delivery. Verify EVERY one before you act on it —
 * an unverified receiver is an open endpoint anyone can post fake donations to.
 *
 * Headers on each delivery:
 *   X-PowerChat-Signature         sha256=<hex HMAC over "<timestamp>.<raw body>">
 *   X-PowerChat-Timestamp         unix time in MILLISECONDS (`String(Date.now())`
 *                                 on the sender); reject if outside the replay window
 *   X-PowerChat-Delivery-Id       stable across retries → your dedupe key
 *   X-PowerChat-Event-Type        e.g. donation.completed
 *   X-PowerChat-Delivery-Attempt  1, 2, 3 … on retry
 *   X-PowerChat-Webhook-Version   envelope version
 *
 * Three rules that matter more than the code:
 *   1. Sign over the RAW BYTES. Re-serializing the parsed JSON changes them
 *      and the signature will never match.
 *   2. Deliveries are AT-LEAST-ONCE. Dedupe on the delivery id, which is
 *      stable across retries of the same delivery.
 *   3. Respond 2xx fast and process asynchronously. A slow receiver gets
 *      retried; ~20 consecutive failures trips a circuit breaker and a 410
 *      disables your endpoint.
 *
 * A note on the timestamp unit, because it is the bug everyone writes once:
 * the header is milliseconds, and the HMAC covers the header's exact text.
 * Compare the replay window in milliseconds and feed the header string — not
 * a re-formatted number — into the HMAC. An earlier version of this file
 * compared `Date.now() / 1000` to the millisecond header and rejected every
 * genuine delivery as "outside the allowed window".
 */
const crypto = require('node:crypto');

/**
 * Replay window, in milliseconds. PowerChat documents 15 minutes; a captured
 * delivery is useless to an attacker after that even without dedupe.
 */
const DEFAULT_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * Anything below this is not a millisecond timestamp from this century —
 * 1e11 ms is March 1973, while unix SECONDS will not reach 1e11 until the
 * year 5138. Used only to tolerate a seconds-valued header from a proxy or a
 * hand-written test; PowerChat itself always sends milliseconds.
 */
const SECONDS_MAGNITUDE_CEILING = 1e11;

/**
 * Compute the signature PowerChat puts in `X-PowerChat-Signature` for a given
 * timestamp header value and raw body. This is byte-for-byte what the sender
 * does — use it to sign test deliveries against your own receiver.
 *
 * @param {string} secret     your `pcw_…` signing secret
 * @param {string} timestamp  the EXACT header text, e.g. `String(Date.now())`
 * @param {Buffer|string} rawBody
 */
function signWebhook(secret, timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return (
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
      .digest('hex')
  );
}

/**
 * @param {Buffer|string} rawBody EXACTLY the bytes received.
 * @param {object} headers Node's lower-cased `req.headers` (any case works).
 * @param {string} secret Your signing secret.
 * @param {object} [options]
 * @param {number} [options.toleranceMs] Replay window in milliseconds.
 * @param {() => number} [options.now] Clock override for tests (ms).
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
function verifyWebhook(
  rawBody,
  headers,
  secret,
  { toleranceMs = DEFAULT_TOLERANCE_MS, now = Date.now } = {},
) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };

  const get = (name) => headers[name] ?? headers[name.toLowerCase()] ?? '';
  const signature = String(get('x-powerchat-signature'));
  const timestamp = String(get('x-powerchat-timestamp'));
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature/timestamp header' };

  // Replay window first — cheap, and it bounds how long a captured delivery
  // stays useful to an attacker. The header is milliseconds; a value small
  // enough to be seconds is scaled up so a hand-rolled sender still verifies.
  const parsed = Number(timestamp);
  if (!Number.isFinite(parsed) || parsed <= 0) return { ok: false, reason: 'malformed timestamp' };
  const timestampMs = parsed < SECONDS_MAGNITUDE_CEILING ? parsed * 1000 : parsed;
  if (Math.abs(now() - timestampMs) > toleranceMs) {
    return { ok: false, reason: 'timestamp outside the allowed window' };
  }

  // The HMAC covers the header TEXT as sent (plus a dot, plus the raw body),
  // never our parsed/scaled number — otherwise a legitimate delivery whose
  // timestamp we normalised would fail to verify.
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected = signWebhook(secret, timestamp, body);

  // Timing-safe compare over the raw signature bytes; length check first
  // because timingSafeEqual throws on a length mismatch.
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  try {
    return { ok: true, event: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false, reason: 'body is not valid JSON' };
  }
}

/**
 * Tiny at-least-once dedupe. In production use your database (a unique index
 * on the delivery id), not an in-memory set — this resets on restart.
 */
function createDeliveryDeduper({ max = 5000 } = {}) {
  const seen = new Set();
  return {
    /** @returns true the FIRST time a delivery id is seen. */
    accept(deliveryId) {
      if (!deliveryId) return true; // nothing to dedupe on — process it
      if (seen.has(deliveryId)) return false;
      seen.add(deliveryId);
      if (seen.size > max) seen.delete(seen.values().next().value);
      return true;
    },
  };
}

/**
 * Route a verified event to a handler map, e.g.
 *   { 'donation.completed': (e) => …, '*': (e) => … }
 *
 * `donation.completed` carries `appExternalRef` — the `ref` you passed to
 * `tipCheckoutLink()` when PowerChat minted the checkout intent — so you can
 * credit the right user on your side. Only a SERVER-MINTED intent produces an
 * authoritative `appExternalRef`: a link you assembled by hand with `app_ref`
 * in the query string travels through the viewer's browser, so its ref is
 * viewer-editable and PowerChat surfaces it as untrusted, not as
 * `appExternalRef`. The webhook is the ONLY authoritative confirmation:
 * verify `amountCents` and `data.isTest` before treating a tip as fulfilling
 * anything. A tip WITH a message also fires `paid_message.created` with
 * identical data and a different delivery id — credit money on
 * `donation.completed` only, or you will double-count.
 */
function dispatchEvent(event, handlers) {
  const type = event?.type ?? event?.eventType ?? 'unknown';
  const handler = handlers[type] ?? handlers['*'];
  if (!handler) return { handled: false, type };
  handler(event);
  return { handled: true, type };
}

module.exports = {
  verifyWebhook,
  signWebhook,
  createDeliveryDeduper,
  dispatchEvent,
  DEFAULT_TOLERANCE_MS,
};
