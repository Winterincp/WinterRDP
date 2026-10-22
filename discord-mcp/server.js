import express from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import cron from "node-cron";
import { z } from "zod";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  EmbedBuilder,
  ActivityType,
  PermissionsBitField,
} from "discord.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ───────────────────────── Config ─────────────────────────
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SECRET = process.env.MCP_SECRET;
// Render's filesystem is ephemeral – /tmp is always writable.
// Set DATA_DIR=/var/data if you attach a persistent disk.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync("/var/data") ? "/var/data" : "/tmp/discord-mcp-data");
const PRIVILEGED = (process.env.PRIVILEGED_INTENTS || "true") === "true";
const MAX_LOGS = 5000;

if (!SECRET || SECRET.length < 16) {
  console.error("Set MCP_SECRET to a random string of 16+ characters (it is part of your connector URL).");
  process.exit(1);
}

// ───────────────────────── Persistence ─────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "db.json");
let db = { logs: [], stats: {}, schedules: [], autoReplies: [], welcome: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
} catch {}
let dirty = false;
const save = () => {
  dirty = true;
};
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
  } catch (e) {
    console.error("save failed", e.message);
  }
}, 5000);

// ───────────────────────── Logging & hourly stats ─────────────────────────
const hourKey = (d = new Date()) => d.toISOString().slice(0, 13) + ":00Z";
function bump(metric, n = 1) {
  const k = hourKey();
  db.stats[k] ??= { messages: 0, joins: 0, leaves: 0, commands: 0, toolCalls: 0, announcements: 0, errors: 0 };
  db.stats[k][metric] = (db.stats[k][metric] || 0) + n;
  // keep 14 days
  const keys = Object.keys(db.stats).sort();
  while (keys.length > 24 * 14) delete db.stats[keys.shift()];
  save();
}
function log(level, type, message, meta = {}) {
  const entry = { t: new Date().toISOString(), level, type, message, ...meta };
  db.logs.push(entry);
  if (db.logs.length > MAX_LOGS) db.logs.splice(0, db.logs.length - MAX_LOGS);
  if (level === "error") bump("errors");
  console.log(`[${level}] ${type}: ${message}`);
  save();
}

// ───────────────────────── Discord client ─────────────────────────
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (PRIVILEGED) intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent);
const client = new Client({ intents });

client.on("ready", () => {
  log("info", "bot", `Logged in as ${client.user.tag}`);
  armSchedules();
});
client.on("error", (e) => log("error", "discord", e.message));
client.on("messageCreate", async (m) => {
  if (m.author.bot) return;
  bump("messages");
  log("info", "message", `#${m.channel?.name ?? m.channelId}: ${m.author.tag}`, { guild: m.guildId });
  if (!PRIVILEGED) return;
  const text = m.content.toLowerCase();
  for (const r of db.autoReplies) {
    if (r.guildId && r.guildId !== m.guildId) continue;
    if (text.includes(r.trigger.toLowerCase())) {
      try {
        await m.reply(r.response);
        bump("commands");
      } catch (e) {
        log("error", "autoreply", e.message);
      }
      break;
    }
  }
});
client.on("guildMemberAdd", async (mem) => {
  bump("joins");
  log("info", "join", `${mem.user.tag} joined ${mem.guild.name}`, { guild: mem.guild.id });
  const w = db.welcome[mem.guild.id];
  if (w) {
    try {
      const ch = await client.channels.fetch(w.channelId);
      await ch.send(w.message.replaceAll("{user}", `<@${mem.id}>`).replaceAll("{server}", mem.guild.name));
    } catch (e) {
      log("error", "welcome", e.message);
    }
  }
});
client.on("guildMemberRemove", (mem) => {
  bump("leaves");
  log("info", "leave", `${mem.user?.tag ?? mem.id} left ${mem.guild.name}`, { guild: mem.guild.id });
});

if (TOKEN) {
  client.login(TOKEN).catch((e) => log("error", "login", e.message));
} else {
  console.warn("DISCORD_BOT_TOKEN not set – Discord tools will return an error until it is.");
}

const needBot = () => {
  if (!client.isReady()) throw new Error("Discord bot is not connected. Set DISCORD_BOT_TOKEN and check the server logs.");
};

// ───────────────────────── Scheduler ─────────────────────────
const cronJobs = new Map();

async function postAnnouncement(s) {
  try {
    needBot();
    const ch = await client.channels.fetch(s.channelId);
    if (s.embedTitle) {
      const e = new EmbedBuilder().setTitle(s.embedTitle).setDescription(s.content).setColor(s.color || 0x5865f2).setTimestamp();
      await ch.send({ embeds: [e] });
    } else {
      await ch.send(s.content);
    }
    bump("announcements");
    log("info", "announcement", `Sent scheduled ${s.id} to ${s.channelId}`);
  } catch (e) {
    log("error", "announcement", `Failed ${s.id}: ${e.message}`);
  }
}
function armCron(s) {
  if (!s.cron || cronJobs.has(s.id)) return;
  if (!cron.validate(s.cron)) return;
  cronJobs.set(
    s.id,
    cron.schedule(s.cron, () => postAnnouncement(s), { timezone: s.timezone || "UTC" })
  );
}
function armSchedules() {
  db.schedules.forEach(armCron);
}
// one-time announcements: check every 15s
setInterval(() => {
  if (!client.isReady()) return;
  const now = Date.now();
  for (const s of db.schedules) {
    if (s.runAt && !s.done && new Date(s.runAt).getTime() <= now) {
      s.done = true;
      postAnnouncement(s);
      save();
    }
  }
  db.schedules = db.schedules.filter((s) => !s.done);
}, 15000);

// ───────────────────────── MCP server ─────────────────────────
const ok = (d) => ({ content: [{ type: "text", text: typeof d === "string" ? d : JSON.stringify(d, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message ?? e}` }] });

function tool(server, name, description, shape, fn) {
  server.tool(name, description, shape, async (args) => {
    bump("toolCalls");
    try {
      const r = await fn(args);
      log("info", "tool", name);
      return ok(r);
    } catch (e) {
      log("error", "tool", `${name}: ${e.message}`);
      return fail(e);
    }
  });
}

const CH_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  category: ChannelType.GuildCategory,
};
const guildOf = async (id) => {
  needBot();
  return client.guilds.fetch(id);
};

function buildServer() {
  const s = new McpServer({ name: "discord-mcp", version: "1.0.0" });

  // ── Bot ──
  tool(s, "bot_status", "Show whether the Discord bot is online, its name, servers and uptime.", {}, async () => {
    if (!client.isReady()) return { online: false, hint: "Set DISCORD_BOT_TOKEN in environment variables." };
    return {
      online: true,
      bot: client.user.tag,
      id: client.user.id,
      servers: client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount })),
      uptimeMinutes: Math.round(client.uptime / 60000),
      pingMs: client.ws.ping,
      privilegedIntents: PRIVILEGED,
    };
  });
  tool(
    s,
    "bot_invite_link",
    "Get the OAuth2 link to add the bot to a Discord server.",
    { administrator: z.boolean().default(true).describe("Request Administrator permission") },
    async ({ administrator }) => {
      needBot();
      const perms = administrator ? PermissionsBitField.Flags.Administrator : 0n;
      return `https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot%20applications.commands&permissions=${perms}`;
    }
  );
  tool(
    s,
    "set_bot_presence",
    "Change the bot status and activity text.",
    {
      status: z.enum(["online", "idle", "dnd", "invisible"]).default("online"),
      activity: z.string().optional(),
      type: z.enum(["Playing", "Watching", "Listening", "Competing"]).default("Playing"),
    },
    async ({ status, activity, type }) => {
      needBot();
      client.user.setPresence({
        status,
        activities: activity ? [{ name: activity, type: ActivityType[type] }] : [],
      });
      return "Presence updated.";
    }
  );
  tool(
    s,
    "set_welcome_message",
    "Greet new members in a channel. Use {user} and {server} placeholders. Needs privileged intents.",
    { guild_id: z.string(), channel_id: z.string(), message: z.string() },
    async ({ guild_id, channel_id, message }) => {
      db.welcome[guild_id] = { channelId: channel_id, message };
      save();
      return "Welcome message saved.";
    }
  );
  tool(
    s,
    "add_auto_reply",
    "Make the bot reply automatically when a message contains a trigger word. Needs privileged intents.",
    { trigger: z.string(), response: z.string(), guild_id: z.string().optional() },
    async ({ trigger, response, guild_id }) => {
      const r = { id: crypto.randomUUID().slice(0, 8), trigger, response, guildId: guild_id };
      db.autoReplies.push(r);
      save();
      return r;
    }
  );
  tool(s, "list_auto_replies", "List auto-replies.", {}, async () => db.autoReplies);
  tool(s, "remove_auto_reply", "Remove an auto-reply by id.", { id: z.string() }, async ({ id }) => {
    db.autoReplies = db.autoReplies.filter((r) => r.id !== id);
    save();
    return "Removed.";
  });

  // ── Server management ──
  tool(s, "list_servers", "List Discord servers the bot is in.", {}, async () => {
    needBot();
    return client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount }));
  });
  tool(s, "list_channels", "List channels and categories in a server.", { guild_id: z.string() }, async ({ guild_id }) => {
    const g = await guildOf(guild_id);
    const chans = await g.channels.fetch();
    return chans.map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], parent: c.parent?.name ?? null }));
  });
  tool(s, "list_roles", "List roles in a server.", { guild_id: z.string() }, async ({ guild_id }) => {
    const g = await guildOf(guild_id);
    const roles = await g.roles.fetch();
    return roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor, members: r.members.size }));
  });
  tool(
    s,
    "create_channel",
    "Create a text, voice, announcement, forum channel or category.",
    {
      guild_id: z.string(),
      name: z.string(),
      type: z.enum(["text", "voice", "announcement", "forum", "category"]).default("text"),
      category_id: z.string().optional(),
      topic: z.string().optional(),
    },
    async ({ guild_id, name, type, category_id, topic }) => {
      const g = await guildOf(guild_id);
      const c = await g.channels.create({ name, type: CH_TYPES[type], parent: category_id, topic });
      return { id: c.id, name: c.name };
    }
  );
  tool(s, "delete_channel", "Delete a channel by id. Irreversible.", { channel_id: z.string() }, async ({ channel_id }) => {
    needBot();
    const c = await client.channels.fetch(channel_id);
    await c.delete();
    return "Deleted.";
  });
  tool(
    s,
    "create_role",
    "Create a role.",
    {
      guild_id: z.string(),
      name: z.string(),
      color: z.string().default("#5865F2").describe("Hex color"),
      hoist: z.boolean().default(false),
      mentionable: z.boolean().default(false),
    },
    async ({ guild_id, name, color, hoist, mentionable }) => {
      const g = await guildOf(guild_id);
      const r = await g.roles.create({ name, color, hoist, mentionable });
      return { id: r.id, name: r.name };
    }
  );
  tool(
    s,
    "assign_role",
    "Give a role to a member.",
    { guild_id: z.string(), user_id: z.string(), role_id: z.string() },
    async ({ guild_id, user_id, role_id }) => {
      const g = await guildOf(guild_id);
      const m = await g.members.fetch(user_id);
      await m.roles.add(role_id);
      return "Role assigned.";
    }
  );
  tool(
    s,
    "setup_server",
    "Build a whole server layout in one call: roles plus categories with channels. Example categories: [{name:'INFO', channels:[{name:'rules'},{name:'announcements',type:'announcement'}]}]",
    {
      guild_id: z.string(),
      roles: z.array(z.object({ name: z.string(), color: z.string().optional(), hoist: z.boolean().optional() })).default([]),
      categories: z
        .array(
          z.object({
            name: z.string(),
            channels: z.array(z.object({ name: z.string(), type: z.enum(["text", "voice", "announcement", "forum"]).default("text"), topic: z.string().optional() })),
          })
        )
        .default([]),
    },
    async ({ guild_id, roles, categories }) => {
      const g = await guildOf(guild_id);
      const out = { roles: [], channels: [] };
      for (const r of roles) {
        const created = await g.roles.create({ name: r.name, color: r.color, hoist: r.hoist });
        out.roles.push({ id: created.id, name: created.name });
      }
      for (const cat of categories) {
        const parent = await g.channels.create({ name: cat.name, type: ChannelType.GuildCategory });
        for (const ch of cat.channels) {
          const c = await g.channels.create({ name: ch.name, type: CH_TYPES[ch.type || "text"], parent: parent.id, topic: ch.topic });
          out.channels.push({ id: c.id, name: `${cat.name}/${c.name}` });
        }
      }
      return out;
    }
  );

  // ── Messaging & announcements ──
  tool(
    s,
    "send_message",
    "Send a message (or embed if embed_title is set) to a channel right now.",
    { channel_id: z.string(), content: z.string(), embed_title: z.string().optional() },
    async ({ channel_id, content, embed_title }) => {
      needBot();
      const ch = await client.channels.fetch(channel_id);
      if (embed_title) await ch.send({ embeds: [new EmbedBuilder().setTitle(embed_title).setDescription(content).setColor(0x5865f2)] });
      else await ch.send(content);
      return "Sent.";
    }
  );
  tool(
    s,
    "schedule_announcement",
    "Schedule an announcement. Use run_at (ISO time like 2026-10-25T09:00:00+08:00) for one-time, or cron (like '0 9 * * 1' = every Monday 9AM) for repeating, with timezone (e.g. Asia/Manila).",
    {
      channel_id: z.string(),
      content: z.string(),
      embed_title: z.string().optional(),
      run_at: z.string().optional(),
      cron: z.string().optional(),
      timezone: z.string().default("Asia/Manila"),
    },
    async ({ channel_id, content, embed_title, run_at, cron: expr, timezone }) => {
      if (!run_at && !expr) throw new Error("Provide run_at or cron.");
      if (expr && !cron.validate(expr)) throw new Error("Invalid cron expression.");
      if (run_at && isNaN(new Date(run_at).getTime())) throw new Error("Invalid run_at date.");
      const sch = { id: crypto.randomUUID().slice(0, 8), channelId: channel_id, content, embedTitle: embed_title, runAt: run_at, cron: expr, timezone, createdAt: new Date().toISOString() };
      db.schedules.push(sch);
      armCron(sch);
      save();
      return sch;
    }
  );
  tool(s, "list_scheduled", "List scheduled announcements.", {}, async () => db.schedules);
  tool(s, "cancel_scheduled", "Cancel a scheduled announcement by id.", { id: z.string() }, async ({ id }) => {
    cronJobs.get(id)?.stop();
    cronJobs.delete(id);
    db.schedules = db.schedules.filter((x) => x.id !== id);
    save();
    return "Cancelled.";
  });

  // ── Logs ──
  tool(
    s,
    "get_logs",
    "Recent bot/server logs, newest last. Filter by level or type (message, join, leave, tool, announcement, error...).",
    {
      limit: z.number().int().min(1).max(500).default(50),
      level: z.enum(["info", "error"]).optional(),
      type: z.string().optional(),
      since_minutes: z.number().optional(),
    },
    async ({ limit, level, type, since_minutes }) => {
      const cut = since_minutes ? Date.now() - since_minutes * 60000 : 0;
      return db.logs.filter((l) => (!level || l.level === level) && (!type || l.type === type) && new Date(l.t).getTime() >= cut).slice(-limit);
    }
  );
  tool(
    s,
    "logs_per_hour",
    "Activity per hour (UTC): messages, joins, leaves, announcements, tool calls, errors.",
    { hours: z.number().int().min(1).max(336).default(24) },
    async ({ hours }) => {
      const rows = [];
      for (let i = hours - 1; i >= 0; i--) {
        const k = hourKey(new Date(Date.now() - i * 3600000));
        rows.push({ hour: k, ...(db.stats[k] || { messages: 0, joins: 0, leaves: 0, commands: 0, toolCalls: 0, announcements: 0, errors: 0 }) });
      }
      return rows;
    }
  );

  return s;
}

// ───────────────────────── HTTP ─────────────────────────
const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, bot: client.isReady() }));

const guard = (req, res, next) => {
  const a = Buffer.from(req.params.secret || "");
  const b = Buffer.from(SECRET);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "unauthorized" });
  next();
};

// MCP endpoint (Streamable HTTP, stateless) – works with ChatGPT custom connectors,
// Claude Desktop, and any MCP client that supports remote Streamable HTTP.
app.post("/mcp/:secret", guard, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    log("error", "mcp", e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
const notAllowed = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp/:secret", guard, notAllowed);
app.delete("/mcp/:secret", guard, notAllowed);

// Live dashboard
app.get("/dashboard/:secret/data", guard, (req, res) => {
  const rows = [];
  for (let i = 23; i >= 0; i--) {
    const k = hourKey(new Date(Date.now() - i * 3600000));
    rows.push({ hour: k, ...(db.stats[k] || {}) });
  }
  res.json({ online: client.isReady(), bot: client.user?.tag, hours: rows, logs: db.logs.slice(-100) });
});
app.get("/dashboard/:secret", guard, (req, res) => {
  res.type("html").send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Discord MCP Live</title>
<style>body{font:14px system-ui;background:#111;color:#eee;margin:0;padding:16px}h1{font-size:18px}.bar{display:flex;align-items:flex-end;gap:3px;height:90px;margin:8px 0 16px}
.bar div{flex:1;background:#5865f2;min-height:2px;border-radius:2px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:3px 6px;text-align:right;border-bottom:1px solid #333}
td:first-child,th:first-child{text-align:left}#logs{font:12px ui-monospace,monospace;max-height:50vh;overflow:auto;background:#000;padding:8px;border-radius:6px}.error{color:#ff6b6b}</style>
<h1>Discord MCP – <span id=st>…</span></h1><div class=bar id=bar></div><table id=tbl></table><h1>Live logs</h1><div id=logs></div>
<script>
async function tick(){const r=await fetch('data');const d=await r.json();
st.textContent=d.online?'online as '+d.bot:'offline';
const max=Math.max(1,...d.hours.map(h=>(h.messages||0)+(h.toolCalls||0)+(h.joins||0)));
bar.innerHTML=d.hours.map(h=>'<div title="'+h.hour+'" style="height:'+(((h.messages||0)+(h.toolCalls||0)+(h.joins||0))/max*100)+'%"></div>').join('');
tbl.innerHTML='<tr><th>Hour (UTC)<th>Msgs<th>Joins<th>Leaves<th>Tools<th>Ann.<th>Err</tr>'+d.hours.slice().reverse().slice(0,12).map(h=>'<tr><td>'+h.hour.slice(5,13)+'h<td>'+(h.messages||0)+'<td>'+(h.joins||0)+'<td>'+(h.leaves||0)+'<td>'+(h.toolCalls||0)+'<td>'+(h.announcements||0)+'<td>'+(h.errors||0)+'</tr>').join('');
logs.innerHTML=d.logs.slice().reverse().map(l=>'<div class="'+l.level+'">'+l.t.slice(11,19)+' ['+l.type+'] '+l.message.replace(/</g,'&lt;')+'</div>').join('');}
tick();setInterval(tick,3000);
</script>`);
});

// ── Root route: fixes "Cannot GET /" and shows connection info ──
app.get("/", (_req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.type("html").send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Discord MCP Connector</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:15px/1.6 system-ui,-apple-system,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;max-width:640px;width:100%;padding:32px}
  h1{font-size:22px;margin-bottom:4px;display:flex;align-items:center;gap:10px}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
  .on{background:#3fb950}.off{background:#f85149}
  p.sub{color:#8b949e;margin-bottom:20px;font-size:13px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#8b949e;margin:20px 0 8px}
  code{background:#0d1117;border:1px solid #30363d;padding:2px 7px;border-radius:6px;font-size:12.5px;color:#79c0ff;word-break:break-all}
  .url{display:block;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 12px;margin:6px 0;font-family:ui-monospace,monospace;font-size:12px;color:#79c0ff;word-break:break-all}
  ol{margin-left:20px;font-size:13.5px;color:#c9d1d9}
  ol li{margin-bottom:6px}
  .badge{display:inline-block;background:#1f6feb22;border:1px solid #1f6feb;color:#79c0ff;font-size:11px;padding:2px 8px;border-radius:20px;margin-right:6px}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
</style>
<div class="card">
  <h1><span class="dot ${client.isReady() ? "on" : "off"}"></span> Discord MCP Connector</h1>
  <p class="sub">Remote MCP server for Discord server management · v1.0.0</p>

  <div class="row">
    <span class="badge">Streamable HTTP</span>
    <span class="badge">ChatGPT Custom Connector</span>
    <span class="badge">Claude Desktop</span>
    <span class="badge">MCP Protocol</span>
  </div>

  <h2>Connection URL (keep your secret private)</h2>
  <span class="url">${base}/mcp/&lt;YOUR_MCP_SECRET&gt;</span>

  <h2>How to connect</h2>
  <ol>
    <li><b>ChatGPT</b> → Settings → Connectors → Add → paste the URL above (it includes your secret).</li>
    <li><b>Claude Desktop</b> → add to <code>claude_desktop_config.json</code>:
      <span class="url">"url": "${base}/mcp/&lt;YOUR_MCP_SECRET&gt;"</span>
    </li>
    <li><b>Cursor / other MCP clients</b> → use the same URL as a remote Streamable HTTP server.</li>
  </ol>

  <h2>Other endpoints</h2>
  <ol>
    <li>Health check: <code>${base}/health</code></li>
    <li>Live dashboard: <code>${base}/dashboard/&lt;YOUR_MCP_SECRET&gt;</code></li>
  </ol>

  <h2>Status</h2>
  <p style="font-size:13.5px;color:#c9d1d9">
    Bot: <b style="color:${client.isReady() ? "#3fb950" : "#f85149"}">${client.isReady() ? client.user.tag + " (online)" : "offline – set DISCORD_BOT_TOKEN"}</b><br>
    Data dir: <code>${DATA_DIR}</code>
  </p>
</div>`);
});

// 404 handler for any other unknown route (fixes generic "Cannot GET /xyz")
app.use((_req, res) => {
  res.status(404).json({ error: "Not found", hint: "GET / for connection info, POST /mcp/:secret for MCP." });
});

app.listen(PORT, () => console.log(`Discord MCP listening on :${PORT}`));
