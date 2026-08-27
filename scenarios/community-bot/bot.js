'use strict';
/**
 * bot.js — the durable half of the community bot: a signed-webhook receiver
 * that announces creator activity in a community channel.
 *
 * THE PIPELINE, AND WHY IT IS IN THIS ORDER:
 *
 *   verify  →  dedupe  →  ACK 2xx  →  announce (asynchronously)
 *
 *   verify   Over the RAW BYTES, before touching a single field. Re-serializing
 *            parsed JSON changes the bytes and no signature will ever match. An
 *            unverified receiver is an open endpoint that anyone on the
 *            internet can post fake donations to, and this bot announces
 *            donations to a room full of people.
 *   dedupe   Delivery is AT-LEAST-ONCE. `X-PowerChat-Delivery-Id` is stable
 *            across retries of the same delivery, so it is the dedupe key.
 *            Without this step one retried delivery is one duplicate "$50 tip!"
 *            message in the community channel.
 *   ack      FAST, before the announcement is attempted. A slow receiver gets
 *            retried; ~20 consecutive failures trips a circuit breaker, and a
 *            410 disables your endpoint permanently.
 *   announce Afterwards, on our own retry budget. See the tradeoff below.
 *
 * THE TRADEOFF YOU ARE MAKING BY ACKING EARLY. Once you have returned 2xx,
 * PowerChat considers the event delivered and will never send it again. If your
 * announcement then fails, the retry is YOUR problem — which is why there is an
 * outbox in this file rather than a bare `deliver()` call. The alternative,
 * announcing before acking, means a slow chat platform turns into webhook
 * retries and eventually a disabled endpoint. Ack early and own the retry.
 *
 * NEVER LOG THE SECRET. Not the signing secret, not the community platform's
 * webhook URL (it is a bearer credential — anyone holding it can post to the
 * channel). Both are read from the environment and neither is ever printed.
 */
const http = require('node:http');

const { config } = require('../../src/config');
const { verifyWebhook, createDeliveryDeduper, dispatchEvent } = require('../../src/webhooks');

const WEBHOOK_PATH = '/webhooks/powerchat';
const MAX_BODY_BYTES = 1024 * 1024;

/** Follows arrive in bursts; one message per follower would be unreadable. */
const FOLLOW_COALESCE_MS = 20_000;
/** Our own retry budget for the community platform, not PowerChat's. */
const MAX_ANNOUNCE_ATTEMPTS = 5;

function centsToUsd(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

// --------------------------------------------------------------- formatting

/**
 * `isAnonymous` is not advisory. `donorName` may still be populated on the
 * payload, and printing it because it happens to be there is how a bot outs
 * someone who paid to stay unnamed. Branch on the flag, never on the name.
 */
function formatDonation(data) {
  const who = data.isAnonymous ? 'Someone' : data.donorName || 'Someone';
  const amount = data.amountDisplay || centsToUsd(data.amountUsdCents ?? data.amountCents);
  const note = data.message ? ` — "${data.message}"` : '';
  return `💸 ${who} tipped ${amount}${note}`;
}

function formatSubscription(data) {
  const tier = data.tier ? ` (${data.tier})` : '';
  if (data.isGift) {
    const count = data.giftCount ?? 1;
    // ONE event carries the whole gift bomb, and `subscriberName` is the
    // GIFTER. Announcing per-recipient means inventing recipients you were
    // never told about.
    const target = count === 1 && data.giftRecipientName ? ` to ${data.giftRecipientName}` : '';
    return `🎁 ${data.subscriberName} gifted ${count} sub${count === 1 ? '' : 's'}${target}${tier}`;
  }
  if (data.isResub) {
    const streak = data.streakMonths ? ` — ${data.streakMonths} months` : '';
    return `🔁 ${data.subscriberName} resubscribed${tier}${streak}`;
  }
  return `⭐ ${data.subscriberName} subscribed${tier}`;
}

function formatGoal(data) {
  const goal = data.goal ?? {};
  const value = goal.isMonetary ? centsToUsd(goal.currentValue) : goal.currentValue;
  const target = goal.isMonetary ? centsToUsd(goal.targetValue) : goal.targetValue;
  return `🏁 Goal "${goal.name}" — ${value} / ${target}`;
}

// -------------------------------------------------------------------- bot

function createBot(options = {}) {
  const secret = options.secret ?? config.webhookSecret;
  const now = options.now ?? (() => Date.now());

  /**
   * WHERE THE REAL CHAT PLATFORM GOES.
   *
   * Replace this with one HTTP call and nothing else changes:
   *
   *   Discord — POST process.env.DISCORD_WEBHOOK_URL, body { content: text }
   *   Slack   — POST process.env.SLACK_WEBHOOK_URL,   body { text }
   *
   * Both URLs are bearer credentials: keep them in the environment, never in
   * the repo, and never in a log line. Both platforms rate limit and answer
   * 429 with their own `Retry-After` — which is exactly what the outbox below
   * is for. Return a rejected promise on failure so the outbox can retry.
   */
  const deliver =
    options.deliver ??
    (async ({ channel, text }) => {
      console.log(`  → [${channel}] ${text}`);
    });

  /**
   * At-least-once dedupe, keyed on the delivery id.
   * In production this is a `webhook_deliveries` table with a UNIQUE index on
   * `delivery_id`: `INSERT ... ON CONFLICT DO NOTHING`, and you announce only
   * if a row was actually inserted. That INSERT is what makes it correct with
   * several receivers behind a load balancer — an in-memory Set is per-process
   * and empty again after a restart, so a retry that arrives after a deploy
   * would be announced twice.
   */
  const deduper = options.deduper ?? createDeliveryDeduper();

  /**
   * Announcements that have not been delivered yet.
   * In production this is an `announcement_outbox` table (id, delivery_id,
   * channel, text, attempts, next_attempt_at) drained by a worker, with a
   * UNIQUE index on delivery_id so two workers cannot post the same message.
   */
  const outbox = [];

  /**
   * Buffered follows awaiting their coalescing window.
   * Losing this buffer on restart is acceptable — a missed follow announcement
   * is cosmetic. Money is never buffered; it is queued immediately.
   */
  let followBuffer = [];
  let followTimer = null;

  const stats = { received: 0, rejected: 0, duplicates: 0, announced: 0, failed: 0, skipped: 0 };

  function enqueue(channel, text, deliveryId) {
    outbox.push({ channel, text, deliveryId, attempts: 0, nextAttemptAt: now() });
  }

  async function drain() {
    for (let i = 0; i < outbox.length; ) {
      const item = outbox[i];
      if (item.nextAttemptAt > now()) {
        i += 1;
        continue;
      }
      try {
        await deliver({ channel: item.channel, text: item.text });
        outbox.splice(i, 1);
        stats.announced += 1;
      } catch (err) {
        item.attempts += 1;
        if (item.attempts >= MAX_ANNOUNCE_ATTEMPTS) {
          // Dead-letter rather than retry forever. A message nobody can post
          // is a bug to look at, not a queue to grow. PowerChat will not
          // resend it — we already acked — so this line is the only record.
          console.warn(`  [outbox] giving up on ${item.deliveryId}: ${err.message}`);
          outbox.splice(i, 1);
          stats.failed += 1;
          continue;
        }
        item.nextAttemptAt =
          now() + Math.round(Math.min(60_000, 1000 * 2 ** item.attempts) * (0.5 + Math.random()));
        i += 1;
      }
    }
  }

  function flushFollows() {
    followTimer = null;
    const names = followBuffer;
    followBuffer = [];
    if (!names.length) return;
    const text =
      names.length === 1
        ? `👋 ${names[0].name} just followed`
        : `👋 ${names.length} new followers — ${names
            .slice(0, 5)
            .map((n) => n.name)
            .join(', ')}` + (names.length > 5 ? `, +${names.length - 5} more` : '');
    enqueue('community', text, names[0].deliveryId);
    drain();
  }

  function bufferFollow(name, deliveryId) {
    followBuffer.push({ name, deliveryId });
    if (!followTimer) {
      followTimer = setTimeout(flushFollows, FOLLOW_COALESCE_MS);
      followTimer.unref?.();
    }
  }

  /** Runs AFTER the 2xx has already gone out. Must never throw. */
  function announce(event, deliveryId) {
    dispatchEvent(event, {
      'donation.completed': (e) => {
        const data = e.data ?? {};

        // A tip that charged nothing. `isTest` is true for the streamer's free
        // test method, a page with no payout provider connected, and dashboard
        // test fires. Announcing one in the community channel is announcing
        // money that does not exist — so it goes to the staging channel with
        // its own marker, and never to the room the community reads.
        if (data.isTest) {
          stats.skipped += 1;
          enqueue('integration-testing', `[TEST] ${formatDonation(data)}`, deliveryId);
          return;
        }

        // Defensive, and cheap. A zero or missing amount is not a tip worth a
        // notification, and it is exactly the shape a bad payload takes.
        const cents = Number(data.amountUsdCents ?? data.amountCents);
        if (!Number.isFinite(cents) || cents <= 0) {
          stats.skipped += 1;
          return;
        }

        enqueue('community', formatDonation(data), deliveryId);
      },

      // THE DOUBLE-COUNT TRAP. A tip WITH a message fires BOTH
      // donation.completed and paid_message.created — identical data,
      // different delivery ids, so the deduper cannot save you. They are two
      // genuinely distinct deliveries of one event. Announce (and credit) on
      // donation.completed only; this one is the display/chat event.
      'paid_message.created': () => {
        stats.skipped += 1;
      },

      'subscription.created': (e) =>
        enqueue('community', formatSubscription(e.data ?? {}), deliveryId),

      // Coalesced: a follow raid should be one line, not forty.
      'follow.created': (e) => bufferFollow((e.data ?? {}).followerName || 'Someone', deliveryId),

      // Progress is serialized fresh AT DELIVERY TIME — PowerChat stores no
      // payload snapshot — so a retry can legitimately report a HIGHER number
      // than the first attempt did. Read it as "where the goal is now", never
      // as a replay of the original moment.
      'goal.completed': (e) => enqueue('community', formatGoal(e.data ?? {}), deliveryId),

      '*': () => {
        stats.skipped += 1;
      },
    });
    drain();
  }

  /** Collect the body as RAW BYTES. The signature is over the bytes. */
  function readRawBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handleRequest(req, res) {
    if (req.method !== 'POST' || !req.url.startsWith(WEBHOOK_PATH)) {
      res.writeHead(404).end();
      return;
    }

    let raw;
    try {
      raw = await readRawBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":"too large"}');
      return;
    }

    stats.received += 1;

    // Signature, replay window, and JSON parse in one call.
    const verified = verifyWebhook(raw, req.headers, secret);
    if (!verified.ok) {
      // 4xx is TERMINAL — PowerChat will not retry. That is right for a bad
      // signature and wrong for a bug in our own handler, which is precisely
      // why handler work happens after the response and not here.
      stats.rejected += 1;
      console.warn(`[webhook] rejected: ${verified.reason}`);
      res
        .writeHead(400, { 'content-type': 'application/json' })
        .end('{"error":"invalid signature"}');
      return;
    }

    const deliveryId = String(req.headers['x-powerchat-delivery-id'] || verified.event?.id || '');
    const fresh = deduper.accept(deliveryId);

    // ACK NOW. Everything below this line is on our own time.
    res.writeHead(202, { 'content-type': 'application/json' }).end('{"received":true}');

    if (!fresh) {
      stats.duplicates += 1;
      console.log(`[webhook] duplicate ${deliveryId} ignored`);
      return;
    }

    const attempt = Number(req.headers['x-powerchat-delivery-attempt'] || 1);
    console.log(`[webhook] ${verified.event?.type} delivery=${deliveryId} attempt=${attempt}`);
    setImmediate(() => announce(verified.event, deliveryId));
  }

  return { handleRequest, announce, drain, stats, outbox, path: WEBHOOK_PATH };
}

// ------------------------------------------------------------------- server

function main() {
  if (!config.webhookSecret) {
    console.error(
      'Missing POWERCHAT_WEBHOOK_SECRET.\n' +
        'Register a receiver in the dashboard (Developer API -> your app -> Webhooks); the\n' +
        'signing secret (pcw_...) is shown exactly once. Without it every delivery is\n' +
        'rejected, which is the correct behaviour — an unverified receiver is an open\n' +
        'endpoint anyone can post fake donations to.',
    );
    process.exitCode = 1;
    return;
  }

  const bot = createBot();
  const server = http.createServer((req, res) => {
    bot.handleRequest(req, res).catch((err) => {
      console.error('[webhook] handler threw:', err.message);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  server.listen(config.port, () => {
    console.log(`community-bot listening on http://localhost:${config.port}${bot.path}`);
    console.log('PowerChat only delivers to a public HTTPS URL, so expose this with a tunnel');
    console.log('(ngrok / cloudflared / tailscale funnel) and register that URL as the receiver.');
    console.log('Then press "Send test webhook" in the dashboard: it fires one fully signed');
    console.log('delivery with data.isTest = true, which this bot routes to #integration-testing');
    console.log('rather than the community channel — proving both halves of the isTest rule.');
  });
}

if (require.main === module) main();

module.exports = { createBot, formatDonation, formatSubscription, formatGoal, WEBHOOK_PATH };
