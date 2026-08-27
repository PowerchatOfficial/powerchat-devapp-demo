'use strict';
/**
 * 11 — Tip checkout links: sending a viewer to pay, and knowing who paid.
 *
 * Demonstrates
 *   GET /streamers/:u/tip-checkout-link?ref&redirect_uri&amount_cents&purpose
 *       [checkout:attribute]
 *
 * This endpoint answers the question every integration eventually asks: "a
 * viewer tipped — which of MY users was that?" PowerChat does not know your
 * users, so you attach your own id on the way in and read it back on the way
 * out. That id is `ref`.
 *
 * THE CORRELATION LOOP, end to end:
 *   1. Your app MINTS a link via this endpoint with ref = your own user/order
 *      id (≤128 chars). PowerChat records the ref server-side in a checkout
 *      intent and hands back a URL carrying only an opaque `app_intent`.
 *   2. The viewer tips on PowerChat's tip page. You are not involved.
 *   3. Your `donation.completed` WEBHOOK arrives with appExternalRef = your ref.
 *      → THIS is where you credit the user. Nowhere else.
 *   4. Optionally the viewer is redirected back to you with app_ref in the URL.
 *      → This is a UX convenience. Anyone can type that URL. Never credit it.
 *   5. GET /paid-messages also echoes appExternalRef, so you can reconcile or
 *      backfill anything a webhook outage lost (example 12).
 *
 * WHY YOU MUST MINT, AND NEVER HAND-BUILD THE LINK. It is tempting to skip the
 * API call and render `…/tip?app_client_id=…&app_ref=<userId>` yourself —
 * a thousand "Tip me" buttons, no round trips. Do not, if you need to know who
 * paid. That URL goes through the viewer's browser, and `app_ref` in a query
 * string is one keystroke away from being someone ELSE's order id: a viewer
 * pays $5 with a swapped ref and your webhook handler credits the wrong
 * account. PowerChat therefore treats a hand-built ref as UNTRUSTED input —
 * it is not surfaced as `appExternalRef`. Only a ref pinned inside a
 * server-minted intent is, because the viewer never sees or edits it. Every
 * call to this endpoint mints an intent, terms or no terms.
 *
 * Refs are scoped per app: only YOUR app sees your refs, and they survive an
 * anonymous tip — the viewer stays anonymous to the streamer while you still
 * learn which of your users it was.
 *
 * Scope required: checkout:attribute
 * Run: node examples/11-tip-checkout-link.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

/** Never log an intent token in full — it is a single-use bearer credential. */
function redactIntent(rawUrl) {
  const url = new URL(rawUrl);
  const intent = url.searchParams.get('app_intent');
  if (intent) url.searchParams.set('app_intent', intent.slice(0, 8) + '…redacted');
  return url.toString();
}

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  // Your id for the person about to tip. A user id, an order id, a cart id —
  // whatever you will look up when the webhook lands. Make it meaningless to
  // outsiders: it travels through a viewer's browser.
  const ref = 'user_8f3c21';

  // ── Shape A: a minted link, no terms ────────────────────────────────────
  // The viewer picks their own amount. Even with nothing pinned, PowerChat
  // mints a single-use, one-hour intent and the URL carries only an opaque
  // `app_intent` — your ref is held server-side, invisible and uneditable,
  // which is exactly what makes it come back as `appExternalRef` on the
  // webhook. Mint per viewer journey; an intent funds one tip.
  console.log('\n[A] minted link, viewer chooses the amount');
  const simple = await client.tipCheckoutLink(streamer, { ref });
  console.log('  ' + redactIntent(simple.url));
  console.log('  expiresAt:', simple.expiresAt ?? '(see response)', '(one hour, single use)');
  console.log('  NOT the same as building ?app_client_id=&app_ref= by hand: a hand-built');
  console.log('  ref is viewer-editable, so PowerChat surfaces it as untrusted, never as');
  console.log('  appExternalRef. For a static "Tip me" button with no correlation, a plain');
  console.log(`  ${config.baseUrl}/${streamer}/tip link is fine — just do not expect a ref back.`);

  // ── Shape B: a fixed-price intent ───────────────────────────────────────
  // The moment you pass ANY term — amountCents, purpose, or redirectUri —
  // PowerChat mints a single-use checkout INTENT server-side and hands back a
  // URL carrying ONLY an opaque `app_intent` token. The terms never appear in
  // the URL, so there is nothing for a viewer to edit: the tip page renders
  // the amount read-only and the submit is refused unless it matches.
  //
  // This is how you price something through tips — a membership, an unlock, a
  // named goal contribution — without trusting the browser with the price.
  console.log('\n[B] fixed-price intent — $5.00, terms held server-side too');
  const intent = await client.tipCheckoutLink(streamer, {
    amountCents: 500, // 50–1,000,000 (i.e. $0.50–$10,000)
    purpose: 'sub_premium', // your own vocabulary; echoed back as appPurpose
    ref, // still your correlation id
    // Must EXACTLY match a redirect URI registered on your app, or you get a
    // 403. Same allow-list as OAuth, for the same reason.
    redirectUri: config.redirectUri,
  });
  console.log('  ' + redactIntent(intent.url));
  console.log('  expiresAt:', intent.expiresAt, '(one hour, single use)');
  console.log('  the URL carries app_intent and nothing else — no amount, no ref, no purpose.');
  console.log('  ONE intent funds ONE tip. Mint a fresh link per viewer journey; do not');
  console.log('  cache one and hand it to two people, because the second one will fail.');

  // ── What comes back, and what you may believe ───────────────────────────
  console.log('\n[return redirect] after the tip, the viewer lands on your redirect URI with:');
  console.log('  powerchat_status=completed&powerchat_event_id=<id>&app_ref=…&app_purpose=…');
  console.log('  Use it to say "thanks, unlocking now" — a spinner, not a grant.');
  console.log('  It is an unauthenticated GET in a browser. Treat it as a hint, never proof.');

  console.log('\n[webhook] the ONLY authoritative confirmation:');
  console.log('  donation.completed → { appExternalRef, appPurpose, amountCents, isTest, … }');
  console.log('  appExternalRef is set only for refs minted through this endpoint.');
  console.log('  Verify the signature, check isTest, check amountCents matches what you');
  console.log('  charged, dedupe on the delivery id, THEN credit the user. See src/webhooks.js.');
  console.log('  A tip WITH a message also fires paid_message.created carrying the same');
  console.log('  data — credit on donation.completed only, or you will double-count.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.status === 403) {
      console.error(
        'HINT — Often the redirect_uri: it must be one of the URIs REGISTERED on your app,\n' +
          `  matched exactly (currently sending ${config.redirectUri}).\n` +
          '  Otherwise checkout:attribute was never requested in the authorize `scope`.',
      );
    } else if (err.isAuthProblem) {
      console.error('HINT — Expired token, or checkout:attribute was not granted. Check GET /me.');
    } else if (err.isRetryable) {
      console.error('HINT — Rate limited or a server blip. Retry with backoff.');
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
