'use strict';
/**
 * run.js — one command that plays a whole broadcast.
 *
 * Wires the simulated site (`site.js`) to the integration (`bridge.js`) and
 * scripts roughly sixty seconds of real activity: the channel goes live,
 * viewers arrive and leave, chat flows, someone follows, someone subscribes and
 * then renews, someone drops a gift bomb, the internal bus redelivers a few
 * messages, and the stream ends. Every mirrored call is printed with what
 * PowerChat answered.
 *
 * Two moments are worth waiting for:
 *   1. the REPLAY around +42s — the site redelivers messages it already sent,
 *      and nothing appears twice, because the message ids are derived from the
 *      site's own ids rather than minted per attempt.
 *   2. the READ-BACK at +50s — every chat send answered 202, and this is where
 *      you find out how many of them moderation actually kept.
 *
 * Scopes: chat:write, chat:read, viewcount:write, follows:write,
 *         subscriptions:write. Any you are missing simply switch that one
 *         mirror off; the rest of the broadcast still runs.
 *
 * Run:  node scenarios/streaming-site/run.js
 *       node scenarios/streaming-site/run.js --fast    (same script, ~9s)
 *       Ctrl-C at any point — the shutdown path is the same one the end of the
 *       stream takes, so the view count is still cleared.
 */
const { config, requireConfig } = require('../../src/config');
const { PowerChatClient, PowerChatApiError } = require('../../src/powerchat');
const { createEnvTokenSource } = require('../../src/credentials');
const { createSite, currentTerm } = require('./site');
const { createBridge, SCOPES_USED, HEARTBEAT_MS } = require('./bridge');

/**
 * Where your site's avatars are publicly readable from. This is a real config
 * value, not a demo detail: PowerChat fetches avatars from the open internet,
 * so an internal hostname here shows every one of your chatters as a letter.
 */
const SITE_PUBLIC_ORIGIN = process.env.SITE_PUBLIC_ORIGIN || 'https://cdn.example-stream.tv';

/** `--fast` compresses the script for a quick read; the API calls are identical. */
const SPEED = process.argv.includes('--fast') ? 0.15 : 1;

/** The month after `term` — a renewal, which the script fast-forwards to. */
function nextTerm(term) {
  const [year, month] = term.split('-').map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

/** One timeline line: when, which rail, what we mirrored, what came back. */
function printRecord(entry) {
  const stamp = `+${(entry.t / 1000).toFixed(1)}s`.padStart(7);
  console.log(`${stamp}  ${entry.rail.padEnd(9)}  ${entry.what.padEnd(56)}  ${entry.answer}`);
}

function printSummary(site, bridge, verification) {
  const s = bridge.stats;
  const snap = site.snapshot();

  console.log('\n' + '='.repeat(96));
  console.log('BROADCAST OVER\n');

  console.log('What happened on the site:');
  console.log(
    `  chat messages ${snap.chatMessages}   followers ${snap.followers}   members ${snap.members}   peak viewers ${snap.peakViewers}`,
  );

  console.log('\nWhat reached PowerChat:');
  console.log(
    `  chat          ${s.chat.sent} sent of ${s.chat.seen} seen` +
      `   (${s.chat.deduped} duplicate deliveries suppressed, ${s.chat.overBudget} over budget, ${s.chat.failed} failed)`,
  );
  console.log(
    `  view count    ${s.viewCount.posts} posts, ${s.viewCount.failed} failed, last value ${JSON.stringify(s.viewCount.lastPosted)}`,
  );
  console.log(
    `  follows       ${s.follows.sent} of ${s.follows.seen}   (${s.follows.failed} failed)`,
  );
  console.log(
    `  memberships   ${s.members.sent} of ${s.members.seen}   (${s.members.failed} failed)`,
  );
  if (s.abandoned) {
    console.log(
      `  ABANDONED     ${s.abandoned} event(s) never reached PowerChat — see the timeline above`,
    );
  }

  console.log('\nMirrors:');
  for (const [key, cap] of Object.entries(bridge.caps)) {
    console.log(`  ${key.padEnd(12)} ${cap.enabled ? 'on' : `OFF — ${cap.reason}`}`);
  }

  // ------------------------------------------------------- the 202 lesson, honestly
  console.log('\nThe 202 lesson:');
  if (!verification?.checked) {
    console.log(`  Could not verify (${verification?.reason ?? 'not run'}).`);
    console.log('  Without chat:read you cannot tell an accepted message from a displayed one.');
  } else {
    console.log(`  ${s.chat.sent} message(s) were accepted with 202.`);
    console.log(`  ${verification.confirmed} of them are actually in chat history.`);
    if (verification.missing.length) {
      console.log(`  ${verification.missing.length} were accepted and never displayed:`);
      for (const row of verification.missing.slice(0, 5)) {
        console.log(`    - ${row.messageId}  "${row.text}"`);
      }
      console.log('  That is a legitimate outcome, not a bug: blocked words, a blocked chatter,');
      console.log('  AI moderation, or a pipeline slower than this script waited. 202 means');
      console.log('  ACCEPTED FOR MODERATION. If your product promises "your chat shows on the');
      console.log('  overlay", this read is the only thing that can keep that promise.');
    } else {
      console.log('  Everything landed this time. It will not always — read it back anyway.');
    }
  }

  console.log("\nWhat to check on the streamer's side:");
  console.log(`  - the chat overlay shows your site's messages beside Twitch/Kick, with avatars`);
  console.log(`  - the viewer chip carried your count and disappeared when the stream ended`);
  console.log(`  - one follow alert, one new-member alert, one resub alert, one gift alert of 5`);
  console.log(`  - the gift credited the sub goal 5 times from ONE event, not 5 events`);
  console.log('='.repeat(96) + '\n');
}

async function main() {
  requireConfig('accessToken', 'streamer');
  // The broadcast runs a minute; a real one runs hours, past the ~10-minute
  // access-token lifetime. Build on the refreshing path from the start so the
  // view-count heartbeat never lapses on an expired token.
  const { getAccessToken } = createEnvTokenSource();
  const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });
  const streamer = config.streamer;

  // --------------------------------------------------- ask what we actually have
  //
  // Not what the app registration lists — what THIS grant carries. A scope must
  // be in the authorize call's `scope` parameter to be granted, and a streamer
  // can switch an individual capability off afterwards. The bridge branches on
  // this rather than discovering it one 403 per event.
  const me = await client.me();
  const granted = me.scopes ?? me.grantedScopes ?? [];
  const missing = SCOPES_USED.filter((scope) => !granted.includes(scope));

  console.log(`\nMirroring into @${streamer} on ${config.baseUrl}`);
  console.log(`Avatar origin: ${SITE_PUBLIC_ORIGIN}`);
  if (missing.length) {
    console.log(`Missing scopes: ${missing.join(', ')} — those mirrors stay off for this run.`);
  } else {
    console.log('All five scopes granted.');
  }
  console.log(
    `\nScript: ~${Math.round(56 * SPEED)}s broadcast.` +
      (SPEED === 1 ? `  View-count heartbeat is every ${HEARTBEAT_MS / 1000}s.` : '  (--fast)'),
  );
  console.log('Ctrl-C ends the stream cleanly at any point.\n');
  console.log(
    '   time   rail       mirrored                                                  PowerChat answered',
  );
  console.log('   ' + '-'.repeat(93));

  const site = createSite({ channel: 'aurora_fm' });
  const bridge = createBridge({
    client,
    streamer,
    site,
    grantedScopes: granted,
    publicOrigin: SITE_PUBLIC_ORIGIN,
    log: printRecord,
  });
  bridge.start();

  // ------------------------------------------------------------- the script
  const timers = new Set();
  let verification = null;
  let verifying = null;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });

  const at = (seconds, step) => {
    const timer = setTimeout(
      async () => {
        timers.delete(timer);
        try {
          await step();
        } catch (err) {
          console.error(`  script step at +${seconds}s failed: ${err?.message ?? err}`);
        }
      },
      seconds * 1000 * SPEED,
    );
    timers.add(timer);
  };
  const cancelScript = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  // Ctrl-C takes the same path as the end of the stream: stop the script, drain
  // what is in flight, post `count: null`. Anything less leaves a finished
  // stream advertising viewers for up to 90 seconds.
  bridge.installSignalHandlers({
    onDone: (signal) => {
      cancelScript();
      finish(signal);
    },
  });

  const term = currentTerm();
  const renewalTerm = nextTerm(term);

  at(0, () => site.goLive());

  // Viewers arrive. The bridge does NOT post a view count per join — it
  // coalesces and debounces, because a busy room would otherwise spend the
  // entire 60/min write budget on a number that changes every 200ms.
  at(1, () => site.join('u_1041'));
  at(1.4, () => site.join('u_2277'));
  at(1.8, () => site.join('u_3310'));

  at(3, () => site.say('u_1041', "stream's up — how's the audio?"));
  at(5, () => site.join('u_4102'));
  // Display name is "[MOD] pixel fox": the fallback must read PF, not "[M".
  at(6, () => site.say('u_2277', 'mods are on, be nice in here'));
  at(7, () => site.join('u_6634'));
  at(8, () => site.follow('u_6634'));
  // No avatar at all — the letter placeholder is the CORRECT outcome here.
  at(10, () => site.say('u_3310', 'first time catching this live'));
  at(13, () => site.join('u_5589'));
  // Avatar is an absolute URL pointing at localhost: absolute, and still
  // unfetchable from PowerChat. The bridge drops it rather than shipping it.
  at(15, () => site.say('u_5589', 'audio is good on my end'));

  at(18, () => site.subscribe('u_1041', { tier: 'Supporter', term }));
  // Avatar is a data: URI — valid on your own page, useless to PowerChat.
  at(22, () => site.say('u_4102', 'grabbed a membership too'));

  // A month later, compressed into four seconds. The externalId differs only in
  // the term, which is the entire reason this renewal is not swallowed as a
  // duplicate of the subscription eight seconds ago.
  at(26, () => site.subscribe('u_1041', { tier: 'Supporter', term: renewalTerm }));

  // ONE event carrying giftCount: 5. Five events would credit the sub goal five
  // times for a single action by a single person.
  at(30, () => site.giftMemberships('u_6634', { count: 5, tier: 'Supporter', term }));
  at(34, () => site.say('u_1041', 'thank you for the gifts!'));

  at(38, () => {
    site.leave('u_3310');
    site.leave('u_4102');
  });

  // ------------------------------------------------------------ duplicate delivery
  //
  // The site's internal bus redelivers the last three messages. This is what a
  // catch-up job does after the bridge crashes, and what any at-least-once bus
  // does on its own during a partition. Watch the timeline: three
  // "duplicate suppressed" lines and no second copy on the overlay. A bridge
  // that minted `randomUUID()` message ids would post all three again, with a
  // 202 each time, and the streamer would see everything twice.
  at(42, () => {
    console.log(
      '\n  -- the site redelivers its last 3 messages (crash catch-up / at-least-once bus) --\n',
    );
    site.replayRecentChat(3);
  });

  at(46, () => site.say('u_2277', 'wrapping up, thanks all'));

  // ------------------------------------------------------------------ read-back
  at(50, () => {
    console.log(
      '\n  -- every send above answered 202. Reading chat/history back to see what landed --\n',
    );
    // Kept as a promise rather than awaited here, so `--fast` (which leaves
    // under a second before shutdown) still reports a real answer instead of
    // racing past its own read.
    verifying = bridge.verifyChatDelivery({ limit: 100 });
  });

  at(54, () => site.goOffline());

  at(56, async () => {
    verification = await verifying?.catch((err) => ({
      checked: false,
      reason: String(err?.message ?? err),
    }));
    await bridge.shutdown('end of broadcast');
    finish('script');
  });

  const reason = await done;
  if (reason !== 'script') {
    // Interrupted before the read-back ran: say so rather than guessing.
    verification = verification ?? { checked: false, reason: 'broadcast was interrupted first' };
    console.log(`\n  -- ${reason} — cutting the broadcast short --`);
  }
  printSummary(site, bridge, verification);
}

function reportError(err) {
  if (err instanceof PowerChatApiError) {
    console.error(`\nRequest failed: ${err.message}`);
    if (err.status === 401) {
      console.error('HINT 401 — expired or revoked token. Refresh it, or re-run the OAuth flow.');
    } else if (err.status === 403) {
      console.error(
        'HINT 403 — a scope in the app registration is only a ceiling; it must also be in the\n' +
          "authorize call's `scope` param and consented. Run examples/01-whoami.js to see the\n" +
          'grant as it actually is.',
      );
    } else if (err.status === 429) {
      console.error(
        'HINT 429 — this scenario paces itself, so a 429 here means something else in your\n' +
          'app shares the same app-level budget. Rate limits are per APP, not per process.',
      );
    }
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error(err);
  }
  process.exitCode = 1;
}

main().catch(reportError);
