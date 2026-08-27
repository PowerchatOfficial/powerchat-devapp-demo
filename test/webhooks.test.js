'use strict';
/**
 * Round-trip tests for the webhook verifier — signed exactly the way the
 * PowerChat backend signs (timestamp header = `String(Date.now())`, in
 * MILLISECONDS; signature = sha256 HMAC over `<timestamp>.<raw body>`).
 *
 * Run:  node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyWebhook, signWebhook, DEFAULT_TOLERANCE_MS } = require('../src/webhooks');

const SECRET = 'pcw_test_secret_do_not_use';

/** Mirror of the backend's `signAppWebhookBody` — deliberately NOT the demo's helper. */
function backendSign(secret, timestamp, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** A delivery built the way `app-webhook-dispatch.service.ts` builds one. */
function buildDelivery({ secret = SECRET, timestamp = String(Date.now()), event } = {}) {
  const body = JSON.stringify(
    event ?? {
      id: 'wh_123',
      type: 'donation.completed',
      data: { amountCents: 500, isTest: false, appExternalRef: 'user_8f3c21' },
    },
  );
  return {
    body: Buffer.from(body, 'utf8'),
    headers: {
      'x-powerchat-signature': backendSign(secret, timestamp, body),
      'x-powerchat-timestamp': timestamp,
      'x-powerchat-delivery-id': 'wh_123',
    },
  };
}

test('round trip: a delivery signed with String(Date.now()) verifies', () => {
  const { body, headers } = buildDelivery();
  const result = verifyWebhook(body, headers, SECRET);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.event.type, 'donation.completed');
  assert.equal(result.event.data.appExternalRef, 'user_8f3c21');
});

test('the demo signing helper matches the backend byte for byte', () => {
  const timestamp = String(Date.now());
  const body = '{"a":1,"b":"two"}';
  assert.equal(signWebhook(SECRET, timestamp, body), backendSign(SECRET, timestamp, body));
});

test('a stale timestamp (older than the window) is rejected', () => {
  const stale = String(Date.now() - DEFAULT_TOLERANCE_MS - 1000);
  const { body, headers } = buildDelivery({ timestamp: stale });
  const result = verifyWebhook(body, headers, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp outside the allowed window');
});

test('a timestamp too far in the future is rejected', () => {
  const future = String(Date.now() + DEFAULT_TOLERANCE_MS + 1000);
  const { body, headers } = buildDelivery({ timestamp: future });
  assert.equal(verifyWebhook(body, headers, SECRET).ok, false);
});

test('a timestamp inside the window is accepted (window is measured in ms)', () => {
  const recent = String(Date.now() - DEFAULT_TOLERANCE_MS + 5000);
  const { body, headers } = buildDelivery({ timestamp: recent });
  assert.equal(verifyWebhook(body, headers, SECRET).ok, true);
});

test('a tampered body is rejected', () => {
  const { body, headers } = buildDelivery();
  const tampered = Buffer.from(
    body.toString('utf8').replace('"amountCents":500', '"amountCents":50000'),
  );
  const result = verifyWebhook(tampered, headers, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature mismatch');
});

test('a wrong secret is rejected', () => {
  const { body, headers } = buildDelivery();
  const result = verifyWebhook(body, headers, 'pcw_some_other_secret');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'signature mismatch');
});

test('a re-serialized body is rejected (sign over the raw bytes)', () => {
  const { body, headers } = buildDelivery();
  const reserialized = JSON.stringify(JSON.parse(body.toString('utf8')), null, 2);
  assert.equal(verifyWebhook(reserialized, headers, SECRET).ok, false);
});

test('a seconds-valued timestamp still verifies when signed over the same text', () => {
  // Not what PowerChat sends — but a hand-rolled sender that used seconds
  // should not be told its signature is wrong when only the unit differs.
  const seconds = String(Math.floor(Date.now() / 1000));
  const { body, headers } = buildDelivery({ timestamp: seconds });
  assert.equal(verifyWebhook(body, headers, SECRET).ok, true);
});

test('missing headers, malformed timestamps, and a missing secret are rejected', () => {
  const { body, headers } = buildDelivery();
  assert.equal(verifyWebhook(body, {}, SECRET).reason, 'missing signature/timestamp header');
  assert.equal(
    verifyWebhook(body, { ...headers, 'x-powerchat-timestamp': 'yesterday' }, SECRET).reason,
    'malformed timestamp',
  );
  assert.equal(verifyWebhook(body, headers, '').reason, 'no signing secret configured');
});

test('the clock can be injected, so the window is testable without sleeping', () => {
  const at = 1_800_000_000_000; // some fixed instant, in ms
  const { body, headers } = buildDelivery({ timestamp: String(at) });
  const inside = verifyWebhook(body, headers, SECRET, { now: () => at + DEFAULT_TOLERANCE_MS - 1 });
  const outside = verifyWebhook(body, headers, SECRET, {
    now: () => at + DEFAULT_TOLERANCE_MS + 1,
  });
  assert.equal(inside.ok, true);
  assert.equal(outside.ok, false);
});
