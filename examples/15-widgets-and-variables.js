'use strict';
/**
 * 15 — Channel variables and custom widget events.
 *
 * Scope: overlay:write
 * Run: node examples/15-widgets-and-variables.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient } = require('../src/powerchat');

async function main() {
  requireConfig('accessToken', 'streamer');
  const client = new PowerChatClient({ baseUrl: config.baseUrl, accessToken: config.accessToken });
  const user = config.streamer;
  console.log('Set stage to 1:', JSON.stringify(await client.putVariable(user, 'stage', { value: 1 })));
  console.log('Advance stage:', JSON.stringify(await client.putVariable(user, 'stage', { increment: 1 })));
  console.log('Variables:', JSON.stringify(await client.variables(user)));
  console.log('Widget event:', JSON.stringify(await client.widgetEvent(user, {
    name: 'game.stage_changed', data: { stage: 2 },
  })));
  // A custom widget can use Powerchat.on('variable', ...) and
  // Powerchat.on('custom', ({ name, data }) => ...). Values are public overlay data.
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
