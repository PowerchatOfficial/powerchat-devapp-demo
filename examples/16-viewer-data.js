'use strict';
/**
 * 16 — Stats, items, one atomic transaction, a list, and a versioned save.
 *
 * Scopes: data:read, data:write
 * Run: node examples/16-viewer-data.js [platform] [viewer-id] [viewer-name] [transaction-id]
 * Reuse the transaction id when retrying the same operations after a timeout.
 */
const { randomUUID } = require('node:crypto');
const { config, requireConfig } = require('../src/config');
const { PowerChatClient, PowerChatApiError } = require('../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({ baseUrl: config.baseUrl, accessToken: config.accessToken });
  const user = config.streamer;
  const viewer = { platform: process.argv[2] || 'twitch', id: process.argv[3] || 'demo-viewer', name: process.argv[4] || 'DemoViewer' };
  const transactionId = process.argv[5] || randomUUID();

  await client.putStat(user, 'gold', {
    label: 'Gold', spendable: true, earnRules: [
      { on: 'chat', amount: 1, cooldownSec: 60 },
      { on: 'watch', amount: 2, everyMinutes: 5 },
    ],
    levels: { type: 'custom', thresholds: [10, 25, 50], titles: ['Novice', 'Scout', 'Knight'] },
    levelUpMessage: '{user} reached level {level}: {title}',
  });
  await client.putItem(user, 'ore', { name: 'Ore' });
  await client.putItem(user, 'sword', { name: 'Sword', recipe: [{ item: 'ore', quantity: 2 }] });
  await client.putItem(user, 'crate', {
    name: 'Crate', kind: 'loot', price: { stat: 'gold', amount: 5 },
    contents: [{ item: 'ore', quantity: 1, weight: 3 }, { item: 'sword', quantity: 1, weight: 1 }],
  });
  console.log('Stats:', JSON.stringify(await client.stats(user)));
  console.log('Items:', JSON.stringify(await client.items(user)));

  // Grant, craft and spend succeed or fail together. The key identifies THIS batch.
  const result = await client.transaction(user, [
    { stat: 'gold', viewer, add: 20 },
    { item: 'ore', viewer, add: 2 },
    { craft: 'sword', viewer, times: 1 },
    { stat: 'gold', viewer, add: -5, requireAtLeast: 5 },
  ], transactionId);
  console.log('Transaction:', JSON.stringify(result));
  console.log('Viewer:', JSON.stringify(await client.viewer(user, viewer.platform, viewer.id)));
  console.log('Leaderboard:', JSON.stringify(await client.leaderboard(user, 'gold')));

  await client.putList(user, 'queue', { name: 'Join queue', unique: true, open: true });
  const added = await client.addListEntry(user, 'queue', { viewer, text: 'Ready to play' });
  console.log('Joined queue:', JSON.stringify(added));
  console.log('Queue:', JSON.stringify(await client.listEntries(user, 'queue')));
  console.log('Next:', JSON.stringify(await client.nextListEntry(user, 'queue')));

  const owner = { username: user, platform: viewer.platform, viewerId: viewer.id };
  // 0 is create-only. If this script ran before, read its current version.
  let current;
  try { current = await client.getDocument('viewer', 'saves', 'current', owner); }
  catch (err) { if (!(err instanceof PowerChatApiError) || err.status !== 404) throw err; }
  const version = current?.version ?? 0;
  const saved = await client.putDocument('viewer', 'saves', 'current', {
    data: { stage: 'forge', visits: 0 }, ifVersion: version,
  }, owner);
  console.log('Saved:', JSON.stringify(saved));
  console.log('Patched:', JSON.stringify(await client.patchDocument('viewer', 'saves', 'current', {
    increment: { visits: 1 }, ifVersion: saved.version,
  }, owner)));
  console.log('Ledger:', JSON.stringify(await client.ledger(user)));
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
