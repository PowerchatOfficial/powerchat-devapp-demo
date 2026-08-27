'use strict';
/**
 * The rotating-token path used by every long-running script: one refresh
 * for N concurrent 401s, and the rotated pair written to .env BEFORE the new
 * access token is handed out.
 *
 * Run:  node --test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A stand-in /oauth/token that rotates the pair and counts calls. It has to
// exist BEFORE src/config is required, because config reads the env at load.
const tokenServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    tokenServer.calls.push(new URLSearchParams(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        access_token: `at_${tokenServer.calls.length}`,
        refresh_token: `rt_${tokenServer.calls.length}`,
        expires_in: 600,
        scope: 'profile:read',
      }),
    );
  });
});
tokenServer.calls = [];

test.before(async () => {
  await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
  process.env.POWERCHAT_BASE_URL = `http://127.0.0.1:${tokenServer.address().port}`;
  process.env.POWERCHAT_CLIENT_ID = 'pca_test';
  process.env.POWERCHAT_CLIENT_SECRET = '';
  process.env.POWERCHAT_ACCESS_TOKEN = 'at_0';
  process.env.POWERCHAT_REFRESH_TOKEN = 'rt_0';
});

test.after(() => tokenServer.close());

test('concurrent forced refreshes collapse into ONE rotation and persist to .env', async () => {
  const { createEnvTokenSource } = require('../src/credentials');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcdemo-env-'));
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    [
      '# keep me',
      'POWERCHAT_BASE_URL=https://powerchat.live',
      'POWERCHAT_ACCESS_TOKEN=at_0',
      'POWERCHAT_REFRESH_TOKEN=rt_0',
      'POWERCHAT_STREAMER=alex',
      '',
    ].join('\n'),
  );

  const logs = [];
  const source = createEnvTokenSource({ envFile, log: (l) => logs.push(l) });

  assert.equal(await source.getAccessToken(), 'at_0', 'no refresh until asked or expired');
  assert.equal(tokenServer.calls.length, 0);

  // Three requests all hit 401 "at once" and each asks for a forced refresh.
  const results = await Promise.all([
    source.getAccessToken(true),
    source.getAccessToken(true),
    source.getAccessToken(true),
  ]);
  assert.deepEqual(results, ['at_1', 'at_1', 'at_1']);
  assert.equal(tokenServer.calls.length, 1, 'exactly one refresh for three concurrent 401s');
  assert.equal(tokenServer.calls[0].get('grant_type'), 'refresh_token');
  assert.equal(tokenServer.calls[0].get('refresh_token'), 'rt_0');

  // The rotated pair is on disk, and nothing else in the file was touched.
  const written = fs.readFileSync(envFile, 'utf8');
  assert.match(written, /^POWERCHAT_ACCESS_TOKEN=at_1$/m);
  assert.match(written, /^POWERCHAT_REFRESH_TOKEN=rt_1$/m);
  assert.match(written, /^# keep me$/m);
  assert.match(written, /^POWERCHAT_STREAMER=alex$/m);
  assert.match(written, /^POWERCHAT_BASE_URL=https:\/\/powerchat\.live$/m);

  // A later refresh uses the ROTATED refresh token, never the dead one.
  assert.equal(await source.getAccessToken(true), 'at_2');
  assert.equal(tokenServer.calls[1].get('refresh_token'), 'rt_1');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^POWERCHAT_REFRESH_TOKEN=rt_2$/m);

  assert.ok(logs.some((l) => l.includes('refreshed the access token')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing .env is created rather than the rotated pair being lost', async () => {
  const { createEnvTokenSource } = require('../src/credentials');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcdemo-env-'));
  const envFile = path.join(dir, '.env');
  const source = createEnvTokenSource({ envFile, log: () => {} });
  await source.getAccessToken(true);
  const written = fs.readFileSync(envFile, 'utf8');
  assert.match(written, /^POWERCHAT_ACCESS_TOKEN=at_\d+$/m);
  assert.match(written, /^POWERCHAT_REFRESH_TOKEN=rt_\d+$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
