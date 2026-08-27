'use strict';
/**
 * Env loading with a readable failure. Reads a local `.env` if present (no
 * dotenv dependency — it is a dozen lines) and validates what each command
 * actually needs, so a missing variable tells you which one and why.
 */
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const config = {
  baseUrl: process.env.POWERCHAT_BASE_URL || 'https://powerchat.live',
  clientId: process.env.POWERCHAT_CLIENT_ID || '',
  clientSecret: process.env.POWERCHAT_CLIENT_SECRET || '',
  redirectUri: process.env.POWERCHAT_REDIRECT_URI || 'http://localhost:4000/oauth/callback',
  webhookSecret: process.env.POWERCHAT_WEBHOOK_SECRET || '',
  /** Set once you have connected a streamer, so the example scripts can run headless. */
  accessToken: process.env.POWERCHAT_ACCESS_TOKEN || '',
  refreshToken: process.env.POWERCHAT_REFRESH_TOKEN || '',
  streamer: process.env.POWERCHAT_STREAMER || '',
  port: Number(process.env.PORT || 4000),
};

/** Fail loudly and specifically instead of sending an empty Bearer token. */
function require_(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    const names = missing.map((k) => k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase());
    console.error(
      `\nMissing required config: ${names.map((n) => 'POWERCHAT_' + n).join(', ')}\n` +
        `Copy .env.example to .env and fill it in — see the README.\n`,
    );
    process.exit(1);
  }
  return config;
}

module.exports = { config, requireConfig: require_ };
