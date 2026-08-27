'use strict';
/**
 * run.js — six simulated minutes of the whole loop, in a few real seconds.
 *
 * Watch for the order things happen in, because that ordering IS the
 * integration:
 *
 *   observe ... observe          points accrue locally, nothing is sent
 *   sealWindows                  a window closes and becomes publishable
 *   flush                        one currency-event per viewer per window,
 *                                each with an external id that never changes
 *   redeem                       debit -> persist -> currency-event -> alerts
 *   publish                      the overlay blob, refreshed as a heartbeat
 *   readBack                     what the browser source actually sees
 *
 * Time is virtual. The clock is a variable we advance, so a five-minute earn
 * window closes immediately instead of five minutes from now. Do this in your
 * own tests too — an integration whose correctness depends on wall-clock time
 * is an integration you cannot test.
 *
 * Scopes required: currency:write, alerts:rich, overlay:write
 *                  (+ alerts:trigger if you set SHOUT=1)
 *
 * Run against the real API:
 *   POWERCHAT_ACCESS_TOKEN=... POWERCHAT_STREAMER=... \
 *     POWERCHAT_POINTS_CURRENCY=watch_points node scenarios/interactive-overlay/run.js
 *
 * Run with no account at all — every call is printed instead of sent:
 *   node scenarios/interactive-overlay/run.js --dry-run
 */
const { config, requireConfig } = require('../../src/config');
const { PowerChatClient, PowerChatApiError } = require('../../src/powerchat');
const { createEconomy } = require('./economy');
const { createRedemptions } = require('./redemptions');
const { createOverlayState } = require('./overlay-state');

const DRY_RUN = process.argv.includes('--dry-run') || process.env.POWERCHAT_DRY_RUN === '1';
const CURRENCY = process.env.POWERCHAT_POINTS_CURRENCY || 'watch_points';
const SHOUT = process.env.SHOUT === '1';

const VIEWERS = [
  { viewerId: 'u_1001', displayName: 'HoboViewer' },
  { viewerId: 'u_1002', displayName: 'RehearsalRita' },
  { viewerId: 'u_1003', displayName: 'LurkerLen' },
];

/**
 * A stand-in for PowerChatClient that logs instead of calling. It exists so
 * this file is readable and runnable with no credentials — and so the shape of
 * every request is visible in the output next to the code that built it.
 * It implements only the four methods this scenario uses.
 */
function createDryRunClient() {
  let stored = null;
  const log = (label, body) => console.log(`  [dry-run] ${label} ${JSON.stringify(body)}`);
  return {
    async sendCurrencyEvent(_streamer, event) {
      log('POST /currency-events', event);
      return { eventId: `dry_${event.externalId}` };
    },
    async richAlert(_streamer, alert) {
      log('POST /alerts/rich', alert);
      return { accepted: true };
    },
    async customAlert(_streamer, alert) {
      log('POST /alerts/custom', alert);
      return { accepted: true };
    },
    async putOverlaySession(_streamer, data, ttlSeconds) {
      stored = { data, updatedAt: new Date().toISOString() };
      console.log(
        `  [dry-run] POST /overlay-session ${Buffer.byteLength(JSON.stringify(data))}B ttl=${ttlSeconds}s`,
      );
      return { expiresInSeconds: ttlSeconds };
    },
    async getOverlaySession() {
      return stored;
    },
  };
}

async function main() {
  let client;
  if (DRY_RUN) {
    console.log('DRY RUN — nothing is sent. Drop --dry-run to hit the real API.\n');
    client = createDryRunClient();
  } else {
    requireConfig('accessToken', 'streamer');
    client = new PowerChatClient({ baseUrl: config.baseUrl, accessToken: config.accessToken });
  }
  const streamer = config.streamer || 'dry-run-streamer';

  // The virtual clock. Everything below reads the time through `now`.
  let clock = Date.UTC(2026, 0, 1, 20, 0, 0);
  const now = () => clock;

  const economy = createEconomy({
    client,
    streamer,
    now,
    currencyKey: CURRENCY,
    // The product ships 10 points/minute (see the README). The simulation runs
    // hot purely so six simulated minutes can actually buy a 2000-point
    // takeover, instead of needing three and a half hours of virtual clock to
    // reach the interesting part.
    pointsPerMinute: 400,
    windowSeconds: 120, // short, so the demo closes three windows in six minutes
  });

  const overlay = createOverlayState({ client, streamer, economy, now, ttlSeconds: 120 });

  const redemptions = createRedemptions({
    client,
    streamer,
    economy,
    now,
    shoutWithCustomAlert: SHOUT,
    // The join: an overlay-delivered reward hands its effect straight to the
    // overlay blob. redemptions.js never imports overlay-state.js — it just
    // reports the effect and lets the caller wire the two together.
    onEffect: (effect) => overlay.setEffect(effect),
  });

  // ── Minutes 0-6: viewers watch ──────────────────────────────────────────
  // A 15-second presence tick, which is roughly what a real presence system
  // produces. Nothing leaves the process during this loop.
  console.log('== accruing ==');
  for (let tick = 0; tick < 24; tick += 1) {
    clock += 15_000;
    // LurkerLen closes the tab at minute 3 — proof that accrual is driven by
    // observed presence and not by a per-viewer timer that keeps running.
    const present = clock < Date.UTC(2026, 0, 1, 20, 3, 0) ? VIEWERS : VIEWERS.slice(0, 2);
    if (present.length !== VIEWERS.length) economy.forget('u_1003');
    economy.observe(present, clock);
  }
  for (const viewer of VIEWERS) {
    console.log(`  ${viewer.displayName.padEnd(16)} ${economy.balanceOf(viewer.viewerId)} points`);
  }

  // ── Seal and publish the closed windows ─────────────────────────────────
  console.log('\n== sealing + flushing earn windows ==');
  console.log(`  sealed ${economy.sealWindows(clock)} viewer-windows`);
  const flushed = await economy.flush();
  console.log(`  published ${flushed.published}, still pending ${flushed.skipped}`);

  // Prove the idempotency claim rather than asserting it. A second flush with
  // the same sealed rows would carry the same external ids; here there is
  // nothing left to send, which is itself the point — publishing is driven by
  // sealed windows, so it cannot double-fire by being called twice.
  const again = await economy.flush();
  console.log(`  flushing again published ${again.published} (windows are sealed once)`);

  // ── One redemption ──────────────────────────────────────────────────────
  console.log('\n== redemption ==');
  // An overlay-delivered reward, so you can watch the effect land in the blob
  // further down. debit -> persist -> currency-event -> rich alert -> effect.
  const bought = await redemptions.redeem({
    viewerId: 'u_1001',
    displayName: 'HoboViewer',
    rewardKey: 'takeover',
  });
  console.log(
    `  takeover by HoboViewer: ok=${bought.ok}${bought.reason ? ' reason=' + bought.reason : ''}`,
  );
  console.log(`  HoboViewer now holds ${economy.balanceOf('u_1001')} points`);

  // The refusal path. LurkerLen left early and cannot afford a takeover; the
  // ledger is untouched and no request is made at all.
  const broke = await redemptions.redeem({
    viewerId: 'u_1003',
    displayName: 'LurkerLen',
    rewardKey: 'takeover',
  });
  console.log(
    `  takeover by LurkerLen: ok=${broke.ok} reason=${broke.reason} balance=${broke.balance}`,
  );

  // ── Mirror the state for the browser source ─────────────────────────────
  console.log('\n== overlay session ==');
  const written = await overlay.publish(clock);
  console.log(`  write: ${JSON.stringify(written)}`);
  const seen = await overlay.readBack();
  console.log(`  overlay reads back: ${JSON.stringify(seen.model)}`);

  console.log('\n== totals ==');
  console.log('  economy:', JSON.stringify(economy.snapshot()));
  console.log('  overlay:', JSON.stringify(overlay.snapshot()));
  console.log('  redemptions:', JSON.stringify(redemptions.stats));
  console.log(
    '\nNothing here is durable. Balances, sealed windows, redemption rows and the\n' +
      'custom-alert claims are all in-memory Maps that die with the process — every\n' +
      'one of them is annotated with the table it should be. The PowerChat side is\n' +
      'already safe to replay; your side is what has to remember.',
  );
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.isAuthProblem) {
      console.error(
        'HINT — This scenario needs currency:write, alerts:rich and overlay:write, and\n' +
          '  alerts:rich is a SEPARATE scope from alerts:trigger. A scope registered on\n' +
          '  the app is not granted until it appears in the authorize `scope` param.\n' +
          '  Run examples/01-whoami.js to see what was actually granted.',
      );
    } else if (err.status === 400) {
      console.error(
        `HINT — Most likely "${CURRENCY}" is not declared on your app (portal -> your app ->\n` +
          '  Currencies). Declare it WITHOUT a unitsPerUsd rate: a rate would make these\n' +
          '  free watch-time points tip-eligible.',
      );
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
