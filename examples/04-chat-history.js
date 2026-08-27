'use strict';
/**
 * 04 — Unified chat history.  GET /api/dev/v1/streamers/:username/chat/history
 *
 * Demonstrates: pulling the merged chat log and rendering it as a readable
 * transcript. "Unified" is the point — Twitch, Kick, YouTube, PowerChat's own
 * chat and anything your app has posted all arrive in ONE ordered list, so a
 * bot or a moderation tool sees the room the way the streamer does.
 *
 * Scope required: chat:read
 *
 * Run:  node examples/04-chat-history.js [limit]
 *       node examples/04-chat-history.js 100
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

/** History may arrive as a bare array or wrapped; normalise once, here. */
const asList = (payload) =>
  Array.isArray(payload) ? payload : (payload?.items ?? payload?.messages ?? []);

/** Fixed-width platform tag so the names line up in a terminal. */
function platformLabel(entry) {
  const raw = entry.platform ?? entry.source ?? entry.origin ?? 'powerchat';
  return String(raw).toLowerCase().slice(0, 9).padEnd(9);
}

/** Moderators and subscribers read very differently in a transcript. */
function badges(entry) {
  const marks = [];
  if (entry.isModerator) marks.push('MOD');
  if (entry.isSubscriber) marks.push('SUB');
  return marks.length ? ` [${marks.join(' ')}]` : '';
}

function clockTime(entry) {
  const stamp = entry.occurredAt ?? entry.createdAt ?? entry.timestamp;
  if (!stamp) return '--:--:--';
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toISOString().slice(11, 19);
}

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // `limit` caps how far back you reach. Keep it modest in a polling loop:
  // reads share a budget of roughly 120 requests/minute with chat writes, and
  // a large limit on a tight interval is the fastest way to a 429.
  const limit = Number(process.argv[2] || 50);

  const history = asList(await client.chatHistory(streamer, { limit }));
  console.log(`\nLast ${history.length} message(s) for @${streamer} — oldest first.\n`);

  if (!history.length) {
    console.log('Nothing in history yet. Run 03-send-chat.js to put a message in the room.');
    return;
  }

  // The list arrives newest LAST, which is already transcript order — do not
  // reverse it, or replies will read before the messages they answer.
  for (const entry of history) {
    const who = entry.chatterName ?? entry.displayName ?? entry.username ?? 'unknown';
    console.log(
      `${clockTime(entry)}  ${platformLabel(entry)}  ${who}${badges(entry)}: ${entry.message ?? ''}`,
    );
  }

  // A per-platform tally is the quickest sanity check that a new integration
  // is actually landing in the unified room rather than only in its own silo.
  const perPlatform = new Map();
  for (const entry of history) {
    const key = platformLabel(entry).trim();
    perPlatform.set(key, (perPlatform.get(key) ?? 0) + 1);
  }
  console.log('\nMessages by platform:');
  for (const [platform, count] of [...perPlatform].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${platform.padEnd(12)} ${count}`);
  }

  console.log(
    '\nNote: this endpoint is a catch-up read, not a live feed. Polling it in a loop\n' +
      'burns the rate limit and still lags. For live chat open the SSE gateway instead\n' +
      '(topics=chat, scopes stream:read + chat:read) — see the streaming example.',
  );
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `chat:read`. It is a separate scope from\n' +
          '`chat:write`: being able to post does not let you read the room back.',
      );
    } else if (err.status === 429) {
      console.error(
        'HINT 429 — reads share the ~120 requests/minute budget. If you are polling this\n' +
          'endpoint, switch to the SSE gateway rather than shortening the interval.',
      );
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
