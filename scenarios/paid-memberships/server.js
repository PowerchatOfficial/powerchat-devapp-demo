'use strict';
/**
 * PAID MEMBERSHIPS — the whole loop, running.
 *
 *   GET  /                      the storefront
 *   GET  /join?userId=…         mint an intent, send the user to PowerChat
 *   GET  <your return path>     "confirming…" — a spinner, NOT a grant
 *   POST /webhooks/powerchat    the only place a membership is ever granted
 *   GET  /api/orders/:ref       what the confirming page polls
 *   POST /admin/reconcile       the sweep, on demand
 *
 * Read the four in that order and the integration is the whole story: a
 * question (the intent), a redirect you must not believe, a signed answer,
 * and a broom that sweeps up whatever the answer missed.
 *
 * Run:  node scenarios/paid-memberships/server.js
 */
const http = require('node:http');

const { config } = require('../../src/config');
const { PowerChatClient, PowerChatApiError } = require('../../src/powerchat');
const { verifyWebhook, createDeliveryDeduper, dispatchEvent } = require('../../src/webhooks');
const {
  MEMBERSHIP,
  createOrderStore,
  mintMembershipCheckout,
  redactIntentUrl,
} = require('./checkout');
const { createMembershipStore, handleDonationCompleted, reconcile } = require('./fulfilment');

const PORT = Number(process.env.MEMBERSHIP_PORT || 4010);
const WEBHOOK_PATH = '/webhooks/powerchat';
/**
 * The URL PowerChat sends the payer back to. It must appear on your app's
 * registered redirect URIs, matched character for character — the same
 * allow-list OAuth uses, for the same reason: an unchecked redirect target is
 * an open redirect. Register a second URI for this path; it does not have to
 * be your OAuth callback, and it should not be.
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

// ---------------------------------------------------------------- app state

// Both of these are Maps and both of them are wrong for production — see the
// table definitions in checkout.js and fulfilment.js. Restart this process
// and every pending order disappears, which is precisely the scenario the
// README walks through under "what a restart costs you".
const orders = createOrderStore();
const memberships = createMembershipStore();
const deduper = createDeliveryDeduper();
const log = [];

const client = new PowerChatClient({
  baseUrl: config.baseUrl,
  accessToken: config.accessToken,
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

// -------------------------------------------------------------------- routes

/** 1. The storefront. */
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
        '<p style="color:#5c6478;font-size:13px">Safe to press twice. That is the point.</p>',
    ),
  );
}

/** 2. Mint an intent and hand the user off. */
async function handleJoin(url, res) {
  const userId = (url.searchParams.get('userId') || '').trim();
  if (!userId) return sendHtml(res, 400, page('Missing user', '<p>Pass ?userId=…</p>'));

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
 * 3. The return page.
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
  // so narrow it to the alphabet our own refs use before it goes anywhere.
  const ref = (url.searchParams.get('app_ref') || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 128);
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
 * 4. The webhook. The only door money comes through.
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

  setImmediate(() => {
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
  });
}

/** What the confirming page polls. Deliberately says nothing about money. */
function handleOrderStatus(ref, res) {
  const order = orders.get(ref);
  if (!order) return sendJson(res, 404, { state: 'unknown' });
  sendJson(res, 200, { ref: order.ref, state: order.state });
}

/** 5. The sweep, on demand. The timer runs the identical call. */
async function handleReconcile(res) {
  try {
    const summary = await runSweep('manual');
    sendHtml(
      res,
      200,
      page(
        'Sweep complete',
        '<h1 style="font-size:20px">Sweep complete</h1><pre style="background:#141822;' +
          'padding:16px;border-radius:8px;overflow:auto">' +
          escapeHtml(JSON.stringify(summary, null, 2)) +
          '</pre><p><a style="color:#7aa2ff" href="/">Back</a></p>',
      ),
    );
  } catch (err) {
    sendHtml(res, 502, page('Sweep failed', '<p>' + escapeHtml(err.message) + '</p>'));
  }
}

async function runSweep(trigger) {
  const summary = await reconcile(client, config.streamer, { orders, memberships });
  note(
    `sweep (${trigger}): ${summary.pagesRead} page(s), ${summary.rowsSeen} row(s), ` +
      `${summary.granted.length} recovered, ${summary.abandoned.length} abandoned`,
  );
  return summary;
}

// -------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'malformed url' });
  }
  const route = url.pathname;

  if (req.method === 'GET' && route === '/') return handleHome(res);
  if (req.method === 'GET' && route === '/join') return void handleJoin(url, res);
  if (req.method === 'GET' && route === RETURN_PATH) return handleReturn(url, res);
  if (req.method === 'POST' && route === WEBHOOK_PATH) return void handleWebhook(req, res);
  if (req.method === 'GET' && route.startsWith('/api/orders/')) {
    return handleOrderStatus(decodeURIComponent(route.slice('/api/orders/'.length)), res);
  }
  if (req.method === 'POST' && route === '/admin/reconcile') return void handleReconcile(res);
  if (req.method === 'GET' && route === '/api/log') return sendJson(res, 200, { log });
  sendJson(res, 404, { error: `no route for ${req.method} ${route}` });
});

server.listen(PORT, () => {
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
  Storefront    http://localhost:${PORT}/
  Return URI    ${RETURN_URI}   (must be REGISTERED on your app, exact match)
  Webhook       ${WEBHOOK_PATH}   (needs a public HTTPS tunnel: ngrok http ${PORT})
  Price         ${money(MEMBERSHIP.priceCents)} / ${MEMBERSHIP.periodDays} days
  Scopes        checkout:attribute, paid_messages:read, webhooks:events
${warnings.length ? '\n  Heads up:\n' + warnings.map((w) => '    - ' + w).join('\n') + '\n' : ''}`);

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
});

module.exports = { server };
