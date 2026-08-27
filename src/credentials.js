'use strict';
/**
 * Rotating credentials for the headless scripts.
 *
 * A PowerChat access token lives ~10 minutes. Anything that runs longer than
 * that — a view-count heartbeat, an SSE consumer, a webhook server with a
 * reconciliation timer — cannot hold a FIXED token: after expiry every call
 * 401s, the heartbeat lapses, the reconnect loops on a dead credential.
 *
 * `src/powerchat.js` already knows how to recover: give the client a
 * `getAccessToken(forceRefresh)` function instead of an `accessToken` string
 * and it calls that function again after a 401, expecting a fresh token. This
 * file is that function for the `.env`-driven scripts, with the two things a
 * refresh must get right:
 *
 *   1. SINGLE-FLIGHT. Refresh tokens rotate on every use and reuse detection
 *      revokes the whole family. Two parallel requests that both hit a 401 must
 *      share ONE refresh, or the second rotation invalidates the first and
 *      PowerChat treats the replay as theft.
 *   2. PERSIST BEFORE USE. The old refresh token is dead the moment the new
 *      one is minted. If the process dies between "minted" and "saved", the
 *      grant is gone and the streamer has to re-consent. Here the rotated pair
 *      is written back to `.env` (the file `src/config.js` loaded it from)
 *      atomically, before the new access token is handed to any caller. In
 *      production that write is a database row per streamer.
 *
 * Usage:
 *   const { createEnvTokenSource } = require('../src/credentials');
 *   const client = new PowerChatClient({
 *     baseUrl: config.baseUrl,
 *     getAccessToken: createEnvTokenSource().getAccessToken,
 *   });
 */
const fs = require('node:fs');
const path = require('node:path');

const { config, requireConfig, ENV_FILE } = require('./config');
const { refreshTokens } = require('./oauth');

/**
 * Rewrite ONLY the two token lines of a dotenv file, keeping everything else
 * (comments, ordering, other keys) exactly as it was. Atomic: written to a
 * temp file and renamed over the original, so a crash mid-write leaves either
 * the old file or the new one, never half of each.
 */
function persistTokensToEnvFile(file, { accessToken, refreshToken }) {
  const updates = {
    POWERCHAT_ACCESS_TOKEN: accessToken ?? '',
    POWERCHAT_REFRESH_TOKEN: refreshToken ?? '',
  };
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const seen = new Set();
  const lines = existing.split('\n').map((line) => {
    const match = /^\s*(POWERCHAT_ACCESS_TOKEN|POWERCHAT_REFRESH_TOKEN)\s*=/.exec(line);
    if (!match) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const key of Object.keys(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${updates[key]}`);
  }
  const next = lines.join('\n').replace(/\n*$/, '\n');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, next, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Build a `getAccessToken` for `PowerChatClient` from the tokens in `.env`.
 *
 * @param {object} [options]
 * @param {string} [options.envFile]   Where to persist the rotated pair (default: the loaded .env).
 * @param {boolean} [options.persist]  Set false to keep rotation in memory only (tests).
 * @param {(line: string) => void} [options.log]
 */
function createEnvTokenSource({ envFile = ENV_FILE, persist = true, log = console.log } = {}) {
  requireConfig('accessToken');

  let tokens = {
    accessToken: config.accessToken,
    refreshToken: config.refreshToken || null,
    // Unknown for a token pasted into .env — the first 401 drives the refresh.
    expiresAt: null,
  };
  let refreshInFlight = null;

  if (!tokens.refreshToken) {
    log(
      '[credentials] POWERCHAT_REFRESH_TOKEN is not set — the access token cannot be renewed ' +
        'and this process will start failing with 401 once it expires (~10 minutes).',
    );
  } else if (!config.clientId) {
    log(
      '[credentials] POWERCHAT_CLIENT_ID is not set — a refresh needs it, so this process ' +
        'will start failing with 401 once the access token expires (~10 minutes).',
    );
  }

  async function getAccessToken(forceRefresh = false) {
    const clockExpired = typeof tokens.expiresAt === 'number' && Date.now() >= tokens.expiresAt;
    if (!forceRefresh && !clockExpired) return tokens.accessToken;
    // Nothing to refresh with: hand back what we have and let the 401 surface.
    if (!tokens.refreshToken || !config.clientId) return tokens.accessToken;

    if (!refreshInFlight) {
      refreshInFlight = refreshTokens({
        baseUrl: config.baseUrl,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        refreshToken: tokens.refreshToken,
      })
        .then((next) => {
          // Persist FIRST. Using the new access token before the rotated
          // refresh token is durable is how a grant gets lost.
          if (persist) {
            persistTokensToEnvFile(envFile, next);
            log(`[credentials] refreshed the access token; rotated pair saved to ${envFile}`);
          } else {
            log('[credentials] refreshed the access token (not persisted)');
          }
          tokens = { ...tokens, ...next };
          return next.accessToken;
        })
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  }

  return {
    getAccessToken,
    /** For diagnostics only — never print these. */
    get tokens() {
      return { ...tokens };
    },
  };
}

module.exports = { createEnvTokenSource, persistTokensToEnvFile };
