'use strict';
/**
 * Inbound webhook verification + dispatch.
 *
 * PowerChat signs every delivery. Verify EVERY one before you act on it —
 * an unverified receiver is an open endpoint anyone can post fake donations to.
 *
 * Headers on each delivery:
 *   X-PowerChat-Signature         sha256=<hex HMAC over "<timestamp>.<raw body>">
 *   X-PowerChat-Timestamp         unix seconds; reject if older than 15 minutes
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
 */
const crypto = require('node:crypto');

const DEFAULT_TOLERANCE_SECONDS = 15 * 60;

/**
 * @param {Buffer|string} rawBody EXACTLY the bytes received.
 * @returns {{ ok: true, event: object } | { ok: false, reason: string }}
 */
function verifyWebhook(
  rawBody,
  headers,
  secret,
  { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS } = {},
) {
  if (!secret) return { ok: false, reason: 'no signing secret configured' };

  const get = (name) => headers[name] ?? headers[name.toLowerCase()] ?? '';
  const signature = String(get('x-powerchat-signature'));
  const timestamp = String(get('x-powerchat-timestamp'));
  if (!signature || !timestamp) return { ok: false, reason: 'missing signature/timestamp header' };

  // Replay window first — cheap, and it bounds how long a captured delivery
  // stays useful to an attacker.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed timestamp' };
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside the allowed window' };
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const expected =
    'sha256=' +
    crypto
      .createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
      .digest('hex');

  // Timing-safe compare; length check first because timingSafeEqual throws on
  // a length mismatch.
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
 * `donation.completed` carries `appExternalRef` — the `ref` you minted on the
 * checkout link — so you can credit the right user on your side. It is the
 * ONLY authoritative confirmation: verify `amountCents` and `data.isTest`
 * before treating a tip as fulfilling anything. A tip WITH a message also
 * fires `paid_message.created` with identical data and a different delivery
 * id — credit money on `donation.completed` only, or you will double-count.
 */
function dispatchEvent(event, handlers) {
  const type = event?.type ?? event?.eventType ?? 'unknown';
  const handler = handlers[type] ?? handlers['*'];
  if (!handler) return { handled: false, type };
  handler(event);
  return { handled: true, type };
}

module.exports = { verifyWebhook, createDeliveryDeduper, dispatchEvent, DEFAULT_TOLERANCE_SECONDS };
