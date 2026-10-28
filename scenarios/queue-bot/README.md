# Queue bot for another chat site

The streamer has a join queue. Viewers on a custom chat site type `!join`, `!leave`, or `!position`. A moderator types `!next`. PowerChat stores the queue and renders the command replies. The site's bot forwards each chat line to `POST /bot/run` and posts the returned reply in its own chat.

## Run it

Set `POWERCHAT_ACCESS_TOKEN` and `POWERCHAT_STREAMER` in `.env`. Grant `bot:write`, `bot:commands`, `data:read` and `data:write`, and enable the bot for apps. Then run:

```bash
node scenarios/queue-bot/bot.js
```

Type `viewer-1|Sam|message-1|!join`, then `/queue` to print the moderator's view from `GET /lists` and `GET /lists/queue/entries`. The script uses stdin and stdout as a stand-in for the other site's chat API. Replace `forwardLine`'s input and `postChat`'s output with that site's events and send call. Pass the site's stable message id to `/bot/run`; forward every viewer line once. Do not feed the bot's own reply back in.

The process keeps no queue or viewer state. PowerChat holds the list, checks command permissions and cooldowns, and returns replies. The `!next` template pops the next entry. The moderator console reads the same list through `/lists` endpoints, so a restart does not reset the queue.
