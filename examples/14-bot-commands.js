'use strict';
/**
 * 14 — Template commands, app-answered commands, and bring-your-own-bot.
 *
 * Scopes: bot:commands, bot:write, stream:read
 * Run: node examples/14-bot-commands.js
 */
const { config, requireConfig } = require('../src/config');
const { PowerChatClient } = require('../src/powerchat');
const { createEnvTokenSource } = require('../src/credentials');

async function main() {
  requireConfig('accessToken', 'streamer');
  const { getAccessToken } = createEnvTokenSource();
  const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });
  const user = config.streamer;

  // PowerChat renders this response. No process has to stay up for !hello.
  await client.putBotCommand(user, 'hello', {
    response: 'Hello {user}.', description: 'Greet the viewer',
  });
  // With no response, PowerChat checks permission and cooldown, then emits bot.command.
  await client.putBotCommand(user, 'song', {
    description: 'Ask the music app for the current song', userCooldownSec: 10,
  });
  console.log('Registered !hello and !song. Waiting for !song; press Ctrl-C to stop.');

  const run = await client.botRun(user, {
    text: '!hello', user: { id: 'demo-viewer', name: 'DemoViewer' },
    messageId: 'demo-hello',
  });
  console.log('Local bot reply:', run.reply ?? run.reason ?? '(no reply)');

  let lastEventId;
  let handle;
  let stopped = false;
  let delay = 1000;
  async function connect() {
    if (stopped) return;
    handle = await client.openStream(user, {
      topics: ['bot'], lastEventId,
      onEvent(event) {
        if (event.id) lastEventId = event.id;
        delay = 1000;
        if (event.type !== 'bot.command' || event.data.command !== 'song') return;
        // The SSE callback is synchronous, so handle the send as a promise.
        const command = event.data;
        const replyTo = {
          platform: command.platform === 'developer_app' ? 'app' : command.platform,
          messageId: command.messageId,
          ...(command.sourceAppId ? { appId: command.sourceAppId } : {}),
        };
        client.botMessage(user, { text: 'The music app says: no song is playing.', replyTo })
          .then((result) => console.log('Replied to !song:', JSON.stringify(result)))
          .catch((err) => console.error('Could not answer !song:', err.message));
      },
      onClose: reconnect,
      onError(err) { console.error('Bot stream:', err.message); reconnect(); },
    });
  }
  function reconnect() {
    if (stopped) return;
    setTimeout(() => connect().catch((err) => {
      console.error('Reconnect failed:', err.message);
      reconnect();
    }), delay);
    delay = Math.min(delay * 2, 30000);
  }
  process.on('SIGINT', () => { stopped = true; handle?.close(); });
  await connect();
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
