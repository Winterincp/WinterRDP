# Discord MCP Connector (Claude + ChatGPT)

Manage Discord from chat: create channels/roles/whole server layouts, send and schedule announcements,
auto-replies, welcome messages, and see per-hour activity + live logs.

## 1. Create the Discord bot (one-time, ~2 min)
Discord does not allow bots to be created through any API, so this step is manual:
1. https://discord.com/developers/applications → **New Application** → **Bot** → **Reset Token** → copy it.
2. On the same Bot page turn ON **Server Members Intent** and **Message Content Intent**
   (or set `PRIVILEGED_INTENTS=false` to skip them; welcome messages, auto-replies and join/leave logs then won't work).

## 2. Deploy on Railway
1. Push this folder to a GitHub repo → Railway → **New Project → Deploy from GitHub**.
2. Variables:
   - `DISCORD_BOT_TOKEN` = your bot token
   - `MCP_SECRET` = long random string (16+ chars), e.g. `openssl rand -hex 24`
   - optional `PRIVILEGED_INTENTS` (`true` default), `DATA_DIR=/data`
3. Add a **Volume** mounted at `/data` and set `DATA_DIR=/data` so schedules and logs survive redeploys.
4. Settings → Networking → **Generate Domain**.

## 3. Add to Claude / ChatGPT
Connector URL: `https://YOUR-APP.up.railway.app/mcp/YOUR_MCP_SECRET`
- **Claude**: Settings → Connectors → Add custom connector → paste URL.
- **ChatGPT**: Settings → Connectors → Advanced → Developer mode → Create → paste URL, auth: none.

Then ask: "Give me the bot invite link", add the bot to your server, then "Set up a gaming server with
Rules, General and Voice categories" or "Announce in #news every Monday 9AM Manila time".

Live dashboard: `https://YOUR-APP.up.railway.app/dashboard/YOUR_MCP_SECRET`

Keep the secret private: anyone with the URL can control your bot.
