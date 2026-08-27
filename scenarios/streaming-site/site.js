'use strict';
/**
 * site.js — the "your existing product" half of this scenario.
 *
 * A deliberately generic model of an independent live-streaming site: one
 * channel, concurrent viewers, a chat room, followers, and paid memberships.
 * It knows NOTHING about PowerChat — no imports, no PowerChat vocabulary, no
 * PowerChat ids. That separation is the whole point: your product keeps its own
 * model and its own identifiers, and `bridge.js` translates. When you adapt
 * this scenario you delete this file and subscribe the bridge to whatever your
 * real system already emits.
 *
 * Everything here is in memory. In production every collection below is a
 * table, and the unique indexes are not incidental — they are what make the ids
 * stable enough for the bridge to derive PowerChat idempotency keys from them:
 *
 *   chat_messages   unique index on id
 *   follows         unique index on (channel_id, user_id)
 *   memberships     unique index on (channel_id, user_id, term)
 *   gifts           unique index on id
 *   viewer_sessions (no index needed — the bridge only ever reads a count)
 *
 * Events, emitted synchronously on a plain EventEmitter:
 *   'live'        { channel, sessionId, startedAt }
 *   'offline'     { channel, sessionId, endedAt, peakViewers }
 *   'viewers'     { count }                                  on every join/leave
 *   'chat'        { id, user, text, sentAt, replay }
 *   'follow'      { user, followedAt }
 *   'membership'  { id, user, tier, term, kind, at }         kind: 'new' | 'renewal'
 *   'gift'        { id, gifter, tier, term, count, recipients, at }
 *
 * The bus is AT-LEAST-ONCE, like every real internal event bus: `replayRecentChat`
 * exists precisely so the bridge has to prove it survives a duplicate delivery.
 */
const { EventEmitter } = require('node:events');

/**
 * A fixture cast. Each row exists to exercise a different avatar shape the
 * bridge has to cope with — a real site has all five, usually without realising
 * it, and PowerChat's response to a bad one is a silent letter placeholder
 * rather than an error.
 */
const PEOPLE = [
  // 1. the ordinary case: a path relative to the site's own CDN.
  {
    id: 'u_1041',
    handle: 'novarain',
    displayName: 'Nova Rain',
    avatarPath: '/media/avatars/u_1041.png',
  },
  // 2. a display name carrying a role TAG. Naive initials give "[M".
  {
    id: 'u_2277',
    handle: 'pixelfox',
    displayName: '[MOD] pixel fox',
    avatarPath: '/media/avatars/u_2277.png',
    isModerator: true,
  },
  // 3. no avatar at all — most sites have plenty of these.
  { id: 'u_3310', handle: 'quietkettle', displayName: 'quiet kettle', avatarPath: null },
  // 4. an inlined data: URI. Absolute, valid on your own page, useless to PowerChat.
  {
    id: 'u_4102',
    handle: 'hexwright',
    displayName: '(VIP) Hex Wright',
    avatarPath: 'data:image/png;base64,iVBORw0KGgo=',
  },
  // 5. an absolute URL left pointing at a dev host. Passes "is it absolute?" and
  //    is still unreachable from PowerChat's renderer.
  {
    id: 'u_5589',
    handle: 'tapelooper',
    displayName: 'tape looper',
    avatarPath: 'http://localhost:8080/media/avatars/u_5589.png',
  },
  // 6. already absolute and public — pass it straight through.
  {
    id: 'u_6634',
    handle: 'saltmarsh',
    displayName: '★ saltmarsh',
    avatarPath: 'https://images.example-stream.tv/a/u_6634.webp',
  },
];

/** Memberships are billed per TERM. Your billing system already has this value. */
function currentTerm(at = new Date()) {
  return at.toISOString().slice(0, 7); // e.g. 2026-08
}

function createSite({ channel = 'aurora_fm' } = {}) {
  const bus = new EventEmitter();

  // One id per BROADCAST. Message ids are namespaced under it, so they are
  // unique in the site's database forever, and — critically — identical across
  // a crash and restart of the bridge within the same broadcast. That is what
  // makes replay safe. It also means re-running this demo mints fresh ids, so
  // the second run is not silently deduped away by the first.
  const sessionId = `bcast_${Date.now().toString(36)}`;

  const people = new Map(PEOPLE.map((p) => [p.id, { ...p }]));
  const viewers = new Set();
  const followers = new Set();
  const memberships = new Map(); // userId -> Set<term>
  const chatLog = [];

  let messageSeq = 0;
  let giftSeq = 0;
  let live = false;
  let peakViewers = 0;

  function user(id) {
    const found = people.get(id);
    if (!found) throw new Error(`unknown site user: ${id}`);
    return found;
  }

  function announceViewers() {
    peakViewers = Math.max(peakViewers, viewers.size);
    bus.emit('viewers', { count: viewers.size });
  }

  const site = {
    channel,
    sessionId,
    bus,
    on(event, handler) {
      bus.on(event, handler);
      return site;
    },
    off(event, handler) {
      bus.off(event, handler);
      return site;
    },
    get isLive() {
      return live;
    },
    get viewerCount() {
      return viewers.size;
    },
    get peakViewers() {
      return peakViewers;
    },
    user,
    /** Drives the `isSubscriber` badge the bridge puts on mirrored chat. */
    isMember(userId) {
      return (memberships.get(userId)?.size ?? 0) > 0;
    },

    goLive() {
      if (live) return;
      live = true;
      bus.emit('live', { channel, sessionId, startedAt: new Date().toISOString() });
    },

    goOffline() {
      if (!live) return;
      live = false;
      viewers.clear();
      bus.emit('offline', {
        channel,
        sessionId,
        endedAt: new Date().toISOString(),
        peakViewers,
      });
    },

    join(userId) {
      user(userId);
      if (viewers.has(userId)) return;
      viewers.add(userId);
      announceViewers();
    },

    leave(userId) {
      if (!viewers.delete(userId)) return;
      announceViewers();
    },

    /** Post a chat message. The returned id is the site's permanent id for it. */
    say(userId, text) {
      messageSeq += 1;
      const message = {
        id: `${sessionId}:msg:${String(messageSeq).padStart(6, '0')}`,
        user: user(userId),
        text,
        sentAt: new Date().toISOString(),
        replay: false,
      };
      chatLog.push(message);
      bus.emit('chat', message);
      return message;
    },

    follow(userId) {
      const who = user(userId);
      // The site's own table would reject the second insert. The BUS still
      // delivers twice under retry, which is why the bridge must be idempotent
      // rather than trusting this check.
      followers.add(userId);
      const event = { user: who, followedAt: new Date().toISOString() };
      bus.emit('follow', event);
      return event;
    },

    /**
     * Start or renew a paid membership. `kind` is derived from whether this
     * viewer has ever held one — that distinction is display-only downstream,
     * but getting it wrong announces a loyal member's twelfth month as if they
     * had just arrived.
     */
    subscribe(userId, { tier = 'Supporter', term = currentTerm() } = {}) {
      const who = user(userId);
      const terms = memberships.get(userId) ?? new Set();
      const kind = terms.size === 0 ? 'new' : 'renewal';
      terms.add(term);
      memberships.set(userId, terms);
      const event = {
        id: `member:${userId}:${term}`,
        user: who,
        tier,
        term,
        kind,
        at: new Date().toISOString(),
      };
      bus.emit('membership', event);
      return event;
    },

    /**
     * A gift bomb: one gifter, N recipients, ONE event.
     *
     * The site records N membership rows internally but deliberately does NOT
     * emit N 'membership' events, because on the streamer's side this was one
     * action by one person. Emitting per recipient is how integrations credit a
     * sub goal five times for a single gift bomb. Next month's renewals for
     * those recipients are ordinary 'membership' events again.
     */
    giftMemberships(gifterId, { count = 1, tier = 'Supporter', term = currentTerm() } = {}) {
      const gifter = user(gifterId);
      const recipients = [];
      for (const person of people.values()) {
        if (recipients.length >= count) break;
        if (person.id === gifterId) continue;
        const terms = memberships.get(person.id) ?? new Set();
        if (terms.has(term)) continue;
        terms.add(term);
        memberships.set(person.id, terms);
        recipients.push(person);
      }
      giftSeq += 1;
      const event = {
        id: `${sessionId}:gift:${String(giftSeq).padStart(4, '0')}`,
        gifter,
        tier,
        term,
        count, // what the gifter paid for, even if the fixture ran out of people
        recipients,
        at: new Date().toISOString(),
      };
      bus.emit('gift', event);
      return event;
    },

    /**
     * Re-emit the last N chat messages with `replay: true`.
     *
     * This is not a toy: it is what a catch-up job does after the bridge
     * crashes, and what an at-least-once bus does on its own during a partition.
     * The ids are unchanged, which is the entire reason the bridge can tolerate
     * it. Run this against a bridge that mints random message ids and the
     * streamer sees every line twice.
     */
    replayRecentChat(n = 3) {
      const slice = chatLog.slice(-n);
      for (const message of slice) bus.emit('chat', { ...message, replay: true });
      return slice.length;
    },

    snapshot() {
      return {
        channel,
        sessionId,
        live,
        viewers: viewers.size,
        peakViewers,
        followers: followers.size,
        members: [...memberships.entries()].filter(([, t]) => t.size > 0).length,
        chatMessages: chatLog.length,
      };
    },
  };

  return site;
}

module.exports = { createSite, currentTerm, PEOPLE };
