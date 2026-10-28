'use strict';
/**
 * PowerChat Developer API client — the whole REST + SSE surface in one file.
 *
 * Deliberately dependency-free: Node 22 built-ins only (`fetch`, `crypto`).
 * Clone the repo, set a few env vars, run it. Nothing to install, nothing to
 * keep up to date, and every line is readable in one sitting.
 *
 * Two directions, mirroring how PowerChat itself is organised:
 *   PLATFORM     — your app sends data INTO PowerChat (chat, view counts,
 *                  subs, follows, virtual currency, tips). Your app behaves
 *                  like Twitch or Kick does.
 *   INTEGRATION  — your app receives data OUT of PowerChat (webhooks, the SSE
 *                  gateway, reads) and triggers display-only alerts.
 *
 * Every 2xx REST body is `{ "data": <payload> }`; this client unwraps `data`
 * for you and throws `PowerChatApiError` on anything else, so callers deal in
 * plain objects.
 */

const DEFAULT_BASE_URL = 'https://powerchat.live';
const REQUEST_TIMEOUT_MS = 15_000;

/** Thrown for any non-2xx response. `code` is PowerChat's machine-readable error code. */
class PowerChatApiError extends Error {
  constructor(status, code, message, details) {
    super(`[${status}${code ? ' ' + code : ''}] ${message}`);
    this.name = 'PowerChatApiError';
    this.status = status;
    this.code = code ?? null;
    this.details = details ?? null;
  }
  /** 401 means refresh or re-authorize; 403 means a missing scope or a disabled capability. */
  get isAuthProblem() {
    return this.status === 401 || this.status === 403;
  }
  /** 429 and 5xx are worth retrying with backoff; 4xx is not. */
  get isRetryable() {
    return this.status === 429 || this.status >= 500;
  }
}

class PowerChatClient {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]      PowerChat host (default https://powerchat.live).
   * @param {string} [options.accessToken]  OAuth access token for this streamer.
   * @param {() => Promise<string>} [options.getAccessToken]
   *        Called when a request needs a token, and again after a 401 so a
   *        refresh can happen transparently. Prefer this over `accessToken`.
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this._accessToken = options.accessToken ?? null;
    this._getAccessToken = options.getAccessToken ?? null;
    this._retriedAfter401 = false;
  }

  // ---------------------------------------------------------------- internals

  async _token(forceRefresh = false) {
    if (this._getAccessToken) return this._getAccessToken(forceRefresh);
    if (!this._accessToken) throw new Error('No access token configured');
    return this._accessToken;
  }

  /**
   * One request. Retries ONCE on 401 with a forced token refresh, because an
   * access token expiring mid-session is routine, not an error worth surfacing.
   */
  async _request(method, path, { query, body, headers, retryOn401 = true } = {}) {
    const url = new URL(this.baseUrl + '/api/dev/v1' + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const token = await this._token(false);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 && retryOn401 && this._getAccessToken) {
      await this._token(true); // force a refresh, then replay once
      return this._request(method, path, { query, body, headers, retryOn401: false });
    }

    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body — handled below */
    }

    if (!res.ok) {
      const err = parsed?.error ?? {};
      throw new PowerChatApiError(
        res.status,
        err.code,
        err.message || `Request failed: ${method} ${path}`,
        err.errors ?? null,
      );
    }
    // Every 2xx REST body is `{ data: … }`. POST /chat answers 202 with
    // `{ data: { accepted: true } }` — accepted for moderation, NOT displayed.
    return parsed?.data ?? null;
  }

  // ------------------------------------------------------------------- reads

  /** Which streamer this token belongs to, and the scopes actually granted. */
  me() {
    return this._request('GET', '/me');
  }

  /** Public profile + live status. */
  profile(username) {
    return this._request('GET', `/streamers/${encodeURIComponent(username)}/profile`);
  }

  /**
   * Confirmed donations (censored message text), cursor-paginated.
   * Resolves `{ rows, nextCursor }` — pass `nextCursor` back as `cursor`
   * until it comes back null. Each row carries `appExternalRef`, the `ref`
   * you minted on the checkout link, so this doubles as a reconciliation
   * channel if a webhook was ever missed.
   */
  paidMessages(username, { limit, cursor } = {}) {
    return this._request('GET', `/streamers/${encodeURIComponent(username)}/paid-messages`, {
      query: { limit, cursor },
    });
  }

  /** Recent unified chat — every platform merged, newest last. */
  chatHistory(username, { limit } = {}) {
    return this._request('GET', `/streamers/${encodeURIComponent(username)}/chat/history`, {
      query: { limit },
    });
  }

  /** Read back the overlay blob your app previously stored. */
  getOverlaySession(username) {
    return this._request('GET', `/streamers/${encodeURIComponent(username)}/overlay-session`);
  }

  // -------------------------------------------------- PLATFORM (data goes IN)

  /**
   * Send a chat message into the unified overlay.
   *
   * Answers 202 `{ accepted: true }` — ACCEPTED, not displayed. The message
   * still runs the streamer's moderation pipeline (blocks, AI moderation,
   * profanity, duplicate `messageId`) and can be dropped afterwards with no
   * per-message callback. To confirm display, read `chatHistory()` back.
   */
  sendChat(username, message) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/chat`, {
      body: message,
    });
  }

  /**
   * Report your viewer count. `count: null` means the stream ended.
   * Re-post at least every 90s while live — a freshness sweep clears stale
   * counts and the chip drops to 0 until your next report.
   */
  setViewCount(username, count) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/view-count`, {
      body: { count },
    });
  }

  /** A membership on your platform → sub alert + goal/subathon credit. */
  sendSubscription(username, subscription) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/subscriptions`, {
      body: subscription,
    });
  }

  /** A new follower on your platform → follow alert + follow-goal credit. */
  sendFollow(username, follow) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/follows`, {
      body: follow,
    });
  }

  /**
   * A redemption in one of your DECLARED virtual currencies (never real money)
   * → alert + leaderboard credit.
   */
  sendCurrencyEvent(username, event) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/currency-events`, {
      body: event,
    });
  }

  /**
   * A MONETARY tip in a declared currency that carries a `unitsPerUsd` rate
   * (bit-style: e.g. 100 units = $1). Converted to USD server-side; credits
   * tip goals, subathon time, and tip totals — never leaderboards.
   */
  sendTip(username, tip) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/tips`, { body: tip });
  }

  // ------------------------------------------- INTEGRATION (data comes OUT)

  /** Fire a display-only TEST alert. Never credits goals or leaderboards. */
  testAlert(username, alert) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/test-alerts`, {
      body: alert,
    });
  }

  /** Display-only custom alert (your own copy on the overlay). */
  customAlert(username, alert) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/alerts/custom`, {
      body: alert,
    });
  }

  /** Display-only RICH alert — image + effect + colors. */
  richAlert(username, alert) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/alerts/rich`, {
      body: alert,
    });
  }

  /** Store a short-TTL JSON blob your own overlay can read back. */
  putOverlaySession(username, data, ttlSeconds) {
    return this._request('POST', `/streamers/${encodeURIComponent(username)}/overlay-session`, {
      body: { data, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) },
    });
  }

  /**
   * Mint a tip-page link for a viewer — ALWAYS through this call when you
   * need to know who paid.
   *
   * Every call mints a CHECKOUT INTENT server-side — with or without terms —
   * and the returned URL carries an opaque `app_intent` token. `ref` is your
   * own correlation id (≤128 chars — a user id, an order id). Because the ref
   * was pinned server-side at mint time, it comes back AUTHORITATIVELY as
   * `appExternalRef` on the `donation.completed` webhook and on
   * `paidMessages()` — scoped so only your app ever sees your refs, and it
   * survives an anonymous tip.
   *
   * DO NOT hand-build `…/tip?app_client_id=…&app_ref=…` when you need
   * correlation. That link travels through the viewer's browser, so the
   * viewer (or anyone they share it with) can swap `app_ref` for someone
   * else's order id and your webhook handler would credit the wrong account.
   * PowerChat therefore treats a hand-built ref as UNTRUSTED input: it is NOT
   * surfaced as `appExternalRef`. Only a server-minted intent is.
   *
   * With `amountCents` / `purpose` / `redirectUri` the intent also pins those
   * terms: the tip page renders the amount read-only and refuses a submit that
   * does not match. Intents are single-use and expire after one hour — mint a
   * fresh link per viewer journey, never cache one for two people.
   */
  tipCheckoutLink(username, { ref, redirectUri, amountCents, purpose } = {}) {
    return this._request('GET', `/streamers/${encodeURIComponent(username)}/tip-checkout-link`, {
      query: {
        ref,
        redirect_uri: redirectUri,
        amount_cents: amountCents,
        purpose,
      },
    });
  }

  // -------------------------------------------- BOT, WIDGETS, VIEWER DATA

  _streamer(username, path) {
    return `/streamers/${encodeURIComponent(username)}/${path}`;
  }

  /** Post through the streamer's bot; replyTo targets one chat message. */
  botMessage(username, message) {
    return this._request('POST', this._streamer(username, 'bot/messages'), { body: message });
  }

  /** Run one line from your platform and get the bot's reply without posting it. */
  botRun(username, line) {
    return this._request('POST', this._streamer(username, 'bot/run'), { body: line });
  }

  /** List commands owned by this app. */
  botCommands(username) {
    return this._request('GET', this._streamer(username, 'bot/commands'));
  }

  /** Register a template command, or omit response for an app-answered command. */
  putBotCommand(username, name, command) {
    return this._request('PUT', this._streamer(username, `bot/commands/${encodeURIComponent(name)}`), { body: command });
  }

  /** Remove one command owned by this app. */
  deleteBotCommand(username, name) {
    return this._request('DELETE', this._streamer(username, `bot/commands/${encodeURIComponent(name)}`));
  }

  /** Read the channel's public variables. */
  variables(username) {
    return this._request('GET', this._streamer(username, 'variables'));
  }

  /** Replace a variable with { value }, or atomically add { increment }. */
  putVariable(username, key, change) {
    return this._request('PUT', this._streamer(username, `variables/${encodeURIComponent(key)}`), { body: change });
  }

  /** Remove a channel variable. */
  deleteVariable(username, key) {
    return this._request('DELETE', this._streamer(username, `variables/${encodeURIComponent(key)}`));
  }

  /** Deliver { name, data } to the streamer's open custom widgets. */
  widgetEvent(username, event) {
    return this._request('POST', this._streamer(username, 'widget-events'), { body: event });
  }

  /** List the channel's readable stat definitions. */
  stats(username) { return this._request('GET', this._streamer(username, 'stats')); }
  /** Declare or replace an app-owned stat, including earn rules and levels. */
  putStat(username, key, definition) {
    return this._request('PUT', this._streamer(username, `stats/${encodeURIComponent(key)}`), { body: definition });
  }
  /** Remove an app-owned stat. */
  deleteStat(username, key) {
    return this._request('DELETE', this._streamer(username, `stats/${encodeURIComponent(key)}`));
  }
  /** Ranked viewers for one stat. */
  leaderboard(username, key, query = {}) {
    return this._request('GET', this._streamer(username, `stats/${encodeURIComponent(key)}/leaderboard`), { query });
  }
  /** List readable item definitions. */
  items(username) { return this._request('GET', this._streamer(username, 'items')); }
  /** Declare or replace an app-owned item, bundle or loot crate. */
  putItem(username, key, definition) {
    return this._request('PUT', this._streamer(username, `items/${encodeURIComponent(key)}`), { body: definition });
  }
  /** Remove an app-owned item definition. */
  deleteItem(username, key) {
    return this._request('DELETE', this._streamer(username, `items/${encodeURIComponent(key)}`));
  }
  /** Ranked holders of one item. */
  itemHolders(username, key, query = {}) {
    return this._request('GET', this._streamer(username, `items/${encodeURIComponent(key)}/holders`), { query });
  }
  /** One viewer's stats, levels, ranks and inventory. */
  viewer(username, platform, viewerId) {
    return this._request('GET', this._streamer(username, `viewers/${encodeURIComponent(platform)}/${encodeURIComponent(viewerId)}`));
  }
  /** Apply up to 100 stat, item or craft operations atomically. Reuse the key on retries. */
  transaction(username, operations, idempotencyKey) {
    return this._request('POST', this._streamer(username, 'transactions'), {
      body: { operations },
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    });
  }
  /** List readable queue and raffle definitions. */
  lists(username) { return this._request('GET', this._streamer(username, 'lists')); }
  /** Declare an app-owned list. */
  putList(username, key, definition) {
    return this._request('PUT', this._streamer(username, `lists/${encodeURIComponent(key)}`), { body: definition });
  }
  /** Remove an app-owned list. */
  deleteList(username, key) {
    return this._request('DELETE', this._streamer(username, `lists/${encodeURIComponent(key)}`));
  }
  /** Read entries in a list. */
  listEntries(username, key, query = {}) {
    return this._request('GET', this._streamer(username, `lists/${encodeURIComponent(key)}/entries`), { query });
  }
  /** Add an entry; reuse idempotencyKey on retries. */
  addListEntry(username, key, entry, idempotencyKey) {
    return this._request('POST', this._streamer(username, `lists/${encodeURIComponent(key)}/entries`), {
      body: entry, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    });
  }
  /** Remove one list entry by id. */
  removeListEntry(username, key, id) {
    return this._request('DELETE', this._streamer(username, `lists/${encodeURIComponent(key)}/entries/${encodeURIComponent(id)}`));
  }
  /** Pop the next count entries, up to 25. */
  nextListEntry(username, key, count = 1) {
    return this._request('POST', this._streamer(username, `lists/${encodeURIComponent(key)}/next`), { body: { count } });
  }
  /** Draw one entry, optionally leaving it in the list. */
  drawListEntry(username, key, remove = true) {
    return this._request('POST', this._streamer(username, `lists/${encodeURIComponent(key)}/draw`), { body: { remove } });
  }
  /** List readable rewards. */
  rewards(username) { return this._request('GET', this._streamer(username, 'rewards')); }
  /** Declare an app-owned reward. */
  putReward(username, key, definition) {
    return this._request('PUT', this._streamer(username, `rewards/${encodeURIComponent(key)}`), { body: definition });
  }
  /** Remove an app-owned reward. */
  deleteReward(username, key) {
    return this._request('DELETE', this._streamer(username, `rewards/${encodeURIComponent(key)}`));
  }
  /** Redeem a reward for a viewer; reuse idempotencyKey on retries. */
  redeemReward(username, key, redemption, idempotencyKey) {
    return this._request('POST', this._streamer(username, `rewards/${encodeURIComponent(key)}/redeem`), {
      body: redemption, headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    });
  }
  /** List reward redemptions with optional filters and cursor. */
  redemptions(username, query = {}) {
    return this._request('GET', this._streamer(username, 'redemptions'), { query });
  }
  /** Resolve one redemption. */
  resolveRedemption(username, id, resolution) {
    return this._request('POST', this._streamer(username, `redemptions/${encodeURIComponent(id)}`), { body: resolution });
  }
  /** List this app's transactions. */
  ledger(username, query = {}) {
    return this._request('GET', this._streamer(username, 'ledger'), { query });
  }

  _documentPath(scope, collection, key, username, platform, viewerId) {
    const prefix = scope === 'app' ? '/app' : this._streamer(username, 'documents');
    const owner = scope === 'app' ? '' : scope === 'viewer'
      ? `/viewer/${encodeURIComponent(platform)}/${encodeURIComponent(viewerId)}`
      : '/channel';
    return `${prefix}${scope === 'app' ? '/documents' : ''}${owner}/${encodeURIComponent(collection)}${key === undefined ? '' : '/' + encodeURIComponent(key)}`;
  }
  /** Query documents in channel, viewer or app scope. */
  documents(scope, collection, { username, query = {} } = {}) {
    return this._request('GET', this._documentPath(scope, collection, undefined, username), { query });
  }
  /** Read one app-owned document. For viewer scope pass platform and viewerId. */
  getDocument(scope, collection, key, { username, platform, viewerId } = {}) {
    return this._request('GET', this._documentPath(scope, collection, key, username, platform, viewerId));
  }
  /** Save JSON, with ifVersion for a conditional write (0 means create only). */
  putDocument(scope, collection, key, document, { username, platform, viewerId } = {}) {
    return this._request('PUT', this._documentPath(scope, collection, key, username, platform, viewerId), { body: document });
  }
  /** Atomically set, increment or unset top-level fields. */
  patchDocument(scope, collection, key, change, { username, platform, viewerId } = {}) {
    return this._request('PATCH', this._documentPath(scope, collection, key, username, platform, viewerId), { body: change });
  }
  /** Remove an app-owned document. */
  deleteDocument(scope, collection, key, { username, platform, viewerId } = {}) {
    return this._request('DELETE', this._documentPath(scope, collection, key, username, platform, viewerId));
  }

  /**
   * Open the SSE gateway — the same machinery PowerChat's own overlays use,
   * with Last-Event-ID replay on reconnect.
   *
   * Needs `stream:read`; the `chat` topic additionally needs `chat:read`.
   * Use this for high-frequency live data and webhooks for must-not-miss
   * events. Returns `{ close() }`; `onEvent({ type, data, id })` per event.
   *
   * TOPIC NAMES ARE NOT EVENT NAMES. You subscribe with topics (`chat`,
   * `view-count`, `goal`, …) but each frame's `type` is the event name the
   * server emits on that topic: the `chat` topic delivers `chat.message`, the
   * `view-count` topic delivers `view-count.updated`. Switch on the event
   * name, not the topic you asked for.
   *
   * `onClose()` fires when the server ends the stream cleanly (no error).
   * A long-lived consumer should reconnect from there too, with the last id.
   */
  async openStream(username, { topics = ['chat'], onEvent, onError, onClose, lastEventId } = {}) {
    const url = new URL(
      this.baseUrl + `/api/dev/v1/streamers/${encodeURIComponent(username)}/stream`,
    );
    url.searchParams.set('topics', topics.join(','));
    const token = await this._token(false);
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new PowerChatApiError(res.status, null, 'Could not open the event stream');
        }
        // Minimal SSE framing: events are separated by a blank line; we care
        // about the `event:`, `data:` and `id:` fields.
        let buffer = '';
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            let type = 'message';
            let id;
            const dataLines = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith(':')) continue; // heartbeat comment
              if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('id:')) id = line.slice(3).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            if (!dataLines.length) continue;
            let data = dataLines.join('\n');
            try {
              data = JSON.parse(data);
            } catch {
              /* leave as text */
            }
            onEvent?.({ type, data, id });
          }
        }
        // The read loop ended without throwing: the server closed the stream
        // (deploy, idle policy). Not an error — but not "done" either.
        if (!controller.signal.aborted) onClose?.();
      } catch (err) {
        if (err.name !== 'AbortError') onError?.(err);
      }
    })();

    return { close: () => controller.abort() };
  }
}

module.exports = { PowerChatClient, PowerChatApiError, DEFAULT_BASE_URL };
