'use strict';
/**
 * CHARITY CAMPAIGN — the fundraiser microsite, running.
 *
 *   GET  /                    the public "raised so far" page + donor wall
 *   GET  /api/campaign        the same numbers as JSON, for an overlay or an OBS
 *                             browser source
 *   POST /webhooks/powerchat  signed donations in; totals and milestones out
 *
 * The order of the boot sequence is the interesting part. We rebuild the
 * total from PowerChat BEFORE we serve a single page, because the failure
 * mode of getting it wrong is a fundraiser that publicly resets to $0 in the
 * middle of a stream and a chat full of people asking where their money went.
 *
 * Run:  node scenarios/charity-campaign/server.js
 */
const http = require('node:http');

const { config } = require('../../src/config');
const { PowerChatClient } = require('../../src/powerchat');
const { createEnvTokenSource } = require('../../src/credentials');
const { verifyWebhook, createDeliveryDeduper, dispatchEvent } = require('../../src/webhooks');
const {
  announceMilestones,
  applyDonation,
  backfill,
  createCampaign,
  donorWall,
  formatUsd,
  fromWebhook,
  progressPercent,
  renderPublicPage,
} = require('./campaign');

const PORT = Number(process.env.CAMPAIGN_PORT || 4020);
const WEBHOOK_PATH = '/webhooks/powerchat';
const BACKFILL_RETRY_MS = 30 * 1000;

const campaign = createCampaign({
  id: 'campaign_shelter_2026',
  title: 'Shelter Stream 2026',
  goalCents: 500_000, // $5,000, as an integer, like every other amount here
  milestonesCents: [50_000, 100_000, 250_000, 500_000],
});

// Long-running server, ~10-minute access tokens: the backfill retry and the
// milestone alerts need the refreshing `getAccessToken` path, not a fixed
// token that dies before the first milestone.
const tokenSource = config.accessToken ? createEnvTokenSource() : null;
const client = new PowerChatClient({
  baseUrl: config.baseUrl,
  ...(tokenSource ? { getAccessToken: tokenSource.getAccessToken } : {}),
});
const deduper = createDeliveryDeduper();

/**
 * Until the backfill succeeds, the total on screen is "everything since this
 * process booted", which is not the fundraiser's total. The page says so.
 */
let backfilled = false;

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

// -------------------------------------------------------------------- routes

function handlePublicPage(res) {
  const notice = backfilled
    ? undefined
    : 'Totals are still syncing with PowerChat — the figure below may be incomplete.';
  const html = renderPublicPage(campaign, { notice });
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // A fundraiser total is the definition of a page that must not be cached.
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/** The same numbers for an overlay, a Discord bot, or a second screen. */
function handleCampaignJson(res) {
  sendJson(res, 200, {
    title: campaign.title,
    raisedCents: campaign.raisedCents,
    raisedDisplay: formatUsd(campaign.raisedCents),
    goalCents: campaign.goalCents,
    percent: progressPercent(campaign),
    donationCount: campaign.donationCount,
    milestonesFired: [...campaign.firedMilestones].sort((a, b) => a - b),
    backfilled,
    // donorWall() is the only path that reads the donor list, and it maps an
    // anonymous donor to 'Anonymous'. Never serialise campaign.donors here.
    donors: donorWall(campaign),
  });
}

/**
 * Donations in.
 *
 * verify (raw bytes) -> dedupe (delivery id) -> ACK 2xx -> count, then
 * celebrate. Acking first is not an optimisation: a receiver that is slow or
 * throws gets retried, and about twenty consecutive failures trips a circuit
 * breaker that disables the endpoint. A fundraiser with a disabled webhook
 * endpoint is a fundraiser that has stopped counting.
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
    // Unverified means "someone else's POST". Anyone who can reach this URL
    // could otherwise add a zero to a charity's public total.
    console.warn(`[campaign] webhook rejected: ${verified.reason}`);
    return sendJson(res, 400, { error: verified.reason });
  }

  const deliveryId = String(req.headers['x-powerchat-delivery-id'] || '');
  const fresh = deduper.accept(deliveryId);
  sendJson(res, 202, { received: true });
  if (!fresh) {
    console.log(`[campaign] duplicate delivery ${deliveryId} ignored`);
    return;
  }

  setImmediate(() => {
    dispatchEvent(verified.event, {
      'donation.completed': (event) => {
        const result = applyDonation(campaign, fromWebhook(event.data));
        if (!result.applied) {
          console.log(`[campaign] not counted: ${result.reason}`);
          return;
        }
        console.log(
          `[campaign] +${formatUsd(event.data?.amountUsdCents ?? 0)} ` +
            `-> ${formatUsd(campaign.raisedCents)} (${progressPercent(campaign)}%)`,
        );
        if (result.crossed.length) {
          // Fire and forget, deliberately. The alert is decoration; the total
          // is the product. announceMilestones never rejects.
          announceMilestones(client, config.streamer, campaign, result.crossed).then(
            (announced) => {
              for (const cents of announced) {
                console.log(`[campaign] milestone ${formatUsd(cents)} announced (display only)`);
              }
            },
          );
        }
      },
      // A tip WITH a message arrives twice: once as donation.completed and
      // once as paid_message.created, same data, different delivery ids. The
      // delivery deduper cannot catch that — only this line can. Counting it
      // would inflate a charity's public total, which is the worst number in
      // this repo to get wrong.
      'paid_message.created': () =>
        console.log('[campaign] paid_message.created ignored (already counted)'),
      '*': (event) => console.log(`[campaign] unhandled ${event.type}`),
    });
  });
}

// -------------------------------------------------------------------- server

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'malformed url' });
  }

  if (req.method === 'GET' && url.pathname === '/') return handlePublicPage(res);
  if (req.method === 'GET' && url.pathname === '/api/campaign') return handleCampaignJson(res);
  if (req.method === 'POST' && url.pathname === WEBHOOK_PATH) return void handleWebhook(req, res);
  sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
});

/**
 * Rebuild the total, and keep trying if PowerChat is having a bad minute.
 * Webhooks arriving during a retry are counted normally — the `eventId`
 * dedupe means the eventual backfill will not count them a second time, so
 * the two paths can overlap freely.
 */
async function runBackfill() {
  if (!config.accessToken || !config.streamer) return;
  try {
    const summary = await backfill(client, config.streamer, campaign);
    backfilled = true;
    console.log(
      `[campaign] backfill: ${summary.pagesRead} page(s), ${summary.counted} donation(s), ` +
        `total ${formatUsd(campaign.raisedCents)}, ` +
        `${campaign.firedMilestones.size} milestone(s) seeded silently`,
    );
  } catch (err) {
    console.warn(`[campaign] backfill failed (${err.message}); retrying in 30s`);
    setTimeout(runBackfill, BACKFILL_RETRY_MS).unref();
  }
}

server.listen(PORT, async () => {
  const warnings = [];
  if (!config.accessToken || !config.streamer) {
    warnings.push(
      'POWERCHAT_ACCESS_TOKEN / POWERCHAT_STREAMER are unset — no backfill, no alerts.',
    );
  }
  if (!config.webhookSecret) {
    warnings.push('POWERCHAT_WEBHOOK_SECRET is unset — every donation webhook will be rejected.');
  }

  console.log(`
  Charity campaign
  ----------------
  Public page   http://localhost:${PORT}/
  JSON          http://localhost:${PORT}/api/campaign
  Webhook       ${WEBHOOK_PATH}   (needs a public HTTPS tunnel: ngrok http ${PORT})
  Goal          ${formatUsd(campaign.goalCents)}
  Scopes        paid_messages:read, webhooks:events, alerts:rich
${warnings.length ? '\n  Heads up:\n' + warnings.map((w) => '    - ' + w).join('\n') + '\n' : ''}`);

  await runBackfill();
});

module.exports = { server, campaign };
