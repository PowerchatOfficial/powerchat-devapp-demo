'use strict';
/**
 * bridge.js — the integration half. Site events in, PowerChat calls out.
 *
 * This is the file worth reading twice. The numbered examples in `examples/`
 * each show one endpoint working in isolation; a bridge is what those endpoints
 * look like once they have to survive each other. The interesting code here is
 * not the four POST calls, it is everything around them:
 *
 *   - IDEMPOTENCY KEYS DERIVED FROM THE SITE'S OWN IDS, never minted here. A key
 *     generated at send time is only unique per attempt, which is exactly the
 *     wrong granularity: a timeout you retry, a restart that replays, or an
 *     at-least-once internal bus each turn one event into two alerts and two
 *     points of goal progress. Derived keys make all three harmless.
 *   - PER-RAIL PACING. Chat and reads share ~120 requests/minute; subs, follows,
 *     tips and view counts share ~60; alerts ~30. A busy chat room produces more
 *     messages than the chat budget allows, so chat is METERED AND DROPPED —
 *     late chat is worthless. Memberships and follows are QUEUED AND RETRIED —
 *     a lost sub is not acceptable at any latency.
 *   - CAPABILITY GATING. A streamer can grant a narrow scope set, and can switch
 *     an individual capability off mid-stream without revoking anything. Both
 *     look like a 403. A missing capability disables that one mirror and logs
 *     once; the other three keep running.
 *   - A LIFECYCLE. Going live starts the view-count heartbeat; going offline (or
 *     SIGINT) drains what is in flight and posts `count: null`.
 *
 * All state here is in memory and says so at each site. Nothing in this file
 * modifies `src/` — it is a consumer of `src/powerchat.js` like any app.
 */
const { PowerChatApiError } = require('../../src/powerchat');

// ---------------------------------------------------------------- tuning knobs

/** Re-post the view count this often. The server expires it at 90s; 30s leaves
 *  room for two consecutive failures before the chip goes stale. */
const HEARTBEAT_MS = 30_000;
/** Minimum spacing between view-count posts triggered by a viewer change. A
 *  1:1 mirror of join/leave would exhaust the 60/min write budget in a minute
 *  of a busy room and tells the overlay nothing a 5s debounce does not. */
const VIEW_COUNT_MIN_GAP_MS = 5_000;
/** After a failed view-count post, try again soon rather than at the next beat. */
const VIEW_COUNT_RETRY_MS = 5_000;
/** Chat ceiling, under the ~120/min shared with reads. Overflow is DROPPED. */
const CHAT_BUDGET_PER_MIN = 100;
/** Spacing on the durable rail, under the ~60/min shared write budget. */
const DURABLE_MIN_GAP_MS = 1_100;
/** In-request retries before a job is handed to the outbox. */
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
/** Outbox drain cadence and give-up point. */
const OUTBOX_RETRY_MS = 10_000;
const OUTBOX_MAX_ROUNDS = 6;

/** Which scope each mirror needs, and what it buys the streamer. */
const MIRRORS = {
  chat: { scope: 'chat:write', label: 'chat' },
  viewCount: { scope: 'viewcount:write', label: 'view count' },
  follows: { scope: 'follows:write', label: 'follows' },
  members: { scope: 'subscriptions:write', label: 'memberships' },
};

/** Everything this bridge touches, including the read used to verify chat. */
const SCOPES_USED = [
  'chat:write',
  'chat:read',
  'viewcount:write',
  'follows:write',
  'subscriptions:write',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------- pure helpers

/** PowerChat enforces field lengths; truncate rather than collect 422s. */
function clamp(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(0, max);
}

/** Chat history may arrive bare or wrapped. Normalise in one place. */
const asList = (payload) =>
  Array.isArray(payload) ? payload : (payload?.items ?? payload?.messages ?? []);

/**
 * Turn whatever your site stores in `avatarPath` into something PowerChat can
 * actually fetch, or into `null`.
 *
 * The gotcha this exists for: PowerChat does not error on an avatar it cannot
 * load. It renders a letter placeholder. So a bridge that ships `/media/a.png`
 * or a `data:` URI looks completely healthy — 202 on every message — while every
 * chatter on your platform shows up faceless next to the Twitch users who have
 * pictures, and the streamer concludes your integration is the broken one.
 *
 * Returning null is better than returning something unfetchable: with no
 * `avatarUrl` at all, `avatarFallback` decides what the placeholder says.
 */
function resolveAvatarUrl(rawPath, publicOrigin) {
  if (!rawPath) return null;
  let url;
  try {
    // Relative paths resolve against your site's PUBLIC origin — not localhost,
    // not an internal service name, not whatever your app server thinks it is.
    url = new URL(String(rawPath), publicOrigin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null; // data:, blob:, file:
  // An absolute URL can still be unreachable from PowerChat's renderer. This is
  // the dev-config leak that survives into production more often than it should.
  const host = url.hostname.toLowerCase();
  const unreachable =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (unreachable) return null;
  return url.toString();
}

/**
 * 1-8 characters for the placeholder, derived from a display name that may be
 * wearing a role tag.
 *
 * Sites decorate names: `[MOD] pixel fox`, `(VIP) Hex Wright`, `★ saltmarsh`.
 * Naive initials produce `[M`, `(V` and `★` — every moderator on the overlay
 * gets the same bracket. Strip the decoration, then take initials, then fall
 * back to the handle, which is the one field that is always plain.
 */
function avatarFallbackFrom(displayName, handle = '') {
  const stripped = String(displayName ?? '')
    .replace(/^\s*[[({<][^\])}>]*[\])}>]\s*/, '') // a leading bracketed tag
    .replace(/^[^\p{L}\p{N}]+/u, '') // leading emoji, stars, punctuation
    .trim();
  const words = stripped.split(/[\s_.\-|]+/u).filter(Boolean);
  const initials = words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '') // spread, so an emoji is one unit
    .join('');
  const cleaned = [...initials].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
  const source = cleaned || [...String(handle)].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');
  return clamp((source || 'PC').toUpperCase(), 8) || 'PC';
}

/**
 * A sliding-window budget. `tryTake()` is false once `perMinute` calls have
 * happened in the last 60 seconds.
 *
 * In production this belongs in shared storage if you run more than one bridge
 * process per streamer — the rate limit is per APP, not per process, and two
 * instances each politely staying under the limit still add up to double it.
 */
function createRateBudget(perMinute, now = () => Date.now()) {
  const hits = []; // in production: a Redis sorted set keyed by app id
  return {
    tryTake() {
      const cutoff = now() - 60_000;
      while (hits.length && hits[0] <= cutoff) hits.shift();
      if (hits.length >= perMinute) return false;
      hits.push(now());
      return true;
    },
    used() {
      return hits.length;
    },
  };
}

/**
 * Run tasks one at a time with a minimum gap, preserving submission order.
 * Chat order matters (a reply must not overtake the message it answers) and
 * ordered writes are also the cheapest way to stay under a rate limit.
 */
function createSerialChain(minGapMs, now = () => Date.now()) {
  let tail = Promise.resolve();
  let lastRunAt = 0;
  return {
    run(task) {
      const next = tail.then(async () => {
        const wait = lastRunAt + minGapMs - now();
        if (wait > 0) await sleep(wait);
        lastRunAt = now();
        return task();
      });
      // Swallow on the chain itself so one failure cannot poison every task
      // queued behind it; the caller still sees its own rejection.
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    drain() {
      return tail;
    },
  };
}

/** A transport failure (DNS, reset, our own 15s timeout) — not an API verdict. */
function isTransportError(err) {
  if (err instanceof PowerChatApiError) return false;
  return err?.name === 'AbortError' || err?.name === 'TypeError' || Boolean(err?.cause);
}

/**
 * Full-jitter exponential backoff.
 *
 * `src/powerchat.js` does not surface response headers, so `Retry-After` and
 * the `RateLimit-*` trio are not visible here — if you fork the client, plumb
 * them through and prefer the server's number to this guess. We do read a
 * retry hint out of the error envelope when one is present.
 */
function backoffDelay(err, attempt) {
  const hinted = Number(err?.details?.retryAfterSeconds ?? err?.details?.retry_after ?? NaN);
  if (Number.isFinite(hinted) && hinted > 0) return Math.min(hinted * 1000, BACKOFF_CAP_MS);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

// ------------------------------------------------------------------- the bridge

/**
 * @param {object} options
 * @param {import('../../src/powerchat').PowerChatClient} options.client
 * @param {string} options.streamer     PowerChat username to mirror into.
 * @param {object} options.site         Anything emitting the site.js events.
 * @param {string[]} options.grantedScopes  From `client.me()` — the truth, not
 *        what you registered. See "registered is not requested" in the README.
 * @param {string} options.publicOrigin Public origin for site-relative avatars.
 * @param {(record: object) => void} [options.log]
 */
function createBridge({
  client,
  streamer,
  site,
  grantedScopes = [],
  publicOrigin = 'https://cdn.example-stream.tv',
  log = () => {},
  now = () => Date.now(),
}) {
  const startedAt = now();
  const granted = new Set(grantedScopes);

  const timeline = [];
  const stats = {
    chat: { seen: 0, sent: 0, deduped: 0, overBudget: 0, failed: 0, confirmed: null },
    viewCount: { posts: 0, failed: 0, lastPosted: null },
    follows: { seen: 0, sent: 0, failed: 0 },
    members: { seen: 0, sent: 0, failed: 0 },
    abandoned: 0,
  };

  /** messageId -> text, for the read-back check. In production this is the
   *  outbound mirror table (unique index on message_id) you already keep so a
   *  restart knows what it has sent. A Map forgets on restart; the DERIVED ids
   *  are what actually make the restart safe, not this. */
  const sentChat = new Map();

  const chatBudget = createRateBudget(CHAT_BUDGET_PER_MIN, now);
  const chatChain = createSerialChain(0, now); // paced by the budget, not a gap
  const durableChain = createSerialChain(DURABLE_MIN_GAP_MS, now);
  /** In production: an `outbox` table with a unique index on (rail, idempotency_key),
   *  drained by a worker. An array loses everything on restart, which is exactly
   *  the failure mode an outbox exists to prevent — so do not ship this part. */
  const outbox = [];

  let liveNow = false;
  let stopping = false;
  let viewCountTimer = null;
  let outboxTimer = null;
  let signalsInstalled = false;

  // view-count state machine
  let viewersNow = 0;
  let lastPostedCount = null;
  let lastPostAt = 0;
  let nextBeatDue = 0;
  let viewCountInFlight = false;

  // ------------------------------------------------------------- capabilities

  const caps = {};
  for (const [key, meta] of Object.entries(MIRRORS)) {
    caps[key] = {
      enabled: granted.has(meta.scope),
      reason: granted.has(meta.scope) ? null : 'scope not granted',
    };
  }

  function record(rail, what, answer) {
    const entry = { t: now() - startedAt, rail, what, answer };
    timeline.push(entry);
    log(entry);
    return entry;
  }

  /**
   * Disable one mirror permanently, and say so ONCE.
   *
   * A 403 here is almost never transient: either the scope was never in the
   * authorize call, or the streamer switched this capability off in their
   * dashboard (which they are encouraged to do — keep the view count, mute the
   * chat). Retrying a 403 per event produces thousands of identical log lines
   * and a rate-limit problem on top of the original one.
   */
  function disable(rail, reason) {
    const cap = caps[rail];
    if (!cap || !cap.enabled) return;
    cap.enabled = false;
    cap.reason = reason;
    record(rail, `mirror disabled — ${MIRRORS[rail].label} will be skipped from here`, reason);
  }

  function capable(rail) {
    return Boolean(caps[rail]?.enabled);
  }

  /** A dead grant is not a per-rail problem; nothing will work until reauth. */
  function disableEverything(reason) {
    for (const rail of Object.keys(MIRRORS)) disable(rail, reason);
  }

  // ------------------------------------------------------------ request plumbing

  /**
   * One PowerChat call with the retry policy this bridge is willing to defend.
   *
   * Retry 429, 5xx and transport failures. NEVER retry another 4xx — a 400 is a
   * malformed payload and a thousand retries make it a thousand malformed
   * payloads. Retrying at all is only safe because every write below carries a
   * stable idempotency key: a timeout is the one case where you genuinely
   * cannot know whether the first attempt landed.
   */
  async function call(rail, fn) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { ok: true, value: await fn() };
      } catch (err) {
        const status = err instanceof PowerChatApiError ? err.status : 0;

        if (status === 401) {
          // The client already refreshed and replayed once. Still 401 means the
          // grant is gone: revoked, or the refresh family was invalidated.
          disableEverything('401 — the grant is no longer valid; re-authorize');
          return { ok: false, err, terminal: true };
        }
        if (status === 403) {
          disable(rail, '403 — missing scope or capability switched off');
          return { ok: false, err, terminal: true };
        }

        const retryable = status === 429 || status >= 500 || isTransportError(err);
        if (!retryable) return { ok: false, err, terminal: true };
        if (attempt >= MAX_ATTEMPTS) return { ok: false, err, terminal: false };
        await sleep(backoffDelay(err, attempt));
      }
    }
  }

  /** Compact rendering of what PowerChat answered, for the timeline. */
  function answerOf(value) {
    if (value === null || value === undefined) return 'ok';
    if (typeof value !== 'object') return String(value);
    return clamp(JSON.stringify(value), 70);
  }

  /**
   * Durable rail: memberships, follows, view counts. Ordered, paced, and on
   * failure parked in the outbox rather than dropped. Chat does NOT come
   * through here — see `mirrorChat`.
   */
  function submitDurable(job) {
    return durableChain.run(async () => {
      // The mirror can be switched off between enqueue and execution — a
      // streamer toggling a capability mid-stream does exactly that.
      if (!capable(job.rail)) {
        job.onSkipped?.();
        return;
      }
      const result = await call(job.rail, job.send);
      if (result.ok) {
        job.onSuccess?.(result.value);
        record(job.rail, job.describe, answerOf(result.value));
        return;
      }
      job.onFailure?.(result.err);
      if (result.terminal) {
        // A 4xx we will never talk our way out of, or a disabled mirror.
        record(job.rail, job.describe, `dropped — ${result.err.message}`);
        stats.abandoned += 1;
        return;
      }
      job.attempts = (job.attempts ?? 0) + 1;
      if (job.attempts >= OUTBOX_MAX_ROUNDS) {
        record(
          job.rail,
          job.describe,
          `abandoned after ${job.attempts} rounds — ${result.err.message}`,
        );
        stats.abandoned += 1;
        return;
      }
      job.notBefore = now() + OUTBOX_RETRY_MS;
      outbox.push(job);
      record(job.rail, job.describe, `outboxed (round ${job.attempts}) — ${result.err.message}`);
    });
  }

  function drainOutbox() {
    if (stopping) return;
    const due = [];
    for (let i = outbox.length - 1; i >= 0; i -= 1) {
      if (outbox[i].notBefore <= now()) due.push(...outbox.splice(i, 1));
    }
    // Re-submitting sends the SAME idempotency key, so a job that actually did
    // land the first time (and only looked like a failure) is deduped server
    // side rather than double-credited.
    for (const job of due.reverse()) submitDurable(job);
  }

  // ------------------------------------------------------------------ mirrors

  function mirrorChat(message) {
    stats.chat.seen += 1;
    if (!capable('chat')) return;

    // ---------------------------------------------------------- the stable id
    //
    // Derived from the SITE's message id, which is unique in the site's own
    // database and identical every time the same message is delivered. Compare:
    //
    //   messageId: randomUUID()            <- new id per attempt
    //   messageId: `ovl:${message.id}`     <- one id per message, forever
    //
    // With the random version, the timeout retry below posts a second copy, the
    // site's at-least-once bus posts a third, and a bridge restart mid-broadcast
    // replays the backlog as a fourth. All four are 202s and all four appear on
    // the overlay. With the derived version every one of those is deduped —
    // once here (cheap) and again by PowerChat (authoritative).
    const messageId = clamp(`ovl:${message.id}`, 128);
    if (sentChat.has(messageId)) {
      stats.chat.deduped += 1;
      record('chat', `duplicate suppressed: ${messageId}`, 'not re-sent');
      return;
    }

    // Chat is metered and DROPPED, not queued. A room doing 400 messages a
    // minute cannot be mirrored 1:1 into a ~120/min budget, and a queue would
    // just make the overlay show messages from four minutes ago. Dropping and
    // counting is the honest failure. Sample by importance if you need better —
    // members and moderators first, for instance.
    if (!chatBudget.tryTake()) {
      stats.chat.overBudget += 1;
      return;
    }

    const user = message.user;
    const avatarUrl = resolveAvatarUrl(user.avatarPath, publicOrigin);
    const payload = {
      chatterName: clamp(user.displayName, 48),
      externalChatterId: clamp(user.id, 128), // the site's user id, not the handle
      message: clamp(message.text, 500),
      messageId,
      // Omit the key entirely rather than send null: an absent avatarUrl uses
      // the fallback, an unfetchable one silently renders a letter anyway.
      ...(avatarUrl ? { avatarUrl } : {}),
      avatarFallback: avatarFallbackFrom(user.displayName, user.handle),
      isModerator: Boolean(user.isModerator),
      // Read live from the site, so someone who subscribed 20 seconds ago is
      // badged correctly. This is a JOIN the endpoint examples cannot show:
      // membership state and chat state are the same integration's problem.
      isSubscriber: site.isMember(user.id),
      occurredAt: message.sentAt,
    };

    // Claim the id BEFORE the send. If the site replays while this request is
    // still in flight we must not race out a second copy.
    sentChat.set(messageId, payload.message);

    return chatChain.run(async () => {
      const result = await call('chat', () => client.sendChat(streamer, payload));
      if (result.ok) {
        stats.chat.sent += 1;
        // 202 is ACCEPTED FOR MODERATION. Not displayed. `verifyChatDelivery()`
        // below is the only way to find out which of these survived.
        record(
          'chat',
          `${payload.chatterName}: ${clamp(payload.message, 42)}`,
          answerOf(result.value),
        );
      } else {
        stats.chat.failed += 1;
        sentChat.delete(messageId); // it never landed; allow a genuine resend
        record(
          'chat',
          `${payload.chatterName}: ${clamp(payload.message, 42)}`,
          `failed — ${result.err.message}`,
        );
      }
    });
  }

  function mirrorFollow(event) {
    stats.follows.seen += 1;
    if (!capable('follows')) return;
    const user = event.user;
    submitDurable({
      rail: 'follows',
      describe: `follow: ${user.displayName}`,
      // Keyed on the site's USER id. A follow is a state, not an occurrence, so
      // this is the right grain: a re-delivered event, a catch-up import, or an
      // unfollow-then-refollow all resolve to the same key and alert once. If
      // your streamers WANT a refollow to alert again, key on the follow row's
      // id instead — but decide deliberately, because that is also how a buggy
      // sync job fires four hundred follow alerts at 3am.
      send: () =>
        client.sendFollow(streamer, {
          followerName: clamp(user.displayName, 48),
          externalId: clamp(`ovl-user:${user.id}`, 128),
          occurredAt: event.followedAt,
        }),
      onSuccess: () => {
        stats.follows.sent += 1;
      },
      onFailure: () => {
        stats.follows.failed += 1;
      },
    });
  }

  function mirrorMembership(event) {
    stats.members.seen += 1;
    if (!capable('members')) return;
    const user = event.user;
    submitDurable({
      rail: 'members',
      describe: `${event.kind === 'renewal' ? 'renewal' : 'new member'}: ${user.displayName} (${event.tier}, ${event.term})`,
      // Keyed per USER **and TERM**. Keying on the user alone is the subtle one:
      // it works perfectly for a month, then every renewal is deduped as
      // "already seen" and the streamer's resub alerts quietly stop forever.
      // The term comes from your billing system — the same value that decides
      // when you charge them again.
      send: () =>
        client.sendSubscription(streamer, {
          subscriberName: clamp(user.displayName, 48),
          externalId: clamp(`ovl-member:${user.id}:${event.term}`, 128),
          tier: clamp(event.tier, 32),
          isGift: false,
          isResub: event.kind === 'renewal',
          occurredAt: event.at,
        }),
      onSuccess: () => {
        stats.members.sent += 1;
      },
      onFailure: () => {
        stats.members.failed += 1;
      },
    });
  }

  function mirrorGift(event) {
    stats.members.seen += 1;
    if (!capable('members')) return;
    submitDurable({
      rail: 'members',
      describe: `gift x${event.count}: ${event.gifter.displayName} (${event.tier}, ${event.term})`,
      // ONE event carrying giftCount — never one per recipient. `subscriberName`
      // is the GIFTER, because that is the name the alert celebrates. Keyed on
      // the gift's own id, so the bomb is credited exactly once even if the
      // payment webhook that triggered it is delivered three times.
      send: () =>
        client.sendSubscription(streamer, {
          subscriberName: clamp(event.gifter.displayName, 48),
          externalId: clamp(`ovl-gift:${event.id}`, 128),
          tier: clamp(event.tier, 32),
          isGift: true,
          giftCount: Math.min(Math.max(event.count, 1), 1000),
          occurredAt: event.at,
        }),
      onSuccess: () => {
        stats.members.sent += 1;
      },
      onFailure: () => {
        stats.members.failed += 1;
      },
    });
  }

  // ------------------------------------------------------- view-count lifecycle

  function postViewCount(count, { reason }) {
    viewCountInFlight = true;
    lastPostAt = now();
    return submitDurable({
      rail: 'viewCount',
      describe: `view count ${count === null ? 'null (stream ended)' : count} (${reason})`,
      send: () => client.setViewCount(streamer, count),
      onSuccess: () => {
        stats.viewCount.posts += 1;
        stats.viewCount.lastPosted = count;
        lastPostedCount = count;
        nextBeatDue = now() + HEARTBEAT_MS;
        viewCountInFlight = false;
      },
      onFailure: () => {
        stats.viewCount.failed += 1;
        // Do NOT pretend the beat happened. Come back quickly — the server
        // expires the count at 90s and we have already burned some of that.
        nextBeatDue = now() + VIEW_COUNT_RETRY_MS;
        viewCountInFlight = false;
      },
      onSkipped: () => {
        viewCountInFlight = false;
      },
    });
  }

  /**
   * The heartbeat, as a 1s state machine rather than a fixed interval, because
   * two different things trigger a post and they need different rules:
   *   - the count CHANGED     → post, but no more often than every 5s
   *   - nothing changed       → post anyway before the 90s freshness window
   */
  function viewCountTick() {
    if (!liveNow || stopping || viewCountInFlight || !capable('viewCount')) return;
    const changed = viewersNow !== lastPostedCount;
    const beatDue = now() >= nextBeatDue;
    const changeDue = changed && now() >= lastPostAt + VIEW_COUNT_MIN_GAP_MS;
    if (!beatDue && !changeDue) return;
    postViewCount(viewersNow, { reason: beatDue && !changed ? 'heartbeat' : 'changed' });
  }

  function onLive() {
    liveNow = true;
    record('bridge', `${site.channel} went live — starting mirrors`, mirrorSummaryLine());
    // Post immediately: the chip should appear when the stream does, not up to
    // 30 seconds later.
    nextBeatDue = 0;
    lastPostAt = 0;
    viewCountTick();
    viewCountTimer ??= setInterval(viewCountTick, 1_000);
    viewCountTimer.unref?.();
    outboxTimer ??= setInterval(drainOutbox, OUTBOX_RETRY_MS);
    outboxTimer.unref?.();
  }

  function onOffline() {
    liveNow = false;
    // The null post is part of shutdown, not of this handler, so that SIGINT and
    // a clean end-of-stream take exactly the same path.
    record('bridge', `${site.channel} went offline`, 'draining');
  }

  function onViewers(event) {
    viewersNow = event.count;
  }

  // -------------------------------------------------------------- wiring / life

  /** A bug in the bridge must never take down the product it mirrors. */
  function safe(name, handler) {
    return (payload) => {
      try {
        handler(payload);
      } catch (err) {
        record('bridge', `handler ${name} threw`, String(err?.message ?? err));
      }
    };
  }

  const handlers = {
    live: safe('live', onLive),
    offline: safe('offline', onOffline),
    viewers: safe('viewers', onViewers),
    chat: safe('chat', mirrorChat),
    follow: safe('follow', mirrorFollow),
    membership: safe('membership', mirrorMembership),
    gift: safe('gift', mirrorGift),
  };

  function mirrorSummaryLine() {
    return Object.entries(MIRRORS)
      .map(([key, meta]) => `${meta.label}:${caps[key].enabled ? 'on' : 'OFF'}`)
      .join('  ');
  }

  function start() {
    for (const [event, handler] of Object.entries(handlers)) site.on(event, handler);
    // Report the scope situation ONCE, at startup, instead of discovering it
    // one 403 per event later.
    for (const [key, meta] of Object.entries(MIRRORS)) {
      if (!caps[key].enabled) {
        record(
          key,
          `${meta.label} mirror off — ${meta.scope} not granted`,
          'logged once, not retried',
        );
      }
    }
    if (!granted.has('chat:read')) {
      record(
        'bridge',
        'chat:read not granted — cannot verify what moderation kept',
        'read-back disabled',
      );
    }
    record('bridge', 'bridge attached', mirrorSummaryLine());
    return bridge;
  }

  /**
   * Read chat back and report how many mirrored messages ACTUALLY landed.
   *
   * This is the honest half of `POST /chat`. Every send above answered 202,
   * which means accepted for moderation — blocked words, blocked chatters, AI
   * moderation and duplicate-id rejection all run afterwards and drop messages
   * with no callback. If your product promises "your chat appears on the
   * overlay", this read is the only thing that can tell you whether it does.
   */
  async function verifyChatDelivery({ limit = 100 } = {}) {
    if (!granted.has('chat:read')) {
      return { checked: false, reason: 'chat:read not granted' };
    }
    const result = await call('bridge', () => client.chatHistory(streamer, { limit }));
    if (!result.ok) return { checked: false, reason: result.err.message };

    const rows = asList(result.value);
    const seenIds = new Set(rows.map((row) => row.messageId).filter(Boolean));
    const seenText = new Set(rows.map((row) => row.message).filter(Boolean));
    const missing = [];
    for (const [messageId, text] of sentChat) {
      // Match on the id, falling back to the text, so this still reports
      // something useful on a deployment that does not echo messageId back.
      if (!seenIds.has(messageId) && !seenText.has(text)) missing.push({ messageId, text });
    }
    const confirmed = sentChat.size - missing.length;
    stats.chat.confirmed = confirmed;
    record(
      'bridge',
      `chat read-back: ${confirmed}/${sentChat.size} mirrored messages are in history`,
      missing.length ? `${missing.length} not displayed` : 'all displayed',
    );
    return { checked: true, sent: sentChat.size, confirmed, missing, historySize: rows.length };
  }

  /**
   * Stop cleanly: detach from the site, let in-flight work finish, then tell
   * PowerChat the stream ended.
   *
   * `count: null` means ENDED. `count: 0` means live with an empty room and
   * keeps the chip on screen for up to 90 more seconds — which is how a
   * finished stream ends up advertising zero viewers on the streamer's page.
   */
  async function shutdown(reason = 'shutdown') {
    if (stopping) return stats;
    stopping = true;
    for (const [event, handler] of Object.entries(handlers)) site.off(event, handler);
    if (viewCountTimer) clearInterval(viewCountTimer);
    if (outboxTimer) clearInterval(outboxTimer);
    viewCountTimer = null;
    outboxTimer = null;
    record('bridge', `shutting down (${reason})`, `${outbox.length} job(s) still in the outbox`);

    // Bounded drain. A shutdown that waits forever for a wedged request is a
    // shutdown that gets SIGKILLed, and SIGKILL never posts the null.
    await Promise.race([Promise.all([chatChain.drain(), durableChain.drain()]), sleep(5_000)]);

    if (capable('viewCount') && stats.viewCount.posts > 0) {
      stopping = false; // let this last job through the durable rail
      await postViewCount(null, { reason: 'stream ended' });
      stopping = true;
    }
    if (outbox.length) {
      // Say it out loud. These are events the streamer's overlay never saw.
      record(
        'bridge',
        `${outbox.length} job(s) abandoned in memory`,
        'a real outbox is a table; these would survive',
      );
      stats.abandoned += outbox.length;
    }
    return stats;
  }

  /**
   * SIGINT/SIGTERM → the same shutdown path as a normal end of stream, so the
   * heartbeat stops and the null gets posted even when someone Ctrl-Cs a live
   * broadcast. `once` so a second Ctrl-C is not swallowed: if the drain hangs,
   * the operator can still kill it.
   */
  function installSignalHandlers({ onDone } = {}) {
    if (signalsInstalled) return bridge;
    signalsInstalled = true;
    const handle = (signal) => {
      process.once(signal, () => {
        shutdown(signal)
          .catch(() => {})
          .then(() => onDone?.(signal));
      });
    };
    handle('SIGINT');
    handle('SIGTERM');
    return bridge;
  }

  const bridge = {
    start,
    shutdown,
    installSignalHandlers,
    verifyChatDelivery,
    timeline,
    stats,
    caps,
    get outboxDepth() {
      return outbox.length;
    },
  };
  return bridge;
}

module.exports = {
  createBridge,
  resolveAvatarUrl,
  avatarFallbackFrom,
  createRateBudget,
  createSerialChain,
  backoffDelay,
  clamp,
  SCOPES_USED,
  MIRRORS,
  HEARTBEAT_MS,
  CHAT_BUDGET_PER_MIN,
};
