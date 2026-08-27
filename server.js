'use strict';
/**
 * The runnable demo — a zero-dependency `node:http` server that connects a
 * streamer over OAuth, receives signed webhooks, and drives the Developer API
 * from the page in `public/`.
 *
 * Everything lives in memory on purpose: restart the process and the
 * connection is gone. That is also the first thing to change in a real
 * integration — persist the token set (access token, refresh token, scopes,
 * expiry, streamer) per streamer in a database, and write the rotated refresh
 * token BEFORE you use the new access token. Refresh tokens rotate on every
 * use, and replaying an already-rotated one revokes the whole family.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { config } = require('./src/config');
const { PowerChatClient, PowerChatApiError } = require('./src/powerchat');
const {
  createPkcePair,
  createState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
} = require('./src/oauth');
const { verifyWebhook, createDeliveryDeduper, dispatchEvent } = require('./src/webhooks');

/**
 * REGISTERED IS NOT REQUESTED.
 *
 * A scope your app is registered for does nothing until it appears in the
 * `scope=` parameter of THIS authorize call and the streamer consents to it.
 * The classic bug: you add `chat:write` to the app in the dashboard, never
 * widen the authorize request, and every intake call 403s while the dashboard
 * insists you have the scope. `GET /me` shows the truth.
 *
 * The demo asks for everything so every button on the page can work. A real
 * app should ask for the narrowest set it needs — the consent screen lists
 * each one, and a long list costs you connections.
 */
const SCOPES = [
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
  'webhooks:events',
];

const WEBHOOK_PATH = '/webhooks/powerchat';
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_EVENTS = 50;
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// The callback route is derived from POWERCHAT_REDIRECT_URI so the two can
// never disagree — PowerChat matches redirect URIs EXACTLY (scheme, host,
// port, path, query), so a route that drifts from the registered URI is an
// invalid_grant you will spend an afternoon on.
const CALLBACK_PATH = (() => {
  try {
    return new URL(config.redirectUri).pathname;
  } catch {
    return '/oauth/callback';
  }
})();

// ---------------------------------------------------------------- app state

/** state -> { codeVerifier, createdAt }. Never send a verifier to the browser. */
const pendingAuthorizations = new Map();

/**
 * The connected streamer. Seeded from .env so the server is useful before you
 * click Connect (and so the headless example scripts and this server can share
 * one grant). `expiresAt: null` means "unknown" — we then let the first 401
 * drive the refresh rather than guessing.
 */
const session = {
  tokens: config.accessToken
    ? {
        accessToken: config.accessToken,
        refreshToken: config.refreshToken || null,
        scopes: [],
        expiresAt: null,
      }
    : null,
  streamer: config.streamer || null,
  scopes: [],
  connectedAt: config.accessToken ? new Date().toISOString() : null,
  source: config.accessToken ? 'env' : null,
};

const recentEvents = [];
const deduper = createDeliveryDeduper();
let refreshInFlight = null;

/**
 * Hand the client a token, refreshing when we know it is stale or when a 401
 * asked us to. The client calls this again with `forceRefresh` after a 401, so
 * expiry is only ever an optimization — a token can be rejected before its
 * clock-based expiry (consent changes, credential rotation).
 */
async function getAccessToken(forceRefresh = false) {
  if (!session.tokens) {
    throw new Error('No streamer connected yet — open /connect first.');
  }
  const clockExpired =
    typeof session.tokens.expiresAt === 'number' && Date.now() >= session.tokens.expiresAt;
  if (!forceRefresh && !clockExpired) return session.tokens.accessToken;
  if (!session.tokens.refreshToken) return session.tokens.accessToken;

  // Collapse concurrent refreshes: two parallel requests both hitting 401
  // would otherwise rotate twice, and the second rotation invalidates the
  // first — reuse detection treats that as a stolen token.
  if (!refreshInFlight) {
    refreshInFlight = refreshTokens({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: session.tokens.refreshToken,
    })
      .then((next) => {
        session.tokens = {
          ...next,
          scopes: next.scopes.length ? next.scopes : session.tokens.scopes,
        };
        if (next.scopes.length) session.scopes = next.scopes;
        console.log('[oauth] refreshed the access token');
        return next.accessToken;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });

// ------------------------------------------------------------------ helpers

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** Collect a request body as RAW BYTES — webhook signatures are over the bytes. */
function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function errorPage(title, detail) {
  return (
    '<!doctype html><meta charset="utf-8"><title>' +
    escapeHtml(title) +
    '</title>' +
    '<body style="background:#0d0f14;color:#e6e8ef;font:16px/1.6 system-ui,sans-serif;padding:48px">' +
    '<h1 style="font-size:20px">' +
    escapeHtml(title) +
    '</h1><p style="color:#98a2b8;max-width:60ch">' +
    escapeHtml(detail) +
    '</p><p><a style="color:#7aa2ff" href="/">Back to the demo</a></p>'
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Turn any thrown value into a browser-safe JSON error — never leak a token. */
function describeError(err) {
  if (err instanceof PowerChatApiError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      hint: err.isAuthProblem
        ? 'Missing scope, revoked grant, or a capability the streamer switched off. Compare GET /me scopes against the endpoint requirement.'
        : err.isRetryable
          ? 'Rate limited or a transient server error — back off and retry.'
          : undefined,
    };
  }
  return { status: 500, code: null, message: err?.message || 'Unexpected error' };
}

// ------------------------------------------------------------------- routes

function serveIndex(res) {
  // Read per request so editing the page does not need a server restart.
  fs.readFile(INDEX_HTML, (err, buf) => {
    if (err) return sendHtml(res, 500, errorPage('Missing public/index.html', String(err.message)));
    sendHtml(res, 200, buf.toString('utf8'));
  });
}

function handleConnect(res) {
  if (!config.clientId) {
    return sendHtml(
      res,
      400,
      errorPage(
        'POWERCHAT_CLIENT_ID is not set',
        'Register an app under Developer API in the PowerChat dashboard, then copy .env.example to .env and fill in the client id, secret, and redirect URI.',
      ),
    );
  }

  const { codeVerifier, codeChallenge } = createPkcePair();
  const state = createState();
  pendingAuthorizations.set(state, { codeVerifier, createdAt: Date.now() });

  // Drop anything a browser abandoned, so an unused verifier does not live
  // in memory forever.
  for (const [key, value] of pendingAuthorizations) {
    if (Date.now() - value.createdAt > PENDING_TTL_MS) pendingAuthorizations.delete(key);
  }

  redirect(
    res,
    buildAuthorizeUrl({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scopes: SCOPES,
      state,
      codeChallenge,
    }),
  );
}

async function handleCallback(url, res) {
  const error = url.searchParams.get('error');
  if (error) {
    // The streamer declined, or the authorize request was malformed.
    return sendHtml(
      res,
      400,
      errorPage(
        'Authorization was not completed',
        `PowerChat returned "${error}". ${url.searchParams.get('error_description') || ''}`,
      ),
    );
  }

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const pending = state ? pendingAuthorizations.get(state) : null;

  // Verify state BEFORE touching the code. An unknown state means this
  // callback did not start here — that is exactly the CSRF this parameter
  // exists to stop.
  if (!pending) {
    return sendHtml(
      res,
      400,
      errorPage(
        'Unknown or expired state',
        'This callback did not come from a /connect this server started. Start again from the home page.',
      ),
    );
  }
  pendingAuthorizations.delete(state);
  if (!code)
    return sendHtml(
      res,
      400,
      errorPage('No authorization code', 'The callback had no ?code parameter.'),
    );

  try {
    const tokens = await exchangeCode({
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      code,
      codeVerifier: pending.codeVerifier,
    });
    session.tokens = tokens;
    session.scopes = tokens.scopes;
    session.connectedAt = new Date().toISOString();
    session.source = 'oauth';

    // The token response carries `streamer`, but /me is the supported identity
    // source and costs one request — and it proves server-side auth works,
    // which is the single most useful thing to check first.
    const me = await client.me();
    session.streamer = me?.username || session.streamer;
    if (Array.isArray(me?.scopes) && me.scopes.length) session.scopes = me.scopes;
    console.log(`[oauth] connected ${session.streamer} with ${session.scopes.length} scope(s)`);

    redirect(res, '/?connected=1');
  } catch (err) {
    console.error('[oauth] token exchange failed:', err.message);
    sendHtml(res, 400, errorPage('Token exchange failed', err.message));
  }
}

/**
 * The webhook receiver. Three rules, all of them load-bearing:
 *   1. Verify over the RAW bytes before trusting a single field.
 *   2. Dedupe on the delivery id — deliveries are at-least-once.
 *   3. Answer 2xx FAST and do the work afterwards. A slow receiver gets
 *      retried, and ~20 consecutive failures trips the circuit breaker that
 *      disables your endpoint.
 */
async function handleWebhook(req, res) {
  let raw;
  try {
    raw = await readRawBody(req, 1024 * 1024);
  } catch {
    return sendJson(res, 413, { error: 'Body too large' });
  }

  const verified = verifyWebhook(raw, req.headers, config.webhookSecret);
  if (!verified.ok) {
    // 4xx is TERMINAL for PowerChat — it will not retry. That is what you
    // want for a bad signature, and what you do not want for a bug in your
    // own handler, which is why handler work happens after the response.
    console.warn(`[webhook] rejected: ${verified.reason}`);
    return sendJson(res, 400, { error: verified.reason });
  }

  const deliveryId = String(req.headers['x-powerchat-delivery-id'] || verified.event?.id || '');
  const fresh = deduper.accept(deliveryId);
  sendJson(res, 202, { received: true });

  if (!fresh) {
    console.log(`[webhook] duplicate delivery ${deliveryId} ignored`);
    return;
  }

  setImmediate(() => {
    const event = verified.event;
    dispatchEvent(event, {
      // The ONLY authoritative confirmation that money moved. `appExternalRef`
      // is the `ref` you minted on the checkout link.
      'donation.completed': (e) => {
        const d = e.data || {};
        console.log(
          `[webhook] donation.completed ${d.amountDisplay || d.amountCents + 'c'}` +
            ` from ${d.isAnonymous ? 'anonymous' : d.donorName}` +
            ` ref=${d.appExternalRef ?? 'none'} isTest=${d.isTest}`,
        );
      },
      // Same shape, different delivery id: a tip WITH a message fires both.
      // Treat this one as display only, or you double-count every tip.
      'paid_message.created': (e) =>
        console.log(`[webhook] paid_message.created (display only) ${e.data?.eventId}`),
      '*': (e) => console.log(`[webhook] ${e.type}`),
    });
    recordEvent(event, deliveryId, Number(req.headers['x-powerchat-delivery-attempt'] || 1));
  });
}

function recordEvent(event, deliveryId, attempt) {
  recentEvents.unshift({
    deliveryId,
    attempt,
    type: event?.type ?? 'unknown',
    sentAt: event?.sentAt ?? event?.createdAt ?? null,
    receivedAt: new Date().toISOString(),
    streamer: event?.streamer?.username ?? null,
    isTest: event?.data?.isTest ?? null,
    data: event?.data ?? null,
  });
  if (recentEvents.length > MAX_EVENTS) recentEvents.length = MAX_EVENTS;
}

/** Everything the page needs — and nothing that is a credential. */
function handleState(res) {
  sendJson(res, 200, {
    connected: Boolean(session.tokens),
    streamer: session.streamer,
    scopes: session.scopes,
    connectedAt: session.connectedAt,
    tokenSource: session.source,
    baseUrl: config.baseUrl,
    requestedScopes: SCOPES,
    clientIdConfigured: Boolean(config.clientId),
    webhookSecretConfigured: Boolean(config.webhookSecret),
    webhookPath: WEBHOOK_PATH,
    events: recentEvents,
  });
}

async function handleDemo(action, req, res) {
  if (!session.tokens || !session.streamer) {
    return sendJson(res, 409, {
      error: { message: 'No streamer connected. Click Connect PowerChat first.' },
    });
  }

  let body = {};
  try {
    const raw = await readRawBody(req, 64 * 1024);
    if (raw.length) body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: { message: 'Body must be JSON under 64KB' } });
  }

  const streamer = session.streamer;
  try {
    switch (action) {
      case 'chat': {
        const message = String(body.message || '').slice(0, 500);
        if (!message) return sendJson(res, 400, { error: { message: 'message is required' } });
        // messageId is REQUIRED and is your idempotency key: resending the
        // same id dedupes instead of posting twice.
        const messageId = String(body.messageId || `demo-${crypto.randomUUID()}`);
        const accepted = await client.sendChat(streamer, {
          chatterName: String(body.chatterName || 'DemoBot').slice(0, 48),
          externalChatterId: String(body.externalChatterId || 'demo-bot').slice(0, 128),
          message,
          messageId,
          avatarFallback: 'D',
        });

        // 202 means ACCEPTED FOR MODERATION, not displayed — the message can
        // still be dropped by blocks, AI moderation, or profanity settings
        // with no callback. Reading chat/history back is the only way to know.
        let displayed = null;
        try {
          await new Promise((r) => setTimeout(r, 1500));
          const history = await client.chatHistory(streamer, { limit: 50 });
          const rows = Array.isArray(history)
            ? history
            : (history?.rows ?? history?.messages ?? []);
          displayed = rows.some((row) => JSON.stringify(row).includes(messageId)) || null;
        } catch {
          displayed = null; // needs chat:read; not fatal for the send itself
        }
        return sendJson(res, 200, { accepted, messageId, displayed });
      }

      case 'view-count': {
        // null clears the count (stream ended). Otherwise re-post at least
        // every 90s while live or a freshness sweep zeroes your chip.
        const count = body.count === null ? null : Math.max(0, Math.trunc(Number(body.count) || 0));
        const result = await client.setViewCount(streamer, count);
        return sendJson(res, 200, { count, result });
      }

      case 'alert': {
        // /test-alerts is a discriminated union on `kind` — sending {} fails
        // validation on that exact field. App-fired alerts are display-only:
        // they never credit goals, subathons, or leaderboards.
        const result = await client.testAlert(streamer, {
          kind: 'tip',
          payload: {
            amountCents: Math.min(
              1_000_000,
              Math.max(1, Math.trunc(Number(body.amountCents) || 500)),
            ),
            currency: 'usd',
            tipperName: String(body.tipperName || 'DemoDonor').slice(0, 80),
            message: String(body.message || 'Fired from the PowerChat demo').slice(0, 500),
          },
        });
        return sendJson(res, 200, { result });
      }

      case 'tip-checkout-link': {
        // Passing ANY term (amountCents / purpose / redirectUri) mints a
        // single-use, one-hour intent: the returned URL carries only an opaque
        // `app_intent` token and the terms are server-held, so the viewer
        // cannot edit the amount. One intent funds exactly one tip — mint a
        // fresh link per viewer journey.
        //
        // redirectUri is deliberately not sent here: it must be one of your
        // REGISTERED redirect URIs, and the OAuth callback is the wrong place
        // to land a tipper. Register a dedicated return URL before using it.
        const ref = String(body.ref || `demo-${crypto.randomUUID()}`).slice(0, 128);
        const result = await client.tipCheckoutLink(streamer, {
          ref,
          amountCents: Math.max(1, Math.trunc(Number(body.amountCents) || 500)),
          purpose: String(body.purpose || 'demo').slice(0, 64),
        });
        return sendJson(res, 200, { ref, ...result });
      }

      default:
        return sendJson(res, 404, { error: { message: `Unknown demo action "${action}"` } });
    }
  } catch (err) {
    const described = describeError(err);
    console.error(`[demo:${action}] ${described.message}`);
    return sendJson(
      res,
      described.status >= 400 && described.status < 600 ? described.status : 500,
      {
        error: described,
      },
    );
  }
}

// ------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'Malformed request URL' });
  }
  const route = url.pathname;

  if (req.method === 'GET' && (route === '/' || route === '/index.html')) return serveIndex(res);
  if (req.method === 'GET' && route === '/connect') return handleConnect(res);
  if (req.method === 'GET' && route === CALLBACK_PATH) return void handleCallback(url, res);
  if (req.method === 'POST' && route === WEBHOOK_PATH) return void handleWebhook(req, res);
  if (req.method === 'GET' && route === '/api/state') return handleState(res);
  if (req.method === 'POST' && route.startsWith('/api/demo/')) {
    return void handleDemo(route.slice('/api/demo/'.length), req, res);
  }
  sendJson(res, 404, { error: { message: `No route for ${req.method} ${route}` } });
});

server.listen(config.port, () => {
  const local = `http://localhost:${config.port}`;
  const ready = [];
  if (!config.clientId) ready.push('POWERCHAT_CLIENT_ID is not set — /connect will not work.');
  if (!config.webhookSecret) {
    ready.push('POWERCHAT_WEBHOOK_SECRET is not set — every webhook will be rejected.');
  }

  console.log(`
  PowerChat demo server
  ---------------------
  Open            ${local}
  API host        ${config.baseUrl}
  Redirect URI    ${config.redirectUri}   (must match a REGISTERED URI exactly)
  Webhook path    ${WEBHOOK_PATH}

  PowerChat only delivers webhooks to a public HTTPS URL, so localhost needs a
  tunnel while you develop:

      ngrok http ${config.port}

  Then register https://<your-tunnel>${WEBHOOK_PATH} as the webhook receiver on
  your app in the dashboard, copy the signing secret (pcw_..., shown once) into
  POWERCHAT_WEBHOOK_SECRET, and press "Send test webhook" to prove the wiring.
  ${ready.length ? '\n  Heads up:\n' + ready.map((line) => `    - ${line}`).join('\n') + '\n' : ''}`);
});

module.exports = { server };
