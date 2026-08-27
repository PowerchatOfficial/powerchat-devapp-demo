'use strict';
/**
 * 09 — The three display-only alert endpoints.
 *
 * Demonstrates
 *   POST /streamers/:u/test-alerts     [alerts:trigger]  fake a platform event
 *   POST /streamers/:u/alerts/custom   [alerts:trigger]  your own copy on screen
 *   POST /streamers/:u/alerts/rich     [alerts:rich]     image + effect + color
 *
 * READ THIS FIRST. All three are DISPLAY-ONLY. They put pixels on the overlay
 * and nothing else:
 *   · no goal progress          · no subathon time
 *   · no leaderboard entry      · no tip totals
 *   · never returned by paid-messages, never on a donation webhook
 *
 * That is enforced server-side, not by convention. Custom and rich alerts are
 * written with effect policy `display_only`; app test fires are forced to the
 * `manual_test` source with the dashboard's `creditGoal` and `platform` knobs
 * stripped, so an app holding alerts:trigger cannot spoof a Twitch tip or
 * nudge a goal bar. If you want something to COUNT, use the real intakes:
 * /subscriptions, /follows, /currency-events, /tips (examples 06–08).
 *
 * Every one of these answers 202 — queued for the overlay, which is a
 * different claim from "the streamer saw it". Alerts still obey the
 * streamer's alert settings, mute state, and moderation.
 *
 * Scopes required: alerts:trigger (+ alerts:rich for the third one)
 * Run: node examples/09-alerts.js
 */
const { randomUUID } = require('node:crypto');
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // ── 1. Test alert — "what does a $5 tip look like on my overlay?" ────────
  // Body is a { kind, payload } union. Apps may fire: tip, subscribe, follow,
  // host, channel_points. The view-count and emote-wall kinds are refused
  // here — writing a viewer count is what viewcount:write is for.
  console.log('\n[test-alerts] rehearsing a tip alert');
  const test = await client.testAlert(streamer, {
    kind: 'tip',
    payload: {
      amountCents: 500,
      currency: 'usd',
      tipperName: 'RehearsalRita',
      message: 'this is a test fire, no money moved',
    },
  });
  console.log('  202', JSON.stringify(test));
  console.log('  the row is flagged isTest — it can never leak into reconciliation.');

  // ── 2. Custom alert — your own words, your own occasion ─────────────────
  // For things PowerChat has no concept of: a raid from your platform, a
  // tournament win, a queue position. `amountCents` and `currency` here are
  // PRESENTATION ONLY — the currency must be a 3-letter code and usd/eur/gbp
  // are rejected outright, precisely so a display alert can never be mistaken
  // for real money by anything reading the event downstream.
  console.log('\n[alerts/custom] a bespoke on-screen moment');
  const custom = await client.customAlert(streamer, {
    actorName: 'HoboStreamer',
    message: 'cleared the dungeon on stream, no deaths',
    amountCents: 2500,
    currency: 'xts', // ISO 4217's reserved "for testing" code — never real money
  });
  console.log('  202', JSON.stringify(custom));
  console.log('  note: no idempotency key on this endpoint — a retry fires TWICE.');
  console.log('  guard your own retries, or use alerts/rich, which has externalId.');

  // ── 3. Rich alert — structured presentation, rendered by PowerChat ───────
  // You supply allow-listed fields; PowerChat renders them with its own
  // trusted overlay components. No third-party markup or script ever runs on
  // a streamer's overlay, which is why this is a separate, narrower scope.
  console.log('\n[alerts/rich] image + effect + accent color');
  const rich = await client.richAlert(streamer, {
    title: 'NEW HIGH SCORE',
    message: 'HoboViewer took the top slot with 41,200',
    // Absolute https only. A malformed or http:// URL is silently dropped to
    // "no image" rather than failing the whole alert — decoration must never
    // cost you the notification.
    imageUrl: 'https://example.com/trophy.png',
    effect: 'confetti', // none | confetti | fireworks | emote-rain
    emojis: ['🏆', '🎉'], // only used by emote-rain; max 12
    accentColor: '#7C3AED', // #RRGGBB or #RRGGBBAA
    durationMs: 6000, // 1000–30000, so nobody can pin an alert forever
    // REQUIRED here. Same contract as everywhere else in this API: retries
    // carrying the same id are deduped instead of firing a second time.
    externalId: randomUUID(),
  });
  console.log('  202', JSON.stringify(rich));

  console.log('\nRate limit: ~30/min across the alert endpoints — the tightest bucket in the');
  console.log('API, because an alert storm is indistinguishable from an attack on the overlay.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.isAuthProblem) {
      console.error(
        'HINT — Expired token, or the scope was never REQUESTED. alerts:rich is separate\n' +
          '  from alerts:trigger: holding one does not grant the other, and a scope\n' +
          '  registered on the app still has to appear in the authorize `scope` param.\n' +
          '  GET /me lists what was actually granted.',
      );
    } else if (err.isRetryable) {
      console.error('HINT — Rate limited (30/min here) or a server blip. Back off and retry.');
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
