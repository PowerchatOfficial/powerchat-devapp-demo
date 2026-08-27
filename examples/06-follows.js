'use strict';
/**
 * 06 — Follows.  POST /api/dev/v1/streamers/:username/follows
 *
 * Demonstrates: reporting a new follower on your platform (fires a follow alert
 * and credits follow goals), and the `externalId` IDEMPOTENCY KEY that makes
 * retries safe.
 *
 * Scope required: follows:write
 *
 * Run:  node examples/06-follows.js [followerName]
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

  const followerName = process.argv[2] || 'DemoFollower';

  // ------------------------------------------------------- what externalId IS
  //
  // The follower's STABLE id on YOUR platform — the same value you would store
  // in your own database. Not a random per-request id, and not the display name
  // (people rename themselves; ids do not).
  //
  // PowerChat treats it as the idempotency key for this endpoint: the first
  // POST with a given externalId fires the alert and credits the goal; later
  // POSTs with the same one are accepted and discarded. That is what makes a
  // blind retry after a timeout safe — you cannot tell whether the first
  // attempt landed, and with a stable externalId you do not need to.
  //
  // A random id per attempt turns one follower into three alerts and three
  // points of goal progress. This is the single most common way an integration
  // inflates a streamer's numbers.
  const externalId = 'demo-follower-1001';

  const follow = {
    followerName, // 1-48 chars, shown on the alert
    externalId, // 1-128, REQUIRED — the dedupe key
    occurredAt: new Date().toISOString(), // when they followed on YOUR platform
  };

  console.log(`\nReporting a new follower: ${followerName} (externalId=${externalId})`);
  const first = await client.sendFollow(streamer, follow);
  console.log(`Accepted: ${JSON.stringify(first)}`);
  console.log('That fired a follow alert on the overlay and credited any follow goal.');

  // --------------------------------------------------------- prove the dedupe
  //
  // Exactly what your retry path does after a network timeout: same body, same
  // externalId. The API accepts it again — the response shape is deliberately
  // identical, because "already processed" is a success, not an error — and no
  // second alert fires.
  console.log(`\nRe-sending the SAME externalId to simulate a retry...`);
  const second = await client.sendFollow(streamer, follow);
  console.log(`Accepted: ${JSON.stringify(second)}`);
  console.log('No second alert, no second point of goal progress. Retries are safe.');

  // A DIFFERENT externalId is a DIFFERENT person, so this one does alert. Use a
  // real id from your platform here; the timestamp is only to keep the demo
  // re-runnable without collisions.
  const otherId = `demo-follower-${Date.now()}`;
  console.log(`\nA different externalId (${otherId}) is a different follower...`);
  await client.sendFollow(streamer, {
    followerName: `${followerName}Two`,
    externalId: otherId,
    occurredAt: new Date().toISOString(),
  });
  console.log('Second alert fired, as expected.');

  console.log(
    '\nBackfilling history? Send `occurredAt` as the real follow time rather than now,\n' +
      'and expect follows:write to share the ~60 requests/minute write budget — pace a\n' +
      'bulk import, or the tail of it will 429.',
  );
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `follows:write`. Registering the scope on your app\n' +
          'is not enough; it must be in the authorize `scope` param. Run 01-whoami.js.',
      );
    } else if (err.status === 422 || err.status === 400) {
      console.error(
        'HINT — body validation. `externalId` is REQUIRED (1-128 chars) and `followerName`\n' +
          'is 1-48 chars. `occurredAt` must be an ISO-8601 timestamp.',
      );
    } else if (err.status === 429) {
      console.error('HINT 429 — follows share the ~60 requests/minute write budget. Back off.');
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
