'use strict';
/**
 * 01 — Who am I?  GET /api/dev/v1/me
 *
 * Demonstrates: identifying which streamer a token belongs to, listing the
 * scopes that were actually GRANTED, and diffing them against the scopes your
 * app needs so a 403 stops being a mystery.
 *
 * Scope required: none. /me works with any valid token, which makes it the
 * right first call in any integration and the right health check afterwards.
 *
 * Run:  node examples/01-whoami.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

/**
 * The scopes THIS demo repo exercises across all of its scripts. Swap in your
 * own list — the point is to keep one canonical list in code so the diff below
 * tells you exactly what to add to your next authorize call.
 */
const SCOPES_THIS_APP_NEEDS = [
  'profile:read',
  'chat:read',
  'chat:write',
  'paid_messages:read',
  'viewcount:write',
  'subscriptions:write',
  'follows:write',
  'currency:write',
  'tips:write',
  'alerts:trigger',
  'alerts:rich',
  'overlay:write',
  'checkout:attribute',
  'stream:read',
];

async function main() {
  requireConfig('accessToken');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });

  const me = await client.me();

  // Field names are read defensively so this script keeps working as the
  // payload grows; the raw body is printed at the end for reference.
  const username = me.streamer?.username ?? me.username ?? '(unknown)';
  const displayName = me.streamer?.displayName ?? me.displayName ?? username;
  const granted = me.scopes ?? me.grantedScopes ?? [];

  console.log(`\nToken belongs to: ${displayName} (@${username})`);
  console.log(`Host:             ${config.baseUrl}`);
  console.log(`\nGranted scopes (${granted.length}):`);
  for (const scope of [...granted].sort()) console.log(`  ✓ ${scope}`);

  // ------------------------------------------------ REGISTERED IS NOT REQUESTED
  //
  // The single most common cause of a 403 on a token that "should" work.
  // A scope lives in three places and all three must line up:
  //
  //   1. REGISTERED  — enabled on your app in the PowerChat developer settings.
  //   2. REQUESTED   — present in the `scope` parameter of the /oauth/authorize
  //                    URL you sent the streamer to. THIS is the step people
  //                    skip. Registering a scope does not request it; the grant
  //                    carries only what that one authorize call asked for.
  //   3. CONSENTED   — the streamer approved it on the consent screen.
  //
  // A token minted before you added a scope will never gain it. Adding a scope
  // means a NEW authorize round-trip, not a refresh — refreshing a token
  // preserves the original grant exactly.
  const grantedSet = new Set(granted);
  const missing = SCOPES_THIS_APP_NEEDS.filter((s) => !grantedSet.has(s));
  const extra = granted.filter((s) => !SCOPES_THIS_APP_NEEDS.includes(s));

  if (missing.length) {
    console.log(`\nNOT granted (${missing.length}) — every call needing one of these returns 403:`);
    for (const scope of missing) console.log(`  ✗ ${scope}`);
    console.log(
      '\nFix: add them to the `scope` parameter of a NEW /oauth/authorize call and have\n' +
        'the streamer re-consent. Refreshing the existing token will not help — a refresh\n' +
        'reproduces the original grant, it never widens it.\n' +
        `\n  scope=${SCOPES_THIS_APP_NEEDS.join(' ')}\n`,
    );
  } else {
    console.log('\nAll scopes this demo needs are granted. Nothing here will 403 on scope.');
  }

  if (extra.length) {
    // Not a problem, but worth pruning: streamers approve narrow asks more often.
    console.log(`\nGranted but unused by this app: ${extra.join(', ')}`);
  }

  console.log('\nRaw /me payload:');
  console.log(JSON.stringify(me, null, 2));
}

/** Print API failures with the one hint that actually resolves each status. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error(
        'HINT 401 — the token is expired, revoked, or malformed. This is about IDENTITY.\n' +
          'Refresh it with the stored refresh token, or run the OAuth flow again.',
      );
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — the token is valid but the grant lacks the scope. This is about PERMISSION.\n' +
          'A 403 on /me itself is unusual; on any other endpoint, re-run this script and read\n' +
          'the "NOT granted" list above.',
      );
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
