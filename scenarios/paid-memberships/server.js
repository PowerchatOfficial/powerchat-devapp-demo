'use strict';
/**
 * PAID MEMBERSHIPS — the whole loop, running.
 *
 * Two listeners, because two very different callers:
 *
 *   PUBLIC  0.0.0.0:MEMBERSHIP_PORT (4010) — the one you tunnel.
 *     POST /webhooks/powerchat    the only place a membership is ever granted
 *     GET  <your return path>     "confirming…" — a spinner, NOT a grant
 *     GET  /api/orders/:ref       what the confirming page polls (state only)
 *
 *   ADMIN   127.0.0.1:MEMBERSHIP_ADMIN_PORT (4012) — loopback ONLY.
 *     GET  /                      the storefront
 *     GET  /join?userId=…         mint an intent, send the user to PowerChat
 *     POST /admin/reconcile       the sweep, on demand
 *     GET  /api/log               recent activity
 *
 * Why the split: the public side has to be reachable by PowerChat (the
 * webhook) and by the payer's browser coming back from the tip page (the
 * return URI), so it goes through the tunnel. Everything on the admin side
 * SPENDS something — /join mints an intent and allocates an order per call,
 * /admin/reconcile pages through paid-messages on your rate-limit budget —
 * and in a real product sits behind your own user login and your own admin
 * auth. This demo has neither, so it keeps those routes off the network
 * entirely. An earlier version served all of it on one tunneled port, which
 * let anyone on the internet mint unbounded intents and run overlapping
 * sweeps against the streamer's grant.
 *
 * Read the routes in the numbered order and the integration is the whole
 * story: a question (the intent), a redirect you must not believe, a signed
 * answer, and a broom that sweeps up whatever the answer missed.
 *
 * Run:  node scenarios/paid-memberships/server.js
 */
const http = require('node:http');

const { config } = require('../../src/config');
const { createEnvTokenSource } = require('../../src/credentials');
const { PowerChatClient, PowerChatApiError } = require('../../src/powerchat');
const { verifyWebhook, createDeliveryDeduper, dispatchEvent } = require('../../src/webhooks');
const {
  MEMBERSHIP,
  createOrderStore,
  isOrderRef,
  mintMembershipCheckout,
  redactIntentUrl,
} = require('./checkout');
const { createMembershipStore, handleDonationCompleted, reconcile } = require('./fulfilment');

const PORT = Number(process.env.MEMBERSHIP_PORT || 4010);
const PUBLIC_HOST = process.env.MEMBERSHIP_PUBLIC_HOST || '0.0.0.0';
const ADMIN_PORT = Number(process.env.MEMBERSHIP_ADMIN_PORT || 4012);
const WEBHOOK_PATH = '/webhooks/powerchat';
/**
 * The URL PowerChat sends the payer back to. It must appear on your app's
 * registered redirect URIs, matched character for character — the same
 * allow-list OAuth uses, for the same reason: an unchecked redirect target is
 * an open redirect. Register a second URI for this path; it does not have to
 * be your OAuth callback, and it should not be. It lands on the PUBLIC
 * listener, so through the tunnel it is https://<tunnel>/membership/return.
 */
const RETURN_URI =
  process.env.MEMBERSHIP_RETURN_URI || `http://localhost:${PORT}/membership/return`;
const RETURN_PATH = (() => {
  try {
    return new URL(RETURN_URI).pathname;
  } catch {
    return '/membership/return';
  }
})();
/** Every five minutes is frequent enough to make a webhook outage invisible
 *  to members and rare enough to be free. */
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** /join mints an intent per call. Five a minute per caller is generous for
 *  a human and hostile to a loop. */
const JOIN_RATE = { windowMs: 60 * 1000, max: 5 };

// ---------------------------------------------------------------- app state

// Both of these are Maps and both of them are wrong for production — see the
// table definitions in checkout.js and fulfilment.js. Restart this process
// and every pending order disappears, which is precisely the scenario the
// README walks through under "what a restart costs you".
const orders = createOrderStore();
const memberships = createMembershipStore();
const deduper = createDeliveryDeduper();
const log = [];

/**
 * This server runs for hours and an access token lives ~10 minutes, so the
 * client is built on the refreshing `getAccessToken` path rather than a
 * fixed token. Without a refresh token in .env the sweep timer would start
 * failing with 401 ten minutes in and never recover.
 */
const tokenSource = config.accessToken ? createEnvTokenSource({ log: note }) : null;
const client = new PowerChatClient({
  baseUrl: config.baseUrl,
  ...(tokenSource ? { getAccessToken: tokenSource.getAccessToken } : {}),
});

function note(line) {
  const entry = `${new Date().toISOString()}  ${line}`;
  log.unshift(entry);
  if (log.length > 60) log.length = 60;
  console.log('[membership] ' + line);
}

// ------------------------------------------------------------------ plumbing

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
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

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function money(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}

function page(title, body) {
  return (
    '<!doctype html><meta charset="utf-8"><title>' +
    escapeHtml(title) +
    '</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="background:#0d0f14;color:#e6e8ef;font:16px/1.6 system-ui,sans-serif;' +
    'margin:0;padding:48px 24px"><main style="max-width:70ch;margin:0 auto">' +
    body +
    '</main>'
  );
}

/**
 * The error boundary. Every request goes through this; nothing a handler
 * throws — synchronously or as a rejected promise — can reach the process.
 * Without it, one malformed URL is a remote crash: `decodeURIComponent('%')`
 * throws URIError, and an uncaught exception in Node ends the process.
 * The 500 says nothing about WHAT failed; that goes to the log.
 */
function guarded(handler) {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        note(`handler threw on ${req.method} ${req.url}: ${err && err.message}`);
        if (res.headersSent) return void res.destroy();
        sendJson(res, 500, { error: 'internal error' });
      });
  };
}

/**
 * A per-caller sliding window. In memory and keyed by the socket address —
 * enough to stop a loop, not a substitute for the login your storefront
 * will have. Behind a proxy, key on the forwarded address only if you trust
 * the proxy to set it.
 */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    /** @returns true when the call is allowed. */
    allow(key, at = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(at);
      hits.set(key, recent);
      // Keep the map from growing forever on a long-running process.
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (!v.some((t) => at - t < windowMs)) hits.delete(k);
      }
      return true;
    },
  };
}

const joinLimiter = createRateLimiter(JOIN_RATE);

/**
 * The admin listener is loopback-only, but "loopback" does not mean "only
 * me": a page on any website can make the user's OWN browser send requests
 * to 127.0.0.1. Browsers label those — `Sec-Fetch-Site: cross-site`, and an
 * `Origin` that is not ours — so refuse anything so labelled. A request
 * with neither header (curl, an old browser) is allowed: it is not a
 * cross-site browser request, which is the only thing this guards against.
 */
function crossSiteReason(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return `Sec-Fetch-Site is ${site}`;
  const origin = req.headers.origin;
  if (origin) {
    let host;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch {
      return 'Origin is not a URL';
    }
    const ok = [`localhost:${ADMIN_PORT}`, `127.0.0.1:${ADMIN_PORT}`, `[::1]:${ADMIN_PORT}`];
    if (!ok.includes(host)) return `Origin ${origin} is not this server`;
  }
  return null;
}

// -------------------------------------------------------------------- routes

/** 1. The storefront. (admin listener) */
function handleHome(res) {
  const rows = orders
    .list()
    .slice(-12)
    .reverse()
    .map(
      (o) =>
        '<tr><td><code>' +
        escapeHtml(o.ref.slice(0, 14)) +
        '…</code></td><td>' +
        escapeHtml(o.userId) +
        '</td><td>' +
        escapeHtml(o.state) +
        '</td></tr>',
    )
    .join('');

  const members = memberships
    .list()
    .map(
      (m) =>
        '<li><strong>' +
        escapeHtml(m.userId) +
        '</strong> — active until ' +
        escapeHtml(new Date(m.periodEndsAt).toISOString().slice(0, 10)) +
        ' (' +
        m.periods +
        ' period(s), via ' +
        escapeHtml(m.lastSource) +
        ')</li>',
    )
    .join('');

  sendHtml(
    res,
    200,
    page(
      'Join the club',
      '<h1 style="font-size:26px;margin:0 0 4px">Join the club</h1>' +
        '<p style="color:#98a2b8;margin-top:0">' +
        money(MEMBERSHIP.priceCents) +
        ' / month. Paid on ' +
        escapeHtml(config.streamer || '<streamer>') +
        "'s PowerChat tip page — we never touch a card number.</p>" +
        '<form method="GET" action="/join" style="margin:24px 0">' +
        '<input name="userId" value="u_1001" style="padding:8px;border-radius:6px;border:1px ' +
        'solid #2a3040;background:#141822;color:#e6e8ef">' +
        '<button style="padding:9px 16px;margin-left:8px;border-radius:6px;border:0;' +
        'background:#7C3AED;color:#fff;font-weight:600">Join</button></form>' +
        '<h2 style="font-size:17px">Members</h2><ul>' +
        (members || '<li style="color:#98a2b8">nobody yet</li>') +
        '</ul><h2 style="font-size:17px">Recent orders</h2>' +
        '<table style="width:100%;border-collapse:collapse;font-size:14px">' +
        (rows || '<tr><td style="color:#98a2b8">no orders yet</td></tr>') +
        '</table>' +
        '<form method="POST" action="/admin/reconcile" style="margin-top:28px">' +
        '<button style="padding:8px 14px;border-radius:6px;border:1px solid #2a3040;' +
        'background:#141822;color:#e6e8ef">Run the reconciliation sweep</button></form>' +
        '<p style="color:#5c6478;font-size:13px">Safe to press twice. That is the point — ' +
        'a second press while one is running joins the running sweep instead of starting another.</p>' +
        '<p style="color:#5c6478;font-size:13px">This page is served on 127.0.0.1 only. In a real ' +
        "product it sits behind your own user login; /join and the sweep spend the streamer's " +
        'API budget, so they must never be reachable anonymously.</p>',
    ),
  );
}

/** 2. Mint an intent and hand the user off. (admin listener) */
async function handleJoin(req, url, res) {
  const userId = (url.searchParams.get('userId') || '').trim().slice(0, 64);
  if (!userId) return sendHtml(res, 400, page('Missing user', '<p>Pass ?userId=…</p>'));

  // Each call mints an intent AND allocates an order row. Bound it per
  // caller, or a loop on this URL fills the order book and burns the
  // rate-limit budget the webhook sweep needs.
  if (!joinLimiter.allow(req.socket.remoteAddress || 'unknown')) {
    res.setHeader('Retry-After', String(JOIN_RATE.windowMs / 1000));
    return sendHtml(
      res,
      429,
      page('Slow down', '<p>Too many checkout attempts. Try again in a minute.</p>'),
    );
  }

  try {
    const { order, url: intentUrl } = await mintMembershipCheckout(client, config.streamer, {
      userId,
      redirectUri: RETURN_URI,
      orders,
    });
    // The token is a single-use bearer credential for a $5 charge. It goes in
    // a Location header and nowhere else — never a log, never an error page.
    note(`minted ${order.ref} for ${userId} -> ${redactIntentUrl(intentUrl)}`);
    res.writeHead(302, { Location: intentUrl, 'Cache-Control': 'no-store' });
    res.end();
  } catch (err) {
    note(`mint failed for ${userId}: ${err.message}`);
    sendHtml(
      res,
      502,
      page(
        'Could not start checkout',
        '<h1 style="font-size:20px">Could not start checkout</h1><p style="color:#98a2b8">' +
          escapeHtml(err.message) +
          '</p><p><a style="color:#7aa2ff" href="/">Back</a></p>',
      ),
    );
  }
}

/**
 * 3. The return page. (public listener)
 *
 * THE REDIRECT IS NOT PROOF OF PAYMENT. It is an unauthenticated GET in a
 * browser: a user can bookmark it, edit the query string, or send it to a
 * friend. If this handler granted anything, the membership would be free to
 * anyone who read the URL bar once.
 *
 * So it does the only honest thing — shows a spinner and polls our own order
 * state, which only ever changes when a signed webhook says so.
 */
function handleReturn(url, res) {
  // `app_ref` arrives from a browser, so it is attacker-controlled even though
  // WE minted the value it is supposed to carry. It gets interpolated into an
  // inline <script> below, and JSON.stringify does NOT escape `</script>` —
  // so accept it only if it has EXACTLY the shape our own refs have. Anything
  // else is treated as "no reference", not cleaned up and used.
  const candidate = (url.searchParams.get('app_ref') || '').trim();
  const ref = isOrderRef(candidate) ? candidate : '';
  const status = url.searchParams.get('powerchat_status') || 'unknown';
  const order = ref ? orders.get(ref) : null;

  sendHtml(
    res,
    200,
    page(
      'Confirming your membership',
      '<h1 style="font-size:22px;margin-bottom:4px">Thanks — confirming your payment…</h1>' +
        '<p style="color:#98a2b8">PowerChat says <code>' +
        escapeHtml(status) +
        '</code>. We are waiting for the signed confirmation before we unlock anything. ' +
        'This usually takes a second or two.</p>' +
        '<p id="state" style="font-size:18px;font-weight:600">checking…</p>' +
        (order ? '' : '<p style="color:#f0a">We have no order on file for this ref.</p>') +
        '<p style="color:#5c6478;font-size:13px;border-top:1px solid #222836;padding-top:16px">' +
        'This page is a courtesy, not a receipt. Nothing on it can grant a membership — the ' +
        'grant happens in the webhook handler, on the server, after a signature check.</p>' +
        '<script>(function(){var ref=' +
        JSON.stringify(ref) +
        ';var el=document.getElementById("state");var tries=0;' +
        'if(!ref){el.textContent="no reference in the URL";return;}' +
        'function poll(){tries++;fetch("/api/orders/"+encodeURIComponent(ref))' +
        '.then(function(r){return r.json()}).then(function(o){' +
        'if(o.state==="paid"){el.textContent="Membership active. Welcome in.";return;}' +
        'if(tries>30){el.textContent="Still confirming. We will email you — the sweep ' +
        'catches anything the webhook missed.";return;}' +
        'el.textContent="waiting for confirmation…";setTimeout(poll,2000);})' +
        '.catch(function(){setTimeout(poll,3000)});}poll();})();</script>',
    ),
  );
}

/**
 * 4. The webhook. The only door money comes through. (public listener)
 *
 * Order of operations matters:
 *   verify (raw bytes) -> dedupe (delivery id) -> ACK 2xx -> work async.
 * Acking before the work is not laziness: a slow receiver gets retried, and
 * ~20 consecutive failures trips a circuit breaker that disables the endpoint
 * entirely. Your fulfilment bug should cost you one membership, not the feed.
 */
async function handleWebhook(req, res) {
  let raw;
  try {
    raw = await readRawBody(req, 1024 * 1024);
  } catch {
    return sendJson(res, 413, { error: 'body too large' });
  }

  const verified = verifyWebhook(raw, req.headers, config.webhookSecret);
  if (!verified.ok) {
    // 4xx is TERMINAL — PowerChat will not retry. Correct for a forged or
    // stale delivery, and the reason we never 4xx on our own bugs.
    note(`webhook rejected: ${verified.reason}`);
    return sendJson(res, 400, { error: verified.reason });
  }

  const deliveryId = String(req.headers['x-powerchat-delivery-id'] || '');
  const fresh = deduper.accept(deliveryId);
  sendJson(res, 202, { received: true });
  if (!fresh) return void note(`duplicate delivery ${deliveryId} ignored`);

  // The response is already sent, so `guarded` cannot see a throw from here.
  // Catch it locally: a fulfilment bug must cost one membership, not the process.
  setImmediate(() => {
    try {
      dispatchEvent(verified.event, {
        'donation.completed': (event) => {
          const result = handleDonationCompleted(event, { orders, memberships });
          if (result.granted) {
            note(`GRANTED ${result.membership.userId} via ${result.order.ref} (webhook)`);
          } else {
            note(`no grant: ${result.reason}`);
          }
        },
        // The same tip, delivered twice under two names. A tip WITH a message
        // fires donation.completed AND paid_message.created with identical data
        // and different delivery ids, so the deduper cannot save you here — only
        // ignoring one of them can. Money is credited on donation.completed.
        'paid_message.created': () => note('paid_message.created ignored (would double-count)'),
        '*': (event) => note(`unhandled ${event.type}`),
      });
    } catch (err) {
      note(`fulfilment threw for ${deliveryId}: ${err.message}`);
    }
  });
}

/**
 * What the confirming page polls. (public listener) Deliberately says
 * nothing about money — and nothing about refs it does not recognise:
 * the reply for "malformed", "unknown", and "someone else's" is identical.
 */
function handleOrderStatus(rawSuffix, res) {
  // The suffix is matched RAW. `ord_` + 32 hex needs no decoding, and
  // decoding an arbitrary suffix is the crash the error boundary exists
  // for. A ref that does not match is a 400, before any lookup.
  if (!isOrderRef(rawSuffix)) return sendJson(res, 400, { error: 'malformed order reference' });
  const order = orders.get(rawSuffix);
  if (!order) return sendJson(res, 404, { state: 'unknown' });
  sendJson(res, 200, { ref: order.ref, state: order.state });
}

/** 5. The sweep, on demand. (admin listener) The timer runs the identical call. */
async function handleReconcile(res) {
  try {
    const summary = await runSweep('manual');
    sendHtml(
      res,
      200,
      page(
        summary.coalesced ? 'Joined the running sweep' : 'Sweep complete',
        '<h1 style="font-size:20px">' +
          (summary.coalesced
            ? 'A sweep was already running — here is its result'
            : 'Sweep complete') +
          '</h1><pre style="background:#141822;' +
          'padding:16px;border-radius:8px;overflow:auto">' +
          escapeHtml(JSON.stringify(summary, null, 2)) +
          '</pre><p><a style="color:#7aa2ff" href="/">Back</a></p>',
      ),
    );
  } catch (err) {
    sendHtml(res, 502, page('Sweep failed', '<p>' + escapeHtml(err.message) + '</p>'));
  }
}

/**
 * SINGLE-FLIGHT. A sweep pages through paid-messages on the app's shared
 * read budget; two running at once double the cost for zero extra
 * information, and — because each pages independently — can both see the
 * same pending order and race the compare-and-set in `orders.claim`. So
 * there is ever only one: a caller who arrives mid-sweep waits for THAT one
 * and gets its summary (marked `coalesced`), instead of starting another.
 * The timer, the startup sweep, and the button all go through here.
 */
let sweepInFlight = null;

function runSweep(trigger) {
  if (sweepInFlight) {
    note(`sweep (${trigger}) coalesced into the running sweep`);
    return sweepInFlight.then((summary) => ({ ...summary, coalesced: true }));
  }
  sweepInFlight = reconcile(client, config.streamer, { orders, memberships })
    .then((summary) => {
      note(
        `sweep (${trigger}): ${summary.pagesRead} page(s), ${summary.rowsSeen} row(s), ` +
          `${summary.granted.length} recovered, ${summary.abandoned.length} abandoned`,
      );
      return summary;
    })
    .finally(() => {
      sweepInFlight = null;
    });
  return sweepInFlight;
}

// ------------------------------------------------------------------- servers

function parsePath(req) {
  // The URL is parsed against a fixed base and never decoded: route matching
  // is on the raw path, and anything a handler needs from it is validated
  // by shape before use.
  return new URL(req.url, 'http://membership.invalid').pathname;
}

/** The tunneled side: webhook, return page, order status. Nothing else. */
const publicServer = http.createServer(
  guarded(async (req, res) => {
    let route;
    try {
      route = parsePath(req);
    } catch {
      return sendJson(res, 400, { error: 'malformed url' });
    }
    const url = new URL(req.url, 'http://membership.invalid');

    if (req.method === 'POST' && route === WEBHOOK_PATH) return handleWebhook(req, res);
    if (req.method === 'GET' && route === RETURN_PATH) return handleReturn(url, res);
    if (req.method === 'GET' && route.startsWith('/api/orders/')) {
      return handleOrderStatus(route.slice('/api/orders/'.length), res);
    }
    sendJson(res, 404, { error: `no route for ${req.method} ${route}` });
  }),
);

/** The loopback side: storefront, join, sweep, log. */
const adminServer = http.createServer(
  guarded(async (req, res) => {
    let route;
    try {
      route = parsePath(req);
    } catch {
      return sendJson(res, 400, { error: 'malformed url' });
    }
    const url = new URL(req.url, 'http://membership.invalid');

    const crossSite = crossSiteReason(req);
    if (crossSite) return sendJson(res, 403, { error: `refused: ${crossSite}` });

    if (req.method === 'GET' && route === '/') return handleHome(res);
    if (req.method === 'GET' && route === '/join') return handleJoin(req, url, res);
    if (req.method === 'POST' && route === '/admin/reconcile') return handleReconcile(res);
    if (req.method === 'GET' && route === '/api/log') return sendJson(res, 200, { log });
    sendJson(res, 404, { error: `no route for ${req.method} ${route}` });
  }),
);

function printBanner() {
  const warnings = [];
  if (!config.accessToken || !config.streamer) {
    warnings.push('POWERCHAT_ACCESS_TOKEN / POWERCHAT_STREAMER are unset — /join will fail.');
  }
  if (!config.webhookSecret) {
    warnings.push('POWERCHAT_WEBHOOK_SECRET is unset — every webhook will be rejected.');
  }

  console.log(`
  Paid memberships
  ----------------
  Storefront    http://127.0.0.1:${ADMIN_PORT}/          (admin listener — loopback only)
  Return URI    ${RETURN_URI}   (must be REGISTERED on your app, exact match)
  Webhook       http://${PUBLIC_HOST}:${PORT}${WEBHOOK_PATH}   (public listener)
  Price         ${money(MEMBERSHIP.priceCents)} / ${MEMBERSHIP.periodDays} days
  Scopes        checkout:attribute, paid_messages:read, webhooks:events

  Tunnel ONLY the public port — it serves the webhook, the return page, and
  the order-status poll, and nothing that spends the grant:

      ngrok http ${PORT}            # NOT ${ADMIN_PORT}
${warnings.length ? '\n  Heads up:\n' + warnings.map((w) => '    - ' + w).join('\n') + '\n' : ''}`);
}

let listening = 0;
function onListening() {
  listening += 1;
  if (listening < 2) return;
  printBanner();

  // A sweep on boot is the cheapest possible recovery from "we were down when
  // the webhook fired". It is also the honest demo of this file's weakness:
  // with an in-memory order store there is nothing left to reconcile AGAINST
  // after a restart, and every recovered payment logs as "unknown ref".
  // Persist the orders table and the same sweep quietly fixes everything.
  if (config.accessToken && config.streamer) {
    runSweep('startup').catch((err) => {
      const hint =
        err instanceof PowerChatApiError && err.isAuthProblem
          ? ' (is paid_messages:read in the authorize scope? GET /me shows the truth)'
          : '';
      note(`startup sweep failed: ${err.message}${hint}`);
    });
    setInterval(() => {
      runSweep('timer').catch((err) => note(`timer sweep failed: ${err.message}`));
    }, RECONCILE_INTERVAL_MS).unref();
  }
}

publicServer.listen(PORT, PUBLIC_HOST, onListening);
adminServer.listen(ADMIN_PORT, '127.0.0.1', onListening);

// `server` kept for anyone importing the old name; it is the public listener.
const server = publicServer;

module.exports = { server, publicServer, adminServer };
