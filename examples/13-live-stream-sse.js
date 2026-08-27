'use strict';
/**
 * 13 — The SSE gateway: live data, with reconnection that does not lose events.
 *
 * Demonstrates
 *   GET /streamers/:u/stream?topics=…   [stream:read]  (+ chat:read for `chat`)
 *
 * SSE OR WEBHOOKS? Both, for different jobs.
 *   SSE       — high-frequency, right-now, disposable. Chat lines, viewer
 *               counts, goal bars ticking up. If your process is down you miss
 *               them, and that is FINE: a chat message you learn about ten
 *               minutes late is worthless anyway. Perfect for overlays and
 *               live dashboards.
 *   Webhooks  — low-frequency, must-not-miss, durable. Money. `donation
 *               .completed` is retried until you acknowledge it, which is why
 *               the full alert-payload topic is deliberately NOT on this
 *               gateway. Never credit a user from an SSE event.
 *
 * Topics: chat, view-count, chatter-stats, goal, sub-goal, follow-goal,
 * channelpoints-goal, subathon. Every topic rides stream:read; `chat` needs
 * chat:read as well, because that one carries what people actually said.
 *
 * Topic names are NOT event names. Each frame's `event:` line carries the
 * event the server emitted on that topic — `chat.message` on `chat`,
 * `view-count.updated` on `view-count`, `goal.updated` on the goal topics.
 * Dispatch on the event name (see the switch below), never on the topic.
 *
 * Reconnection is the whole point of the exercise. Every event has an id; hand
 * the last one back as Last-Event-ID and the server replays what you missed
 * during the gap. Reconnecting WITHOUT it silently drops the gap instead.
 *
 * Scopes required: stream:read (+ chat:read for the chat topic)
 * Run: node examples/13-live-stream-sse.js [topics]
 *      node examples/13-live-stream-sse.js chat,view-count,goal,subathon
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');
const { createEnvTokenSource } = require('../src/credentials');

const TOPICS = (process.argv[2] || 'chat,view-count,goal').split(',').map((t) => t.trim());
const MAX_BACKOFF_MS = 30_000;

async function main() {
  requireConfig('accessToken', 'streamer');
  // This process runs until you stop it, which is longer than an access token
  // lives (~10 minutes). A fixed token would make every reconnect after that
  // fail with the same dead credential; `getAccessToken` refreshes on the 401
  // and `src/credentials.js` persists the rotated pair back to .env.
  const { getAccessToken } = createEnvTokenSource();
  const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });
  const streamer = config.streamer;

  let lastEventId; // the resume point — the single most important variable here
  let attempt = 0; // reset on every successful event, not on every connect
  let received = 0;
  let stopped = false;
  let handle = null;

  async function connect() {
    if (stopped) return;
    const resuming = lastEventId ? ` (resuming after ${lastEventId})` : '';
    console.log(`\nconnecting to [${TOPICS.join(', ')}]${resuming}…`);
    handle = await client.openStream(streamer, {
      topics: TOPICS,
      lastEventId,
      onEvent(event) {
        // Persist the id BEFORE you act on the event. If your handler throws,
        // you would rather re-process one event than lose everything after it.
        if (event.id) lastEventId = event.id;
        attempt = 0; // the connection is demonstrably healthy again
        received += 1;
        const payload = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        console.log(`  ${new Date().toISOString()}  ${event.type.padEnd(18)} ${payload}`);
        // What you would actually do with each one — keyed by EVENT name.
        switch (event.type) {
          case 'chat.message': // topic `chat`: { chatterName, message, platform, … }
          case 'view-count.updated': // topic `view-count`: { perPlatform, total }
          case 'goal.updated': // goal topics: { goal: { goalId, currentValue, … } }
          case 'goal.completed':
            break;
          default:
            break; // new event types ship without your redeploy — ignore, never crash
        }
      },
      onClose() {
        // The server ended the stream cleanly — a deploy, an idle policy.
        // No error is raised, the read loop just stops, and without this
        // the process would exit. Reconnect from the last id.
        if (stopped) return;
        console.log('  stream closed by the server');
        scheduleReconnect();
      },
      onError(err) {
        if (stopped) return;
        console.error('  stream error:', err.message);
        // A 401 mid-stream means the token expired; because the client was
        // built with `getAccessToken`, the reconnect below picks up a fresh
        // one. With a fixed `accessToken` this would loop forever.
        if (err instanceof PowerChatApiError && err.status === 403) {
          console.error('  403 — a requested topic is outside your granted scopes. Not retrying.');
          stopped = true;
          return;
        }
        scheduleReconnect();
      },
    });
  }

  function scheduleReconnect() {
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    attempt += 1;
    console.log(`  reconnecting in ${delay / 1000}s (attempt ${attempt})`);
    // This timer is NOT unref'd. After the stream fails it is the only handle
    // left on the event loop; an unref'd timer lets Node exit before it
    // fires, and the reconnect with Last-Event-ID never happens.
    setTimeout(() => {
      connect().catch((err) => {
        console.error('  reconnect failed:', err.message);
        scheduleReconnect();
      });
    }, delay);
  }

  // Ctrl-C: abort the in-flight request so the socket closes cleanly instead
  // of leaving the server holding a subscription until it times out.
  process.on('SIGINT', () => {
    stopped = true;
    handle?.close();
    console.log(`\n\nclosed. ${received} events received.`);
    if (lastEventId) console.log(`resume from: ${lastEventId}`);
    process.exit(0);
  });

  await connect();
  console.log('listening — Ctrl-C to stop.');
  console.log('Heartbeats are SSE comments and are not surfaced as events, so a quiet');
  console.log('channel looks identical to a healthy one. A clean close by the server');
  console.log('triggers a reconnect (onClose); for an always-on consumer also add an');
  console.log('idle timer that reconnects when nothing arrives for a few minutes — see');
  console.log('scenarios/community-bot/live-feed.js. Reconnecting with Last-Event-ID is');
  console.log('cheap and always safe.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.isAuthProblem) {
      console.error(
        'HINT — Expired token, or a topic you asked for is not covered by your grants.\n' +
          '  The `chat` topic needs chat:read ON TOP of stream:read, and a scope that\n' +
          '  is merely registered on the app is not granted until it appears in the\n' +
          '  authorize `scope` param. GET /me lists what you actually hold.',
      );
    } else if (err.isRetryable) {
      console.error('HINT — Rate limited or a server blip. Back off and reconnect.');
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
