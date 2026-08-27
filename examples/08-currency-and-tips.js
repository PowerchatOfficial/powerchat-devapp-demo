'use strict';
/**
 * 08 — Virtual currency vs. tips: the two intakes developers mix up.
 *
 * Demonstrates
 *   POST /streamers/:u/currency-events   [currency:write]  points, NEVER money
 *   POST /streamers/:u/tips              [tips:write]      money, via a declared rate
 *
 * The difference is not cosmetic. It decides what gets credited:
 *
 *   currency-events  → alert + points LEADERBOARD + channel-points goal.
 *                      Lands as a `channel_points` event. No dollar value is
 *                      ever computed, no tip total moves, no subathon time is
 *                      added. This is the intake for "500 Hobo Points spent on
 *                      a reward" — an economy you invented and give away free.
 *
 *   tips             → alert + tip GOALS + SUBATHON time + tip totals.
 *                      Lands as a real `usd` tip whose value PowerChat mints
 *                      server-side from YOUR declared rate. Deliberately NOT
 *                      on the leaderboard (the tip board excludes app-sourced
 *                      rows), so a self-reported tip can never outrank money
 *                      that actually moved through checkout.
 *
 * Both currencies must be DECLARED on your app first (Developer portal → your
 * app → Currencies, max 5). A currency only becomes tip-eligible once you give
 * it a `unitsPerUsd` rate — 100 units = $1 is exactly the bits model. The last
 * step of this script shows the 400 you get when you forget.
 *
 * Scopes required: currency:write, tips:write
 * Run:
 *   POWERCHAT_POINTS_CURRENCY=hobo_points POWERCHAT_TIP_CURRENCY=hobo_bucks \
 *     node examples/08-currency-and-tips.js
 */
const { randomUUID } = require('node:crypto');
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

// Your declared currency keys — whatever you named them in the portal.
const POINTS_CURRENCY = process.env.POWERCHAT_POINTS_CURRENCY || 'hobo_points';
const TIP_CURRENCY = process.env.POWERCHAT_TIP_CURRENCY || 'hobo_bucks';

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // ── 1. A virtual-currency redemption ────────────────────────────────────
  // `amount` is in YOUR units and stays in your units forever. PowerChat
  // stores the event with `currency: '<your key>'` — it never guesses a rate
  // and never converts, because points are not money.
  console.log(`\n[currency-events] 1500 ${POINTS_CURRENCY} → points board + channel-points goal`);
  const redeem = await client.sendCurrencyEvent(streamer, {
    currency: POINTS_CURRENCY,
    amount: 1500,
    redeemerName: 'HoboViewer',
    rewardName: 'Hydrate!',
    message: 'drink some water',
    // REQUIRED idempotency key. In your app this is your own redemption row
    // id, persisted BEFORE you send — replaying it after a timeout dedupes
    // instead of firing a second alert.
    externalId: randomUUID(),
  });
  console.log('  eventId:', redeem.eventId);
  console.log('  credited: leaderboard + channelpoints-goal. NOT tip totals, NOT subathon.');

  // ── 2. A monetary tip in a rated currency ───────────────────────────────
  // Note what you do NOT send: a dollar amount. You send units; the server
  // multiplies by the rate it holds. An app cannot inflate its own tips by
  // claiming a bigger USD figure, which is the whole point of the design.
  console.log(`\n[tips] 500 ${TIP_CURRENCY} → converted server-side from unitsPerUsd`);
  const tip = await client.sendTip(streamer, {
    currency: TIP_CURRENCY,
    amount: 500,
    tipperName: 'HoboViewer',
    message: 'thanks for the stream',
    externalId: randomUUID(),
  });
  console.log('  eventId:', tip.eventId);
  console.log(`  usdCents: ${tip.usdCents} (=$${(tip.usdCents / 100).toFixed(2)})`);
  console.log('  credited: tip goals + subathon time + tip totals. NOT the leaderboard.');
  console.log('  the overlay shows the native units ("500 Hobo Bucks"), like bits or kicks.');

  // ── 3. The mistake this endpoint exists to catch ────────────────────────
  // Sending a points currency to /tips is the single most common 400 here.
  // Conversion is refused BEFORE any event row is written, so a rejection
  // leaves nothing behind to clean up.
  console.log(`\n[tips] deliberately sending an unrated currency (${POINTS_CURRENCY})…`);
  try {
    await client.sendTip(streamer, {
      currency: POINTS_CURRENCY,
      amount: 500,
      tipperName: 'HoboViewer',
      externalId: randomUUID(),
    });
    console.log(
      `  no error — ${POINTS_CURRENCY} apparently HAS a unitsPerUsd rate, so it is ` +
        'tip-eligible too. Give free points a currency with no rate to keep the two apart.',
    );
  } catch (err) {
    if (err instanceof PowerChatApiError && err.status === 400) {
      console.log('  expected 400:', err.message);
      console.log('  fix: set unitsPerUsd on the declaration, or send it to currency-events.');
    } else {
      throw err;
    }
  }

  console.log('\nRate limits: ~60/min for currency-events and tips. Batch, do not spin.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.isAuthProblem) {
      console.error(
        'HINT — The token is expired, or currency:write / tips:write was never REQUESTED.\n' +
          '  Registering a scope on the app is not enough: it must be in the authorize\n' +
          '  `scope` parameter too. Check GET /me for what was actually granted.',
      );
    } else if (err.isRetryable) {
      console.error('HINT — Rate limited or a server-side blip. Retry with backoff.');
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
