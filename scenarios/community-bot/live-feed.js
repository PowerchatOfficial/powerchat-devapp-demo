'use strict';
/**
 * live-feed.js — the live half of the community bot: one pinned "what's
 * happening now" message that keeps editing itself while the creator is live.
 *
 * WEBHOOKS OR SSE? Both, for different jobs. bot.js is the durable half; this
 * is the disposable one.
 *
 *   Webhooks  low-frequency, must-not-miss, retried until you ack. Money and
 *             memberships. If you are down, you get them when you come back.
 *   SSE       high-frequency, right-now, gone if you missed it. Viewer counts,
 *             chat lines, goal bars ticking. A chat message you learn about ten
 *             minutes late is worthless anyway.
 *
 * NEVER CREDIT MONEY FROM THIS FILE. Goal topics visibly carry money moving,
 * and it is tempting. But an SSE event has no delivery guarantee, no signature,
 * and no replay past the server's short buffer: if your process was restarting
 * you simply never saw it, and nothing will tell you so. Money is confirmed by
 * the signed `donation.completed` webhook, once, in bot.js. This file draws.
 *
 * RECONNECTION IS THE ENTIRE EXERCISE. Every event carries an id. Hand the last
 * one back as `Last-Event-ID` and the server replays what you missed during the
 * gap. Reconnect WITHOUT it and the gap is silently dropped — which looks
 * exactly like nothing having happened.
 */
const { config, requireConfig } = require('../../src/config');
const { PowerChatClient, PowerChatApiError } = require('../../src/powerchat');

const DEFAULT_TOPICS = ['chat', 'view-count', 'goal', 'subathon'];
const MAX_BACKOFF_MS = 30_000;

/**
 * How long a silent stream is allowed to stay silent before we assume the
 * connection is dead.
 *
 * READ THIS BEFORE TUNING IT. PowerChat sends heartbeats, but they are SSE
 * COMMENT lines (`: ping`) and `src/powerchat.js` skips them without surfacing
 * an event — as every conforming SSE client does. So from up here a quiet
 * channel and a half-open socket are literally the same observation: nothing
 * arrives. There is no way to tell them apart, and this watchdog does not
 * pretend to. It just reconnects, which is cheap and, with `Last-Event-ID`,
 * always safe: at worst you reconnect to a stream that was fine, and the
 * replay hands you nothing because you missed nothing.
 *
 * A dead TCP socket can otherwise sit there for a very long time before the
 * kernel notices. That is the failure this exists for.
 */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Editing a pinned message on a real chat platform is rate limited. */
const RENDER_THROTTLE_MS = 5000;
const CHAT_TAIL = 5;

function createLiveFeed(options = {}) {
  const { client, streamer } = options;
  const topics = [...(options.topics ?? DEFAULT_TOPICS)];
  const now = options.now ?? (() => Date.now());

  /**
   * The real chat platform goes here — see bot.js. For a live feed this is an
   * EDIT of an existing message (Discord `PATCH /channels/:id/messages/:id`),
   * not a new post, or you fill the channel with a hundred near-identical
   * snapshots an hour.
   */
  const render = options.render ?? (async ({ text }) => console.log(`\n[pinned]\n${text}\n`));

  /**
   * The resume point, and the single most important variable in this file.
   * In production persist it (a `stream_cursors` row, or Redis) so a deploy
   * resumes where it stopped instead of starting blind. An in-memory value is
   * lost on restart, and a restart is exactly when you need it.
   */
  let lastEventId = options.lastEventId ?? null;

  /** The "what's happening now" model. Disposable by design. */
  const state = { viewers: null, goals: new Map(), chat: [], lastEventAt: null };

  let handle = null;
  let stopped = false;
  let attempt = 0;
  let idleTimer = null;
  let reconnectTimer = null;
  let renderTimer = null;
  let renderPending = false;
  const stats = { events: 0, reconnects: 0, idleTrips: 0, droppedTopics: [] };

  function summary() {
    const lines = [];
    lines.push(state.viewers === null ? 'Viewers: —' : `Viewers: ${state.viewers}`);
    for (const goal of state.goals.values()) {
      lines.push(`Goal ${goal.name}: ${goal.currentValue} / ${goal.targetValue}`);
    }
    if (state.chat.length) {
      lines.push('Chat:');
      for (const line of state.chat) lines.push(`  ${line}`);
    }
    const age = state.lastEventAt ? Math.round((now() - state.lastEventAt) / 1000) : null;
    // Show the reader how stale this is. A pinned message with no timestamp is
    // indistinguishable from a bot that died an hour ago, and the whole point
    // of the watchdog is that we cannot tell the difference either.
    lines.push(age === null ? 'no events yet' : `updated ${age}s ago`);
    return lines.join('\n');
  }

  /** Coalesce bursts: chat can arrive far faster than any chat platform lets
   *  you edit a message. Render at most once per throttle window. */
  function scheduleRender() {
    if (renderTimer) {
      renderPending = true;
      return;
    }
    render({ text: summary() }).catch((err) =>
      console.warn('[live-feed] render failed:', err.message),
    );
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (renderPending) {
        renderPending = false;
        scheduleRender();
      }
    }, RENDER_THROTTLE_MS);
    renderTimer.unref?.();
  }

  function armIdleWatchdog() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (stopped) return;
      stats.idleTrips += 1;
      console.warn(`[live-feed] nothing for ${IDLE_TIMEOUT_MS / 1000}s — reconnecting`);
      // Tear the socket down ourselves rather than waiting for a TCP timeout
      // that may never come. `close()` aborts the fetch, the read loop ends,
      // and we reconnect from `lastEventId`.
      handle?.close();
      handle = null;
      scheduleReconnect(true);
    }, IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  }

  function onEvent(event) {
    // Persist the resume point BEFORE acting on the event. If the handler
    // throws, re-processing one event is much better than losing everything
    // after it.
    if (event.id) lastEventId = event.id;
    attempt = 0; // the connection is demonstrably healthy again
    stats.events += 1;
    state.lastEventAt = now();
    armIdleWatchdog();

    const data = event.data ?? {};
    switch (event.type) {
      case 'view-count':
        state.viewers = data.total ?? data.count ?? state.viewers;
        break;
      case 'goal':
      case 'goal.updated':
      case 'goal.completed': {
        const goal = data.goal ?? data;
        if (goal && goal.goalId) state.goals.set(goal.goalId, goal);
        break;
      }
      case 'chat': {
        const who = data.chatterName ?? data.actorName ?? 'someone';
        state.chat.push(`${who}: ${data.message ?? ''}`);
        if (state.chat.length > CHAT_TAIL) state.chat.shift();
        break;
      }
      default:
        // Unknown topics are normal: new event types ship without your
        // redeploy. Ignore them quietly rather than crashing the feed.
        break;
    }
    scheduleRender();
  }

  async function connect() {
    if (stopped) return;
    const resuming = lastEventId ? ` (resuming after ${lastEventId})` : '';
    console.log(`[live-feed] connecting to [${topics.join(', ')}]${resuming}`);
    handle = await client.openStream(streamer, {
      topics,
      lastEventId,
      onEvent,
      onError(err) {
        if (stopped) return;
        if (err instanceof PowerChatApiError && err.status === 403) {
          // A requested topic is outside the grant. `chat` needs `chat:read`
          // ON TOP of `stream:read`, and it is by far the usual culprit —
          // so drop it and reconnect with the rest rather than dying. A
          // missing scope should cost you one feature, not the whole feed.
          const index = topics.indexOf('chat');
          if (index !== -1) {
            topics.splice(index, 1);
            stats.droppedTopics.push('chat');
            console.warn('[live-feed] 403 — dropping `chat` (needs chat:read) and retrying');
            scheduleReconnect(true);
            return;
          }
          console.error('[live-feed] 403 with no optional topic left to drop. Not retrying.');
          stopped = true;
          return;
        }
        console.warn('[live-feed] stream error:', err.message);
        scheduleReconnect();
      },
    });
    armIdleWatchdog();
  }

  function scheduleReconnect(immediate = false) {
    if (stopped) return;
    // Exactly one pending reconnect at a time. `onError` and the idle watchdog
    // can both fire for the same dead connection, and without this guard that
    // opens two streams — which then both deliver every event, so the pinned
    // message renders twice and `lastEventId` walks backwards.
    if (reconnectTimer) return;
    stats.reconnects += 1;
    // Jitter, because every consumer of a restarted gateway backs off from the
    // same instant and would otherwise reconnect in lockstep.
    const base = immediate ? 250 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
    const delay = Math.round(base * (0.5 + Math.random()));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((err) => {
        console.warn('[live-feed] reconnect failed:', err.message);
        scheduleReconnect();
      });
    }, delay);
    reconnectTimer.unref?.();
  }

  async function start() {
    await connect();
  }

  function stop() {
    stopped = true;
    handle?.close();
    if (idleTimer) clearTimeout(idleTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (renderTimer) clearTimeout(renderTimer);
    return { lastEventId, ...stats };
  }

  return {
    start,
    stop,
    state,
    summary,
    stats,
    get lastEventId() {
      return lastEventId;
    },
  };
}

// -------------------------------------------------------------------- main

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    // Prefer `getAccessToken` over a fixed token in a long-running consumer:
    // a token that expires mid-stream makes every reconnect fail with the same
    // dead credential, forever. `src/powerchat.js` calls it again on a 401 so
    // a refresh happens transparently. This demo uses the fixed form for
    // brevity; see server.js for the refreshing version.
    accessToken: config.accessToken,
  });

  const topics = (process.argv[2] || DEFAULT_TOPICS.join(',')).split(',').map((t) => t.trim());
  const feed = createLiveFeed({ client, streamer: config.streamer, topics });

  process.on('SIGINT', () => {
    const final = feed.stop();
    console.log(`\nclosed. ${JSON.stringify(final)}`);
    console.log('Persist lastEventId and pass it back on the next start to close the gap.');
    process.exit(0);
  });

  await feed.start();
  console.log('listening — Ctrl-C to stop. Money is NOT credited from here; that is bot.js.');
}

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof PowerChatApiError && err.isAuthProblem) {
      console.error(`\n${err.message}`);
      console.error(
        'HINT — this needs stream:read, and the `chat` topic needs chat:read as well.\n' +
          '  A scope registered on the app is not granted until it appears in the\n' +
          '  authorize `scope` param. Run examples/01-whoami.js to see the truth.',
      );
    } else {
      console.error('\n' + (err && err.stack ? err.stack : err));
    }
    process.exitCode = 1;
  });
}

module.exports = { createLiveFeed, DEFAULT_TOPICS, IDLE_TIMEOUT_MS };
