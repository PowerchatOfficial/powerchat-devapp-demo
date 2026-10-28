'use strict';
/** One-time declarations. PowerChat runs earning, crafting and replies after this exits. */
const { config, requireConfig } = require('../../src/config');
const { PowerChatClient } = require('../../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({ baseUrl: config.baseUrl, accessToken: config.accessToken });
  const user = config.streamer;
  await client.putStat(user, 'gold', {
    label: 'Gold', spendable: true,
    earnRules: [{ on: 'chat', amount: 1, cooldownSec: 60 }, { on: 'watch', amount: 2, everyMinutes: 5 }],
  });
  await client.putStat(user, 'xp', {
    label: 'XP', earnRules: [{ on: 'chat', amount: 2, cooldownSec: 60 }, { on: 'follow', amount: 10 }],
    levels: { type: 'custom', thresholds: [10, 30, 60, 100], titles: ['Novice', 'Scout', 'Knight', 'Champion'] },
    levelUpMessage: '{user} reached level {level}: {title}',
  });
  await client.putItem(user, 'ore', { name: 'Ore' });
  await client.putItem(user, 'sword', { name: 'Sword', recipe: [{ item: 'ore', quantity: 2 }] });
  await client.putItem(user, 'crate', {
    name: 'Crate', kind: 'loot', price: { stat: 'gold', amount: 5 },
    contents: [{ item: 'ore', quantity: 1, weight: 3 }, { item: 'sword', quantity: 1, weight: 1 }],
  });
  const commands = {
    gold: 'You have {stat:gold} gold.',
    mine: 'You found ore. {item:ore+1}',
    forge: '{craft:sword} {inventory}',
    crate: 'Opening a crate: {item:crate+1} {inventory}',
    inventory: '{inventory}',
    topgold: '{top:gold}',
    level: '{level:xp}',
  };
  for (const [name, response] of Object.entries(commands)) {
    await client.putBotCommand(user, name, { response });
    console.log(`Registered !${name}`);
  }
  console.log('Setup complete. This process can stop.');
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
