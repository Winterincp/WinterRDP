# Discord MCP Connector

Remote MCP (Model Context Protocol) server that lets **ChatGPT**, **Claude Desktop**, and any MCP-compatible client manage your Discord servers: send messages, schedule announcements, build server layouts, auto-replies, welcome messages, live logs and more.

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Push this repo to GitHub/GitLab.
2. In Render → **New → Blueprint** → pick the repo (it auto-reads `render.yaml`), or **New → Web Service** and set:
   - **Build Command:** `yarn install --frozen-lockfile`
   - **Start Command:** `yarn start`
   - **Health Check Path:** `/health`
3. Add environment variables:
   - `MCP_SECRET` – random string, 16+ chars (Render can auto-generate it).
   - `DISCORD_BOT_TOKEN` – your bot token from the [Discord Developer Portal](https://discord.com/developers/applications).
   - `PRIVILEGED_INTENTS` – `true` (enable **Server Members Intent** and **Message Content Intent** in the portal).
4. Deploy. Your connector URL is:
   ```
   https://<your-service>.onrender.com/mcp/<YOUR_MCP_SECRET>
   ```

> **Note:** Render free tier filesystem is ephemeral. The app auto-uses `/tmp/discord-mcp-data`. To persist logs/schedules across restarts, attach a **persistent disk** and set `DATA_DIR=/var/data`.

## Connect ChatGPT (Custom Connector)

1. Open ChatGPT → **Settings → Connectors → Add connector**.
2. Paste your connector URL: `https://<your-service>.onrender.com/mcp/<YOUR_MCP_SECRET>`.
3. Name it (e.g. "Discord Admin") and save. Tools like `send_message`, `schedule_announcement`, `setup_server`, `bot_status` become available.

## Connect Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "discord": {
      "transport": "streamable-http",
      "url": "https://<your-service>.onrender.com/mcp/<YOUR_MCP_SECRET>"
    }
  }
}
```

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Status page + connection instructions (fixes "Cannot GET /") |
| `GET /health` | Render health check / uptime monitoring |
| `POST /mcp/:secret` | MCP Streamable HTTP endpoint |
| `GET /dashboard/:secret` | Live activity dashboard |

## Tools

- **Bot:** `bot_status`, `bot_invite_link`, `set_bot_presence`, `set_welcome_message`, `add_auto_reply`, `list_auto_replies`, `remove_auto_reply`
- **Server:** `list_servers`, `list_channels`, `list_roles`, `create_channel`, `delete_channel`, `create_role`, `assign_role`, `setup_server`
- **Messaging:** `send_message`, `schedule_announcement` (one-time `run_at` or recurring `cron` + timezone), `list_scheduled`, `cancel_scheduled`
- **Logs:** `get_logs`, `logs_per_hour`

## Local development

```bash
yarn install
cp .env.example .env   # fill in values
yarn dev
```
