'use strict';
/**
 * CHARITY CAMPAIGN — the ledger behind the fundraiser page.
 *
 * A charity stream has one number that matters and it is on a screen behind
 * the streamer's head, so it has to be right. Everything in this file exists
 * to protect that number:
 *
 *   · integer cents, end to end — never a float, never a Number that has been
 *     through a division
 *   · `amountUsdCents`, not `amountCents`, because a mixed-currency total made
 *     of native amounts is not a total, it is a coincidence
 *   · dedupe on `eventId`, so the same donation counted from the webhook and
 *     from the startup backfill is counted once
 *   · `isTest` never counts. A rehearsal on the fundraiser total is a lie
 *     told to donors.
 *
 * Milestone alerts are DISPLAY-ONLY: `alerts/rich` puts a card on the overlay
 * and touches nothing else. It does not credit the creator's goals, their
 * subathon timer, their leaderboard, or their tip totals — that is enforced
 * server-side, not by convention. Our total is ours; theirs is theirs.
 */
const { PowerChatApiError } = require('../../src/powerchat');

const BACKFILL_PAGE_SIZE = 100;
const MAX_DONORS_KEPT = 50;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Alerts are the tightest bucket in the API (~30/min) because an alert storm
 * looks exactly like an attack on someone's overlay. Only 429 and 5xx are
 * retryable; a 403 means the scope is missing and will mean that forever.
 */
async function withRateLimitRetry(fn, { attempts = 3, baseDelayMs = 800, label = 'call' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof PowerChatApiError && err.isRetryable;
      if (!retryable || attempt === attempts) throw err;
      const hinted = Number(err.details?.retryAfterSeconds);
      const delay = Number.isFinite(hinted)
        ? hinted * 1000
        : baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 400);
      console.warn(`[campaign] ${label} got ${err.status}; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * The campaign.
 *
 * IN PRODUCTION THIS IS A ROW AND A TABLE:
 *   campaigns(id PK, title, goal_cents, raised_cents)
 *   campaign_donations(event_id PK, campaign_id, usd_cents, display_name,
 *                      is_anonymous, occurred_at)   -- UNIQUE INDEX on event_id
 *   campaign_milestones(campaign_id, cents, fired_at, PRIMARY KEY (campaign_id, cents))
 *
 * The unique index on `event_id` is what makes a replayed webhook, a second
 * app server, and the startup backfill all agree on the total. Do not compute
 * `raised_cents` by adding to a counter in application code and hoping; make
 * it `SELECT sum(usd_cents)` over that table, or maintain it in the same
 * transaction as the insert. A total you cannot recompute is a total you
 * cannot defend when a donor emails asking where their $50 went.
 */
function createCampaign({ id = 'campaign_1', title, goalCents, milestonesCents = [] } = {}) {
  if (!Number.isInteger(goalCents) || goalCents <= 0) {
    throw new Error('goalCents must be a positive integer number of cents');
  }
  return {
    id,
    title: title || 'Charity stream',
    goalCents,
    // Sorted and de-duplicated once, so crossing logic never depends on the
    // order someone happened to type them in.
    milestonesCents: [...new Set(milestonesCents)].sort((a, b) => a - b),
    raisedCents: 0,
    donationCount: 0,
    donors: [],
    creditedEventIds: new Set(),
    firedMilestones: new Set(),
    startedAt: Date.now(),
  };
}

/** The webhook payload, reduced to the fields the fundraiser cares about. */
function fromWebhook(data) {
  return {
    eventId: data?.eventId ?? null,
    usdCents: data?.amountUsdCents,
    amountDisplay: data?.amountDisplay ?? null,
    donorName: data?.donorName ?? null,
    isAnonymous: Boolean(data?.isAnonymous),
    isTest: Boolean(data?.isTest),
    message: data?.message ?? null,
    occurredAt: data?.occurredAt ?? null,
  };
}

/**
 * A `paid-messages` row, reduced to the same shape.
 *
 * That endpoint returns only confirmed, non-test money and excludes
 * display-only alerts by construction, so `isTest` is always false here — we
 * set it anyway so both paths hit the identical guards. Two normalisers, one
 * `applyDonation`: the backfill and the live feed can never drift.
 */
function fromPaidMessageRow(row) {
  return {
    eventId: row?.eventId ?? null,
    usdCents: row?.amountUsdCents,
    amountDisplay: row?.amountDisplay ?? null,
    donorName: row?.donorName ?? null,
    isAnonymous: Boolean(row?.isAnonymous),
    isTest: false,
    message: row?.message ?? null,
    occurredAt: row?.occurredAt ?? null,
  };
}

/**
 * Add one donation to the total. The only function that may change
 * `raisedCents`.
 *
 * @param {object} options
 * @param {boolean} options.silentMilestones
 *        Mark newly crossed milestones as fired WITHOUT returning them to be
 *        announced. Used by the startup backfill: replaying six months of
 *        donations should reproduce the total, not empty six months of
 *        confetti onto a live overlay.
 * @returns {{ applied: boolean, reason: string, crossed: number[] }}
 */
function applyDonation(campaign, donation, { silentMilestones = false } = {}) {
  const { eventId, usdCents } = donation;

  // A test fire carries a real-looking payload. It never touches the total.
  if (donation.isTest) return { applied: false, reason: 'isTest', crossed: [] };

  // Integer cents or nothing. A float here would compound across a thousand
  // donations into a total that is visibly wrong on a screen behind someone's
  // head, and the fix would be a full recount mid-stream.
  if (!Number.isInteger(usdCents) || usdCents <= 0) {
    const reason = `non-integer or non-positive amount: ${usdCents}`;
    return { applied: false, reason, crossed: [] };
  }

  // The one guard that makes webhooks, retries and the backfill compose.
  if (eventId && campaign.creditedEventIds.has(eventId)) {
    return { applied: false, reason: 'already counted', crossed: [] };
  }
  if (eventId) campaign.creditedEventIds.add(eventId);

  campaign.raisedCents += usdCents;
  campaign.donationCount += 1;

  // The donor wall. If the donor chose anonymity we do not store the name —
  // not "store it and hide it in the template", which is one careless
  // `JSON.stringify` away from being on the public page. PowerChat already
  // sends 'Anonymous' here; dropping it ourselves means a future refactor
  // cannot undo the promise.
  campaign.donors.unshift({
    name: donation.isAnonymous ? null : donation.donorName,
    usdCents,
    amountDisplay: donation.amountDisplay,
    message: donation.message ? String(donation.message).slice(0, 140) : null,
    occurredAt: donation.occurredAt,
  });
  if (campaign.donors.length > MAX_DONORS_KEPT) campaign.donors.length = MAX_DONORS_KEPT;

  // Crossing is computed from the TOTAL, not from "this donation pushed us
  // over", so one large gift that clears three milestones at once fires all
  // three, and a replay fires none.
  const crossed = [];
  for (const milestone of campaign.milestonesCents) {
    if (campaign.raisedCents >= milestone && !campaign.firedMilestones.has(milestone)) {
      campaign.firedMilestones.add(milestone);
      if (!silentMilestones) crossed.push(milestone);
    }
  }

  return { applied: true, reason: 'counted', crossed };
}

/**
 * The idempotency key for a milestone alert.
 *
 * Derived from the campaign and the threshold — never from the donation that
 * happened to cross it, and never random. `alerts/rich` dedupes on
 * `externalId`, so even if our in-memory `firedMilestones` is lost in a
 * restart and we try to announce "$1,000 raised" a second time, PowerChat
 * drops it. The overlay is protected by the key, not by our memory.
 */
function milestoneExternalId(campaign, milestoneCents) {
  return `${campaign.id}:milestone:${milestoneCents}`;
}

/**
 * Put a milestone on the overlay. DISPLAY ONLY.
 *
 * This does not credit the creator's tip goal, their subathon clock, their
 * leaderboard, or their totals — `alerts/rich` is written with effect policy
 * `display_only` and cannot. The donations themselves already credited all of
 * that when the viewer tipped; this is the celebration, not the accounting.
 */
async function announceMilestone(client, streamer, campaign, milestoneCents) {
  return withRateLimitRetry(
    () =>
      client.richAlert(streamer, {
        title: `${formatUsd(milestoneCents)} RAISED`,
        message: `${campaign.title} just cleared ${formatUsd(milestoneCents)}. Thank you!`,
        effect: 'confetti',
        accentColor: '#22C55E',
        durationMs: 8000,
        // REQUIRED, and deliberately deterministic. See milestoneExternalId.
        externalId: milestoneExternalId(campaign, milestoneCents),
      }),
    { label: 'alerts/rich' },
  );
}

/**
 * Announce every crossed milestone, and never let the overlay break the
 * ledger.
 *
 * A failed alert is a missing celebration. A thrown exception in the webhook
 * handler is a missing donation. Those are not the same size of problem, so
 * this swallows alert failures with a loud log and lets the total stand.
 */
async function announceMilestones(client, streamer, campaign, crossed) {
  const announced = [];
  for (const milestone of crossed) {
    try {
      await announceMilestone(client, streamer, campaign, milestone);
      announced.push(milestone);
    } catch (err) {
      const hint =
        err instanceof PowerChatApiError && err.status === 403
          ? ' — alerts:rich was never REQUESTED in the authorize scope (GET /me shows the truth)'
          : '';
      console.warn(`[campaign] milestone ${milestone} alert failed: ${err.message}${hint}`);
      // The milestone stays marked as fired. Retrying is safe thanks to the
      // deterministic externalId, but the total is correct either way, and a
      // fundraiser that stalls because an overlay is unhappy is worse than a
      // fundraiser missing one confetti burst.
    }
  }
  return announced;
}

/**
 * Rebuild the total from PowerChat after a restart.
 *
 * Without this, every deploy resets the fundraiser to $0 in front of the
 * audience. `paid-messages` is the pull side of the same confirmed money the
 * webhooks push: newest first, cursor-paginated, test fires and display-only
 * alerts excluded. Replaying it through `applyDonation` reproduces the exact
 * total, and the `eventId` dedupe means a webhook that lands mid-backfill is
 * counted exactly once regardless of which path saw it first.
 *
 * Milestones are seeded SILENTLY: a restart must not re-fire six months of
 * celebrations at a live overlay.
 */
async function backfill(client, streamer, campaign, { maxPages = 40 } = {}) {
  const summary = { pagesRead: 0, rowsSeen: 0, counted: 0, skipped: 0 };
  let cursor;

  while (summary.pagesRead < maxPages) {
    const page = await withRateLimitRetry(
      () => client.paidMessages(streamer, { limit: BACKFILL_PAGE_SIZE, cursor }),
      { label: 'paid-messages' },
    );
    summary.pagesRead += 1;
    const rows = page?.rows ?? [];
    if (!rows.length) break;

    for (const row of rows) {
      summary.rowsSeen += 1;
      const result = applyDonation(campaign, fromPaidMessageRow(row), { silentMilestones: true });
      if (result.applied) summary.counted += 1;
      else summary.skipped += 1;
    }

    // A null cursor is the server saying "end of history" — the one signal
    // worth trusting over a short page.
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return summary;
}

// ------------------------------------------------------------- presentation

/**
 * Integer-safe money formatting. `(cents / 100).toFixed(2)` works fine until
 * it does not, and the amounts here are the fundraiser's public claim about
 * itself. Split the integer instead.
 */
function formatUsd(cents) {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return (cents < 0 ? '-$' : '$') + dollars + '.' + String(abs % 100).padStart(2, '0');
}

/** Integer percentage, clamped. Only ever used for a bar width. */
function progressPercent(campaign) {
  if (campaign.goalCents <= 0) return 0;
  return Math.min(100, Math.floor((campaign.raisedCents * 100) / campaign.goalCents));
}

/**
 * The donor wall. `name: null` means the donor asked to be anonymous, and the
 * only thing this function will ever render for them is "Anonymous".
 */
function donorWall(campaign, limit = 15) {
  return campaign.donors.slice(0, limit).map((donor) => ({
    display: donor.name || 'Anonymous',
    amount: donor.amountDisplay || formatUsd(donor.usdCents),
    message: donor.message,
    occurredAt: donor.occurredAt,
  }));
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * The public page: one string, no framework, no build step.
 *
 * Every donor-supplied value is escaped. A donor wall is user-generated
 * content on a page the creator will put on stream — treat names and messages
 * as hostile, because eventually one of them will be.
 */
function renderPublicPage(campaign, { notice } = {}) {
  const percent = progressPercent(campaign);
  const wall = donorWall(campaign)
    .map(
      (donor) =>
        '<li style="padding:10px 0;border-bottom:1px solid #1c2130">' +
        '<strong>' +
        escapeHtml(donor.display) +
        '</strong> <span style="color:#22C55E">' +
        escapeHtml(donor.amount) +
        '</span>' +
        (donor.message
          ? '<div style="color:#98a2b8;font-size:14px">' + escapeHtml(donor.message) + '</div>'
          : '') +
        '</li>',
    )
    .join('');

  const milestones = campaign.milestonesCents
    .map(
      (cents) =>
        '<li style="color:' +
        (campaign.firedMilestones.has(cents) ? '#22C55E' : '#5c6478') +
        '">' +
        (campaign.firedMilestones.has(cents) ? '✓ ' : '· ') +
        escapeHtml(formatUsd(cents)) +
        '</li>',
    )
    .join('');

  return (
    '<!doctype html><meta charset="utf-8"><title>' +
    escapeHtml(campaign.title) +
    '</title><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="15">' +
    '<body style="background:#0d0f14;color:#e6e8ef;font:16px/1.6 system-ui,sans-serif;' +
    'margin:0;padding:48px 24px"><main style="max-width:64ch;margin:0 auto">' +
    // A total we have not finished rebuilding is worse than no total: donors
    // read it as "my money did not arrive". Say so instead of showing a wrong
    // number confidently.
    (notice
      ? '<p style="background:#3a2a12;border:1px solid #6b4a1c;padding:10px 14px;' +
        'border-radius:8px;color:#f5c96b">' +
        escapeHtml(notice) +
        '</p>'
      : '') +
    '<h1 style="font-size:28px;margin:0">' +
    escapeHtml(campaign.title) +
    '</h1>' +
    '<p style="font-size:44px;font-weight:700;margin:8px 0 0;color:#22C55E">' +
    escapeHtml(formatUsd(campaign.raisedCents)) +
    '</p>' +
    '<p style="color:#98a2b8;margin-top:0">raised of ' +
    escapeHtml(formatUsd(campaign.goalCents)) +
    ' from ' +
    campaign.donationCount +
    ' donation(s)</p>' +
    '<div style="background:#1c2130;border-radius:999px;height:14px;overflow:hidden">' +
    '<div style="background:#22C55E;height:100%;width:' +
    percent +
    '%"></div></div>' +
    '<p style="color:#5c6478;font-size:13px">' +
    percent +
    '% of goal</p>' +
    '<h2 style="font-size:17px;margin-top:32px">Milestones</h2>' +
    '<ul style="list-style:none;padding:0">' +
    milestones +
    '</ul>' +
    '<h2 style="font-size:17px;margin-top:32px">Recent donors</h2>' +
    '<ul style="list-style:none;padding:0">' +
    (wall || '<li style="color:#98a2b8">no donations yet</li>') +
    '</ul>' +
    '<p style="color:#5c6478;font-size:13px;border-top:1px solid #222836;padding-top:16px;' +
    'margin-top:32px">Totals come from signed <code>donation.completed</code> webhooks and ' +
    'are rebuilt from PowerChat on restart. Anonymous donors are never named.</p>'
  );
}

module.exports = {
  announceMilestone,
  announceMilestones,
  applyDonation,
  backfill,
  createCampaign,
  donorWall,
  escapeHtml,
  formatUsd,
  fromPaidMessageRow,
  fromWebhook,
  milestoneExternalId,
  progressPercent,
  renderPublicPage,
  withRateLimitRetry,
};
