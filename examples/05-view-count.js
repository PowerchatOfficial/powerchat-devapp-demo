'use strict';
/**
 * 05 — Viewer count heartbeat.  POST /api/dev/v1/streamers/:username/view-count
 *
 * Demonstrates: the 90-SECOND FRESHNESS RULE. A viewer count is not a value you
 * set once; it is a heartbeat you keep alive. A freshness sweep clears any count
 * older than 90 seconds and the overlay chip drops to 0 until your next report,
 * so a stream that is very much live starts advertising an empty room.
 *
 * Also shows the clean shutdown: `count: null` means THE STREAM ENDED, which is
 * different from `count: 0` (live, nobody watching).
 *
 * Scope required: viewcount:write
 * Env: POWERCHAT_REFRESH_TOKEN + POWERCHAT_CLIENT_ID (and _SECRET for a
 *      confidential app) so the heartbeat survives access-token expiry.
 *
 * Run:  node examples/05-view-count.js
 *       Ctrl-C to stop — it posts null on the way out.
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');
const { createEnvTokenSource } = require('../src/credentials');

// Comfortably inside the 90s window. Do not tune this to 89s: a single dropped
// request would then expire the count, and view-count shares the ~60/min budget
// with subs, tips and currency events, so there is no reason to go faster.
const HEARTBEAT_MS = 30_000;

/** Stand-in for whatever your platform actually knows about concurrent viewers. */
function readViewerCountFromYourPlatform(previous) {
  const drift = Math.floor(Math.random() * 21) - 10;
  return Math.max(0, previous + drift);
}

async function main() {
  requireConfig('accessToken', 'streamer');
  // A heartbeat outlives an access token (~10 minutes). With a FIXED token
  // every beat after expiry 401s, the 90s sweep clears the count, and the
  // chip advertises an empty room while the stream is live. So the client is
  // built on `getAccessToken`: it is called again after a 401, refreshes with
  // POWERCHAT_REFRESH_TOKEN, and `src/credentials.js` writes the rotated
  // pair back to .env before the new token is used.
  const { getAccessToken } = createEnvTokenSource();
  const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });
  const streamer = config.streamer;

  let count = 1200;
  await client.setViewCount(streamer, count);
  console.log(`\nReported ${count} viewers for @${streamer}.`);
  console.log(`Heartbeat every ${HEARTBEAT_MS / 1000}s (the rule is: at least every 90s).`);
  console.log('Ctrl-C to end the stream cleanly.\n');

  const timer = setInterval(async () => {
    count = readViewerCountFromYourPlatform(count);
    try {
      await client.setViewCount(streamer, count);
      console.log(`${new Date().toISOString()}  count=${count}`);
    } catch (err) {
      // One failed beat is survivable — the next is well inside the 90s window.
      // Log it and carry on rather than tearing down a live stream's heartbeat.
      const detail = err instanceof PowerChatApiError ? err.message : String(err);
      console.error(
        `${new Date().toISOString()}  heartbeat failed (retrying next beat): ${detail}`,
      );
    }
  }, HEARTBEAT_MS);

  // Hold the process open until the operator interrupts. Registering a SIGINT
  // listener replaces Node's default "exit immediately", which is what buys us
  // the chance to post the final null below.
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  console.log('\nShutting down...');
  clearInterval(timer);

  // ------------------------------------------------------------ null vs 0
  //
  //   null  the stream ENDED. The chip disappears; PowerChat stops expecting
  //         heartbeats from you.
  //   0     the stream is LIVE with nobody watching. Still requires heartbeats.
  //
  // Sending 0 at shutdown leaves a live-but-empty stream on the overlay for up
  // to 90 seconds. Send null.
  try {
    await client.setViewCount(streamer, null);
    console.log('Posted count: null — stream ended. Chip cleared immediately.');
  } catch (err) {
    // Worth reporting but not worth hanging on: the 90s sweep clears it anyway.
    const detail = err instanceof PowerChatApiError ? err.message : String(err);
    console.error(`Could not post the final null (${detail}). The freshness sweep will clear it.`);
  }
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `viewcount:write`. Run 01-whoami.js to confirm.',
      );
    } else if (err.status === 422 || err.status === 400) {
      console.error('HINT — `count` must be an integer >= 0, or null for "stream ended".');
    } else if (err.status === 429) {
      console.error(
        'HINT 429 — view-count shares a ~60 requests/minute budget with subs, tips and\n' +
          'currency events. A 30s heartbeat costs 2/min; if you are hitting this, something\n' +
          'else in your app is the heavy caller.',
      );
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
