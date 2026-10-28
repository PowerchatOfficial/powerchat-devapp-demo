'use strict';
/**
 * A custom-platform bot. Forward chat lines to bot/run and print replies.
 * Lines on stdin use: viewer-id|viewer-name|message-id|chat text
 * Your site's chat adapter should call forwardLine() and postChat() instead.
 */
const readline = require('node:readline');
const { config, requireConfig } = require('../../src/config');
const { PowerChatClient } = require('../../src/powerchat');
const { createEnvTokenSource } = require('../../src/credentials');

async function main() {
  requireConfig('accessToken', 'streamer');
  const { getAccessToken } = createEnvTokenSource();
  const client = new PowerChatClient({ baseUrl: config.baseUrl, getAccessToken });
  const user = config.streamer;
  // These declarations are safe to repeat. PowerChat owns the queue and commands.
  await client.putList(user, 'queue', { name: 'Join queue', unique: true, open: true });
  for (const [name, response] of Object.entries({
    join: '{list:queue:join}', leave: '{list:queue:leave}',
    position: '{list:queue:position}', next: '{list:queue:next}',
  })) await client.putBotCommand(user, name, {
    response, platforms: ['apps'], permission: name === 'next' ? 'moderator' : 'everyone',
  });

  async function postChat(text) {
    // Replace this with the other site's chat-send call. Never send bot replies
    // back through bot/run, or the bot may answer its own output.
    console.log(`BOT: ${text}`);
  }
  async function forwardLine(line) {
    const [id, name, messageId, ...parts] = line.split('|');
    const text = parts.join('|');
    if (!id || !name || !messageId || !text) return;
    const result = await client.botRun(user, { text, user: { id, name }, messageId });
    if (result.reply) await postChat(result.reply);
  }
  async function printQueue() {
    console.log('Lists:', JSON.stringify(await client.lists(user)));
    console.log('Queue entries:', JSON.stringify(await client.listEntries(user, 'queue')));
  }
  await printQueue();
  console.log('Enter viewer-id|viewer-name|message-id|chat text, or /queue to print the queue.');
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    try {
      if (line === '/queue') await printQueue();
      else await forwardLine(line);
    } catch (err) { console.error('Could not process line:', err.message); }
  }
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
