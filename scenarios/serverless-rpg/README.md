# Serverless RPG

Viewers earn gold and XP by chatting and watching. They can mine ore, forge a sword, open a crate, check their inventory, and see the gold leaders in chat. PowerChat stores the balances and inventory and answers the commands.

## Run it

Set `POWERCHAT_ACCESS_TOKEN` and `POWERCHAT_STREAMER` in `.env`, then run:

```bash
node scenarios/serverless-rpg/setup.js
```

The app needs `data:read`, `data:write`, and `bot:commands`. The streamer must enable the bot. The script declares two stats, three items and seven template commands. Run it again to update those definitions. Once it exits, earning, levels, crafting and command replies run on PowerChat. No developer process stays up. The `!crate` command grants loot; the item's gold price is for the shop and does not charge this grant.

Try `!gold`, `!mine` twice, `!forge`, `!crate`, `!inventory`, `!topgold`, and `!level`. The gold and XP earn rules use chat and watch activity. `!mine` gives ore directly so the crafting flow is easy to try.

## Where state lives

| Mode | What runs where | Pick it when |
| --- | --- | --- |
| Self-hosted | Your server stores balances, rules and effects; PowerChat displays the results. | Your app already owns the game rules or needs custom effects. |
| PowerChat-hosted | PowerChat stores viewer data and runs earn rules, crafting, queues and templates. | The built-in rules cover the whole feature and you want a one-time setup. |
| Hybrid | Your server decides special outcomes; PowerChat stores balances and applies transactions. | You need custom game logic and shared viewer data. |

This scenario uses PowerChat-hosted mode. [`interactive-overlay`](../interactive-overlay/) is the self-hosted counterpart: its process owns the reward ledger and sends display updates to PowerChat.
