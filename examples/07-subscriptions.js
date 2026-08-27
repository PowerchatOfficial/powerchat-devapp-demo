'use strict';
/**
 * 07 — Subscriptions.  POST /api/dev/v1/streamers/:username/subscriptions
 *
 * Demonstrates the three shapes every membership platform needs to report, and
 * how the flags change what the overlay says:
 *   1. a NEW subscriber          — the plain case
 *   2. a RESUB                   — isResub: true, so the alert reads "resubbed"
 *   3. a GIFT of several subs    — isGift + giftCount, ONE event not N events
 *
 * Subs fire a sub alert and credit sub goals and subathon time.
 *
 * Scope required: subscriptions:write
 *
 * Run:  node examples/07-subscriptions.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // As in the follows example, `externalId` is the REQUIRED idempotency key and
  // must be stable per logical event. For subscriptions the useful id is the
  // SUBSCRIPTION TERM, not the person: one id per month a viewer is subscribed.
  // Keying on the user id alone would silently swallow every renewal after the
  // first, and the streamer would watch their resub alerts stop appearing.
  const term = new Date().toISOString().slice(0, 7); // e.g. 2026-08

  // 1 -------------------------------------------------------------- new sub
  const newSub = {
    subscriberName: 'DemoSubscriber', // 1-48 chars
    externalId: `demo-sub-2001-${term}`, // 1-128, REQUIRED, one per term
    tier: 'Tier 1', // free text, <= 32 chars — your tier names
    isGift: false,
    isResub: false,
    occurredAt: new Date().toISOString(),
  };
  console.log(`\n1) New subscriber: ${newSub.subscriberName} (${newSub.tier})`);
  console.log(`   ${JSON.stringify(await client.sendSubscription(streamer, newSub))}`);

  // 2 ----------------------------------------------------------------- resub
  //
  // Same person, later term, isResub: true. The flag is display-only — it does
  // not change goal or subathon credit — but getting it wrong is what makes a
  // loyal viewer's twelfth month announced as if they had just arrived.
  const resub = {
    subscriberName: 'DemoSubscriber',
    externalId: `demo-sub-2001-${term}-resub`,
    tier: 'Tier 1',
    isResub: true,
    occurredAt: new Date().toISOString(),
  };
  console.log(`\n2) Resub: ${resub.subscriberName}`);
  console.log(`   ${JSON.stringify(await client.sendSubscription(streamer, resub))}`);

  // 3 -------------------------------------------------------------- gift subs
  //
  // ONE event with giftCount: 5 — not five events. `subscriberName` is the
  // GIFTER (the name the alert celebrates); the recipients are not named here.
  // Sending five separate events instead would fire five alerts and, worse,
  // credit the sub goal five times for what your platform counts as one action.
  // giftCount is 1-1000; a bomb larger than that must be split deliberately.
  const giftSub = {
    subscriberName: 'GenerousDemoViewer',
    externalId: `demo-giftbomb-${Date.now()}`,
    isGift: true,
    giftCount: 5,
    tier: 'Tier 1',
    occurredAt: new Date().toISOString(),
  };
  console.log(`\n3) Gift bomb: ${giftSub.subscriberName} gifted ${giftSub.giftCount}`);
  console.log(`   ${JSON.stringify(await client.sendSubscription(streamer, giftSub))}`);

  // Idempotency again, because it is the one that bites at 3am: re-sending the
  // gift bomb with the same externalId does NOT gift another five.
  console.log('\nRe-sending the gift bomb with the same externalId (a retry)...');
  await client.sendSubscription(streamer, giftSub);
  console.log('Accepted and deduped — still 5 subs credited, not 10.');

  console.log(
    '\nA subscription is a MEMBERSHIP, not a payment. Nothing here touches tip totals or\n' +
      'tip goals — if real money changed hands and you want it counted as such, that is\n' +
      'POST /tips instead. Do not report the same event through both.',
  );
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `subscriptions:write`. Registering a scope on your\n' +
          'app does not request it; it must be in the authorize `scope` param. See 01-whoami.js.',
      );
    } else if (err.status === 422 || err.status === 400) {
      console.error(
        'HINT — body validation. `externalId` is REQUIRED (1-128), `subscriberName` is 1-48,\n' +
          '`tier` is at most 32 chars, and `giftCount` must be 1-1000 when `isGift` is set.',
      );
    } else if (err.status === 429) {
      console.error(
        'HINT 429 — subscriptions share the ~60 requests/minute write budget with tips,\n' +
          'currency events and view-count. Pace bulk imports.',
      );
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
