'use strict';
/**
 * 10 — The overlay session: a small, short-lived scratchpad for your own overlay.
 *
 * Demonstrates
 *   POST /streamers/:u/overlay-session   [overlay:write]  store a JSON blob
 *   GET  /streamers/:u/overlay-session   [overlay:write]  read it back
 *
 * What it is for. Say your app has a browser-source overlay the streamer added
 * to OBS. That overlay is a static page: it has no database, no session, and
 * no way to hold a secret. This endpoint is the bridge. Your BACKEND writes
 * the current state here; your OVERLAY reads it back and renders it. Two
 * clients, one app, one blob.
 *
 * What it is NOT. It is not storage. It is a Redis key with a TTL, scoped to
 * (this streamer, this app), and it evaporates:
 *   · data must serialize to 8KB or less — this is a state pointer, not a CDN
 *   · ttlSeconds is 1–3600, defaulting to 300 (5 minutes)
 *   · one slot per app per streamer: writing REPLACES the whole blob
 *   · a GET after expiry returns null, not an error — always handle null
 *
 * The TTL is a feature. If your app dies mid-stream, the overlay stops seeing
 * stale state within a minute or two instead of showing a frozen scoreboard
 * for the rest of the night. Re-post on every meaningful change and treat the
 * write as a heartbeat.
 *
 * Scope required: overlay:write (the same scope covers both directions)
 * Run: node examples/10-overlay-session.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

const MAX_BLOB_BYTES = 8192;

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // Whatever your overlay needs to draw one frame. Keep it small and flat —
  // you are shipping a view model, not a database row.
  const state = {
    mode: 'boss_fight',
    bossName: 'The Landlord',
    hpPercent: 62,
    contributors: [
      { name: 'HoboViewer', points: 1500 },
      { name: 'RehearsalRita', points: 900 },
    ],
    updatedAt: new Date().toISOString(),
  };

  // Check the size YOURSELF before the round trip. The server rejects an
  // oversized blob with a 400, and finding that out from a live overlay at
  // 2am is worse than finding it out here.
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  console.log(`\nblob size: ${bytes} bytes of ${MAX_BLOB_BYTES} allowed`);
  if (bytes > MAX_BLOB_BYTES) {
    throw new Error('Blob is over 8KB — store the bulk on your side and put a reference here.');
  }

  // ── Write ────────────────────────────────────────────────────────────────
  console.log('\n[POST overlay-session] storing state with a 120s TTL');
  const put = await client.putOverlaySession(streamer, state, 120);
  // The server clamps rather than rejects, so read the value it actually used
  // instead of assuming your requested TTL survived.
  console.log('  expiresInSeconds:', put.expiresInSeconds);

  // ── Read back ────────────────────────────────────────────────────────────
  // This is the call your overlay page makes. The envelope carries the appId
  // and an updatedAt stamp alongside your blob, so the overlay can tell fresh
  // state from something that has quietly stopped updating.
  console.log('\n[GET overlay-session] reading it back');
  const session = await client.getOverlaySession(streamer);
  if (!session) {
    // Not an error condition. Expired, never written, or written by a
    // different app — all three look identical, and all three mean "render
    // your empty state".
    console.log('  null — nothing stored. Render the idle overlay.');
    return;
  }
  console.log('  updatedAt:', session.updatedAt);
  console.log('  data:', JSON.stringify(session.data, null, 2));

  const ageMs = Date.now() - Date.parse(session.updatedAt);
  console.log(`  age: ${Math.round(ageMs / 1000)}s`);
  console.log('\nIn a real overlay: poll this every few seconds, or drive the visuals from');
  console.log('the SSE stream (example 13) and use this blob only for state you own.');
  console.log('One slot per app: a second POST replaces this entirely, it does not merge.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.status === 400) {
      console.error('HINT — Usually an oversized blob (>8KB) or a ttlSeconds outside 1–3600.');
    } else if (err.isAuthProblem) {
      console.error(
        'HINT — Expired token, or overlay:write was registered on the app but never\n' +
          '  REQUESTED in the authorize `scope` param. GET /me shows what was granted.',
      );
    } else if (err.isRetryable) {
      console.error('HINT — Rate limited or a server blip. Retry with backoff.');
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
