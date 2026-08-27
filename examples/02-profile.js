'use strict';
/**
 * 02 — Streamer profile.  GET /api/dev/v1/streamers/:username/profile
 *
 * Demonstrates: reading a streamer's public profile and live status, and
 * telling a 404 (no such streamer) apart from a 403 (no such permission) —
 * two failures that look identical in a log line but need opposite fixes.
 *
 * Scope required: profile:read
 *
 * Run:  node examples/02-profile.js [username]
 *       Defaults to POWERCHAT_STREAMER from your .env.
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });

  const username = process.argv[2] || config.streamer;
  const profile = await client.profile(username);

  const displayName = profile.displayName ?? profile.username ?? username;
  const isLive = profile.isLive ?? profile.live ?? false;

  console.log(`\n${displayName} (@${profile.username ?? username})`);
  console.log(`Status: ${isLive ? 'LIVE now' : 'offline'}`);

  // The tip page is where checkout links in example 09 land, so it is worth
  // surfacing here — it confirms the account can actually receive money.
  if (profile.tipPageUrl) console.log(`Tip page: ${profile.tipPageUrl}`);
  if (profile.bio) console.log(`\n${profile.bio}`);

  console.log('\nRaw profile payload:');
  console.log(JSON.stringify(profile, null, 2));

  // ------------------------------------------------------- the 404 lesson
  //
  // Ask for a username that cannot exist. The interesting part is not that it
  // fails, it is WHICH failure you get, because the two are fixed differently:
  //
  //   404  the token is fine, the scope is fine, the USERNAME is wrong.
  //        Usually a display name used where a handle was needed, or a typo.
  //   403  the username may be perfectly real — your GRANT does not cover it.
  //        A token is issued for one streamer; it cannot read another's data
  //        no matter how public that data looks in a browser.
  //
  // Treat 404 as "not found, stop retrying" and never as a transient error:
  // PowerChatApiError.isRetryable is false for it, and retrying a typo forever
  // is how apps end up rate-limited for nothing.
  const bogus = 'definitely-not-a-real-streamer-' + Date.now();
  console.log(`\n--- Now asking for a username that does not exist: ${bogus}`);
  try {
    await client.profile(bogus);
    console.log('Unexpected: that username resolved.');
  } catch (err) {
    if (err instanceof PowerChatApiError && err.status === 404) {
      console.log(`Got the expected 404: ${err.message}`);
      console.log(`isRetryable = ${err.isRetryable} — so do not retry; fix the username.`);
    } else if (err instanceof PowerChatApiError && err.status === 403) {
      // Some hosts answer 403 rather than 404 so an unauthorised caller cannot
      // enumerate which usernames exist. Handle both; the fix differs.
      console.log(`Got a 403 instead: ${err.message}`);
      console.log('That is the deliberate anti-enumeration answer — or a missing profile:read.');
    } else {
      throw err;
    }
  }
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `profile:read`, or you asked about a streamer this\n' +
          'token was not issued for. Run 01-whoami.js: it prints who the token belongs to and\n' +
          'exactly which scopes were granted.',
      );
    } else if (err.status === 404) {
      console.error('HINT 404 — no streamer with that username. Check the handle, not the scope.');
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
