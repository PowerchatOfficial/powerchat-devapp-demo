'use strict';
/**
 * 12 — Paid messages: pagination, and the reconciliation channel.
 *
 * Demonstrates
 *   GET /streamers/:u/paid-messages?limit&cursor   [paid_messages:read]
 *
 * This is the ledger of CONFIRMED, non-test tips: real money that actually
 * settled. Test fires and display-only alerts (example 09) are excluded by
 * construction, so anything you read here is safe to reconcile against.
 *
 * Why you want it even though you have webhooks. Webhooks are the real-time,
 * authoritative channel — but they are push, and push fails: your server was
 * redeploying, your endpoint 500'd twenty times and tripped the circuit
 * breaker, a delivery expired. This endpoint is the PULL side of the same
 * data. Every row echoes `appExternalRef` — the `ref` your app minted onto
 * the checkout link (example 11) — so a nightly sweep can find tips you never
 * credited and fix them, with no guessing about who they belonged to.
 *
 * Pagination is cursor-based, newest first. `limit` is 1–100 (default 50).
 *
 * `paidMessages()` resolves `{ rows, nextCursor }`. Pass `nextCursor` back as
 * `cursor` until it comes back null — that null is the server telling you it
 * has reached the end, so you never have to guess from a short page.
 *
 * Scope required: paid_messages:read
 * Run: node examples/12-paid-messages.js [maxPages]
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

const PAGE_SIZE = 25; // small on purpose, so one run shows several pages
const MAX_PAGES = Number(process.argv[2] || 5); // never loop unbounded on someone else's data

function money(cents) {
  return `$${((cents ?? 0) / 100).toFixed(2)}`;
}

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({
    baseUrl: config.baseUrl,
    accessToken: config.accessToken,
  });
  const streamer = config.streamer;

  let cursor;
  let page = 0;
  let total = 0;
  let attributedCents = 0;
  const refs = new Map();

  console.log(`\nReading confirmed tips for ${streamer}, ${PAGE_SIZE} at a time…\n`);

  while (page < MAX_PAGES) {
    const { rows, nextCursor } = await client.paidMessages(streamer, {
      limit: PAGE_SIZE,
      cursor,
    });
    page += 1;
    if (!rows || rows.length === 0) {
      console.log(`page ${page}: empty — end of history.`);
      break;
    }

    console.log(`page ${page} (${rows.length} rows)`);
    for (const row of rows) {
      total += 1;
      // `donorName` is already 'Anonymous' when the tipper chose anonymity —
      // do not try to unmask it. Your appExternalRef still tells you which of
      // YOUR users it was, which is the part you actually need.
      const who = row.isAnonymous ? 'Anonymous' : row.donorName;
      // amountDisplay is the native denomination for display ("500 Hobo
      // Bucks"); amountUsdCents is the normalized value to sum. Never add up
      // amountCents across rows — it is in the row's own currency.
      const amount = row.amountDisplay || money(row.amountUsdCents);
      const ref = row.appExternalRef; // null unless YOUR app minted this link
      console.log(
        `  ${row.occurredAt}  ${amount.padEnd(18)} ${who.padEnd(20)}` +
          (ref ? `  ref=${ref}` : '  (no ref — not from your links)'),
      );
      if (ref) {
        attributedCents += row.amountUsdCents ?? 0;
        refs.set(ref, (refs.get(ref) ?? 0) + 1);
      }
    }

    // A null cursor is the authoritative end-of-run signal.
    if (!nextCursor) {
      console.log('\nlast page (the server returned a null cursor).');
      break;
    }
    cursor = nextCursor;
  }

  if (page >= MAX_PAGES) {
    console.log(`\nStopped at the ${MAX_PAGES}-page guard. Pass a bigger number to go deeper.`);
  }

  console.log(
    `\n${total} tips read, ${refs.size} distinct refs, ` + `${money(attributedCents)} attributed.`,
  );
  console.log('\nAs a reconciliation sweep: for each row with an appExternalRef, look up your');
  console.log('own record for that ref. If it is missing or still pending, the webhook never');
  console.log('landed — credit it now, keyed on eventId so a late delivery cannot double it.');
  console.log('Do not credit rows with no ref: those tips came from somewhere else entirely.');
}

/** Turn a thrown PowerChatApiError into something a human can act on. */
function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    if (err.status === 400) {
      console.error(
        'HINT — limit must be 1–100, and cursor must be an eventId from a previous page.',
      );
    } else if (err.isAuthProblem) {
      console.error(
        'HINT — Expired token, or paid_messages:read was registered on the app but never\n' +
          '  REQUESTED in the authorize `scope` param. GET /me lists the real grants.',
      );
    } else if (err.isRetryable) {
      console.error(
        'HINT — Rate limited (~120/min on reads) or a server blip. Back off and retry.',
      );
    }
  } else {
    console.error('\n' + (err && err.stack ? err.stack : err));
  }
  process.exitCode = 1;
}

main().catch(reportError);
