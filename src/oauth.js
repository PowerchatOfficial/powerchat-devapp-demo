'use strict';
/**
 * OAuth2 authorization-code flow with PKCE (S256).
 *
 * PowerChat requires PKCE for PUBLIC clients and accepts it for confidential
 * ones — `plain` is rejected outright, only S256. A confidential app sends its
 * client_secret too; a public app (SPA, desktop, mobile) sends only the
 * verifier and must NOT ship a secret.
 *
 * The three things developers most often get wrong, handled here:
 *   1. REGISTERED IS NOT REQUESTED — every scope you want must appear in the
 *      `scope` parameter of THIS authorize call. Registering it on the app is
 *      not enough; the grant carries only what was requested AND consented.
 *   2. `state` is anti-CSRF and must be verified on the way back.
 *   3. Access tokens are short-lived. Refresh on 401 rather than treating it
 *      as a failure, and persist the rotated refresh token.
 */
const crypto = require('node:crypto');

const b64url = (buf) => buf.toString('base64url');

/** A fresh PKCE pair. Keep the verifier server-side, keyed by `state`. */
function createPkcePair() {
  const codeVerifier = b64url(crypto.randomBytes(32));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}

/** Opaque anti-CSRF value; verify it matches on the callback. */
function createState() {
  return b64url(crypto.randomBytes(24));
}

/**
 * Where to send the streamer's browser.
 * @param {object} o
 * @param {string[]} o.scopes Every scope you need — see REGISTERED IS NOT REQUESTED above.
 */
function buildAuthorizeUrl({ baseUrl, clientId, redirectUri, scopes, state, codeChallenge }) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + '/oauth/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function _postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* fall through */
  }
  if (!res.ok) {
    // Never log the raw body — token responses carry credentials.
    const code = json?.error || json?.error?.code || 'oauth_error';
    throw new Error(`OAuth request failed (HTTP ${res.status}): ${code}`);
  }
  return json;
}

/** Exchange the authorization code for tokens. */
async function exchangeCode({ baseUrl, clientId, clientSecret, redirectUri, code, codeVerifier }) {
  const json = await _postForm(baseUrl.replace(/\/+$/, '') + '/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  return _normalizeTokens(json);
}

/** Trade a refresh token for a fresh access token (rotating the refresh token). */
async function refreshTokens({ baseUrl, clientId, clientSecret, refreshToken }) {
  const json = await _postForm(baseUrl.replace(/\/+$/, '') + '/oauth/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
  return _normalizeTokens(json);
}

/** Revoke on disconnect so the streamer's consent actually goes away. */
async function revokeToken({ baseUrl, clientId, clientSecret, token }) {
  await _postForm(baseUrl.replace(/\/+$/, '') + '/oauth/revoke', {
    token,
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  });
}

/** Discovery document (RFC 8414) — handy for confirming endpoints per host. */
async function discover(baseUrl) {
  const res = await fetch(
    baseUrl.replace(/\/+$/, '') + '/oauth/.well-known/oauth-authorization-server',
  );
  if (!res.ok) throw new Error(`Discovery failed (HTTP ${res.status})`);
  return res.json();
}

function _normalizeTokens(json) {
  const expiresIn = Number(json?.expires_in) || 600;
  return {
    accessToken: json?.access_token ?? null,
    refreshToken: json?.refresh_token ?? null,
    scopes: typeof json?.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
    // Refresh a little early so an in-flight request never races the expiry.
    expiresAt: Date.now() + Math.max(0, expiresIn - 30) * 1000,
  };
}

module.exports = {
  createPkcePair,
  createState,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  revokeToken,
  discover,
};
