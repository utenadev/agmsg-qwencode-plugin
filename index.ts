import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "os";
import path from "path";

import {
  openDb,
  listMyUnread,
  consumeMyNextMessage,
  sendMessage,
  listTeams,
  listMembers,
  countMyUnread,
  NOTIFICATION,
  resolveSettings,
  isConfigured,
  saveConfig,
  ensureDb,
} from "./common.js";
import type { PluginConfig } from "./common.js";

const log = (...args: unknown[]) => console.error("[agmsg]", ...args);
const logErr = (tag: string, err: unknown) => console.error(`[agmsg] ${tag} error:`, err);

const DEFAULT_STORAGE_PATH = path.join(os.homedir(), ".agents", "skills", "agmsg");

export function createServer(storagePath?: string, teamName?: string, agentName?: string): McpServer {
  const sp = storagePath ?? process.env.AGMSG_STORAGE_PATH ?? DEFAULT_STORAGE_PATH;
  const settings = resolveSettings(sp);
  const dbPath = path.join(sp, "db", "messages.db");
  const team = teamName ?? settings.teamName;
  const agent = agentName ?? settings.agentName;

  // C1: ensure DB and tables exist before any tool runs
  ensureDb(dbPath);

  const server = new McpServer({ name: "agmsg", version: "2.0.0" });

  // C2: open DB once, reuse across tool calls
  const db = openDb(dbPath);
  const getCfg = (): PluginConfig => ({ dbPath, teamName: team, agentName: agent });

  // C2: expose db for lifecycle management (close on shutdown)
  (server as any)._db = db;

  server.registerTool("agmsg_send", {
    description: "Send a message to another agent on the same agmsg team.",
    inputSchema: {
      to_agent: z.string().describe("Target agent name"),
      body: z.string().describe("Message content"),
    },
  }, async ({ to_agent, body }) => {
    try {
      const cfg = getCfg();
      const result = sendMessage(db, cfg, to_agent, body);
      log(`Sent -> ${result.to} (id=${result.id})`);
      return { content: [{ type: "text" as const, text: `Message sent to ${result.to} (id=${result.id})` }] };
    } catch (err) {
      logErr("send", err);
      return { content: [{ type: "text" as const, text: `Error: failed to send message.` }], isError: true };
    }
  });

  server.registerTool("agmsg_inbox", {
    description: "List unread messages addressed to you. Does not mark them as read.",
    inputSchema: z.object({}).shape,
  }, async () => {
    try {
      const msgs = listMyUnread(db, getCfg());
      if (msgs.length === 0) return { content: [{ type: "text" as const, text: "No unread messages." }] };
      log(`Inbox: ${msgs.length} unread`);
      const lines = msgs.map(m => `[#${m.id}] ${m.created_at} from ${m.from_agent}: ${m.body}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      logErr("inbox", err);
      return { content: [{ type: "text" as const, text: "Error: failed to list inbox." }], isError: true };
    }
  });

  server.registerTool("agmsg_consume", {
    description: "Consume the oldest unread message (marks as read). Returns the message content.",
    inputSchema: z.object({}).shape,
  }, async () => {
    try {
      const msg = consumeMyNextMessage(db, getCfg());
      if (!msg) return { content: [{ type: "text" as const, text: "No unread messages." }] };
      log(`Consumed #${msg.id} from ${msg.from_agent}`);
      return { content: [{ type: "text" as const, text: NOTIFICATION(msg.from_agent, msg.body) }] };
    } catch (err) {
      logErr("consume", err);
      return { content: [{ type: "text" as const, text: "Error: failed to consume message." }], isError: true };
    }
  });

  server.registerTool("agmsg_count", {
    description: "Count unread messages addressed to you.",
    inputSchema: z.object({}).shape,
  }, async () => {
    try {
      const n = countMyUnread(db, getCfg());
      return { content: [{ type: "text" as const, text: String(n) }] };
    } catch (err) {
      logErr("count", err);
      return { content: [{ type: "text" as const, text: "Error: failed to count messages." }], isError: true };
    }
  });

  server.registerTool("agmsg_teams", {
    description: "List all teams that have messages in the database.",
    inputSchema: z.object({}).shape,
  }, async () => {
    try {
      const teams = listTeams(db);
      if (teams.length === 0) return { content: [{ type: "text" as const, text: "No teams found." }] };
      return { content: [{ type: "text" as const, text: teams.join("\n") }] };
    } catch (err) {
      logErr("teams", err);
      return { content: [{ type: "text" as const, text: "Error: failed to list teams." }], isError: true };
    }
  });

  server.registerTool("agmsg_members", {
    description: "List all agents in the current team.",
    inputSchema: z.object({}).shape,
  }, async () => {
    try {
      const members = listMembers(db, getCfg().teamName);
      if (members.length === 0) return { content: [{ type: "text" as const, text: "No members found." }] };
      return { content: [{ type: "text" as const, text: members.join("\n") }] };
    } catch (err) {
      logErr("members", err);
      return { content: [{ type: "text" as const, text: "Error: failed to list members." }], isError: true };
    }
  });

  server.registerTool("agmsg_setup", {
    description: "Setup wizard for agmsg. Check configuration status or initialize a new configuration.",
    inputSchema: {
      team_name: z.string().optional().describe("Team name to configure (only when setting up)"),
      agent_name: z.string().optional().describe("Agent name to configure (only when setting up)"),
    },
  }, async ({ team_name, agent_name }) => {
    try {
      if (isConfigured(sp)) {
        const s = resolveSettings(sp);
        return { content: [{ type: "text" as const, text: `Already configured. team=${s.teamName} agent=${s.agentName}` }] };
      }
      if (!team_name || !agent_name) {
        return { content: [{ type: "text" as const, text: "Not configured. Please provide team_name and agent_name to set up." }] };
      }
      saveConfig(sp, { teamName: team_name, agentName: agent_name });
      ensureDb(dbPath);
      log(`Setup -> team=${team_name} agent=${agent_name}`);
      return { content: [{ type: "text" as const, text: `Configuration saved. team=${team_name} agent=${agent_name}` }] };
    } catch (err) {
      logErr("setup", err);
      return { content: [{ type: "text" as const, text: "Error: failed to save configuration." }], isError: true };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const sp = process.env.AGMSG_STORAGE_PATH ?? DEFAULT_STORAGE_PATH;
  const settings = resolveSettings(sp);
  log(`Starting (team=${settings.teamName} agent=${settings.agentName})`);
  const server = createServer(sp, settings.teamName, settings.agentName);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function monitor(): Promise<void> {
  const sp = process.env.AGMSG_STORAGE_PATH ?? DEFAULT_STORAGE_PATH;
  const settings = resolveSettings(sp);
  const dbPath = path.join(sp, "db", "messages.db");
  const cfg: PluginConfig = { dbPath, teamName: settings.teamName, agentName: settings.agentName };
  const interval = settings.watchInterval;

  log(`monitor start (team=${cfg.teamName} agent=${cfg.agentName} interval=${interval}ms)`);

  ensureDb(dbPath);

  const signalPath = path.join(sp, ".pending");
  let pending = false;

  // C2: open DB once for monitor loop
  const db = openDb(dbPath);

  while (true) {
    try {
      const n = countMyUnread(db, cfg);

      if (n > 0 && !pending) {
        pending = true;
        try { Bun.write(signalPath, String(n)); } catch { /* ignore */ }
        const msgs = listMyUnread(db, cfg);
        for (const msg of msgs) {
          console.log(NOTIFICATION(msg.from_agent, msg.body));
        }
        log(`Notify: ${n} unread`);
      } else if (n === 0 && pending) {
        pending = false;
        try { Bun.write(signalPath, "0"); } catch { /* ignore */ }
      }
    } catch (err) {
      logErr("monitor", err);
    }

    // C4: unref timer so the event loop can drain and process can exit
    await new Promise<void>(r => {
      const t = setTimeout(() => r(), interval);
      t.unref();
    });
  }
}

import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const cmd = process.argv[2];
  if (cmd === "monitor") {
    monitor();
  } else {
    main();
  }
}
