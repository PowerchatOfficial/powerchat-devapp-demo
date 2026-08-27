'use strict';
/**
 * 03 — Send a chat message, then PROVE it was displayed.
 *      POST /api/dev/v1/streamers/:username/chat
 *
 * Demonstrates: the two things developers get wrong about this endpoint.
 *   1. 202 means ACCEPTED FOR MODERATION, not displayed. Read chat/history
 *      back if you need proof.
 *   2. `messageId` is a REQUIRED idempotency key — send the same one twice and
 *      the duplicate is dropped instead of double-posting.
 *
 * Scopes required: chat:write (to send) and chat:read (to read the proof back)
 *
 * Run:  node examples/03-send-chat.js ["your message"]
 */
const { randomUUID } = require('node:crypto');
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** History may arrive as a bare array or wrapped; normalise once, here. */
const asList = (payload) =>
  Array.isArray(payload) ? payload : (payload?.items ?? payload?.messages ?? []);

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // The idempotency key. It must be stable for a given logical message and
  // unique across different ones — your own platform's message id is ideal.
  // A random UUID is right here only because this demo has no upstream id.
  const messageId = `demo-${randomUUID()}`;
  const text = process.argv[2] || `Hello from the PowerChat demo at ${new Date().toISOString()}`;

  const message = {
    chatterName: 'DemoViewer', // 1-48 chars, shown on the overlay
    externalChatterId: 'demo-viewer-1', // 1-128, stable per chatter on YOUR platform
    message: text, // 1-500 chars
    messageId, // 1-128, REQUIRED — the dedupe key
    avatarFallback: 'DV', // 1-8 chars, used when no avatarUrl resolves
    isModerator: false,
    isSubscriber: true,
    occurredAt: new Date().toISOString(), // when it happened on YOUR platform
  };

  console.log(`\nSending as ${message.chatterName}: "${text}"`);
  const accepted = await client.sendChat(streamer, message);
  console.log(`API answered 202 ${JSON.stringify(accepted)}`);

  // ------------------------------------------------------ what 202 does NOT mean
  //
  // 202 means the message was queued for the streamer's moderation pipeline:
  // blocked-word lists, blocked chatters, AI moderation, profanity filters and
  // duplicate-messageId rejection all run AFTER this response. Any of them can
  // drop the message silently — there is no per-message callback telling you so.
  // If display matters, read it back. That is the only source of truth.
  console.log('\n202 = accepted for moderation. Reading chat/history back to confirm display...');

  let found = null;
  for (let attempt = 1; attempt <= 4 && !found; attempt += 1) {
    await sleep(1000); // give the pipeline a moment; it is not synchronous
    const history = asList(await client.chatHistory(streamer, { limit: 50 }));
    found = history.find((m) => m.messageId === messageId || m.message === text) ?? null;
    console.log(`  attempt ${attempt}: ${found ? 'found it' : 'not in history yet'}`);
  }

  if (found) {
    console.log('\nConfirmed displayed:');
    console.log(JSON.stringify(found, null, 2));
  } else {
    console.log(
      '\nAccepted but never displayed. That is a legitimate outcome, not a bug:\n' +
        '  - a moderation rule dropped it (blocked word, blocked chatter, AI moderation)\n' +
        '  - the streamer has this app or this chatter muted\n' +
        '  - the pipeline is slower than this script waited\n' +
        'Never treat 202 alone as "the viewer saw it".',
    );
  }

  // ----------------------------------------------------- idempotency in practice
  //
  // Re-send the IDENTICAL messageId. This is exactly what your retry logic does
  // after a timeout or a 5xx, when you cannot tell whether the first attempt
  // landed. PowerChat answers 202 again — the response is deliberately the same
  // — but the message is deduped downstream and the overlay shows it once.
  // Retrying is therefore always safe, as long as you reuse the messageId.
  console.log(`\nRe-sending the SAME messageId (${messageId}) to show the retry path...`);
  const again = await client.sendChat(streamer, message);
  console.log(`API answered 202 ${JSON.stringify(again)} — same shape, no second message.`);

  const after = asList(await client.chatHistory(streamer, { limit: 50 }));
  const copies = after.filter((m) => m.messageId === messageId || m.message === text).length;
  console.log(`\nCopies of that message now in history: ${copies}`);
  console.log(
    copies <= 1
      ? 'Deduped, as designed. Reuse the messageId on every retry; a fresh one posts twice.'
      : 'More than one copy — check that messageId is really being reused verbatim.',
  );
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — this grant is missing `chat:write` (to send) or `chat:read` (to read the\n' +
          'proof back). Run 01-whoami.js to see what was actually granted.',
      );
    } else if (err.status === 422 || err.status === 400) {
      console.error(
        'HINT — body validation. `messageId` is REQUIRED, `message` is 1-500 chars, and\n' +
          '`avatarUrl` must be an absolute http(s) URL if you send one.',
      );
    } else if (err.status === 429) {
      console.error('HINT 429 — chat shares the ~120 requests/minute read+chat budget. Back off.');
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
