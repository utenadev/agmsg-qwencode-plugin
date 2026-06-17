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
import type { PluginConfig, Settings } from "./common.js";

const DEFAULT_STORAGE_PATH = path.join(os.homedir(), ".agents", "skills", "agmsg");

export function createServer(storagePath?: string, teamName?: string, agentName?: string): McpServer {
  const sp = storagePath ?? process.env.AGMSG_STORAGE_PATH ?? DEFAULT_STORAGE_PATH;
  const settings = resolveSettings(sp);
  const dbPath = path.join(sp, "db", "messages.db");
  const team = teamName ?? settings.teamName;
  const agent = agentName ?? settings.agentName;

  const server = new McpServer({
    name: "agmsg",
    version: "2.0.0",
  });

  const getCfg = (): PluginConfig => ({ dbPath, teamName: team, agentName: agent });

  server.registerTool(
    "agmsg_send",
    {
      description: "Send a message to another agent on the same agmsg team.",
      inputSchema: {
        to_agent: z.string().describe("Target agent name"),
        body: z.string().describe("Message content"),
      },
    },
    async ({ to_agent, body }) => {
      const db = openDb(dbPath);
      const result = sendMessage(db, getCfg(), to_agent, body);
      db.close();
      return { content: [{ type: "text" as const, text: `Message sent to ${result.to} (id=${result.id})` }] };
    }
  );

  server.registerTool(
    "agmsg_inbox",
    {
      description: "List unread messages addressed to you. Does not mark them as read.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      const db = openDb(dbPath);
      const msgs = listMyUnread(db, getCfg());
      db.close();
      if (msgs.length === 0) {
        return { content: [{ type: "text" as const, text: "No unread messages." }] };
      }
      const lines = msgs.map(m => `[#${m.id}] ${m.created_at} from ${m.from_agent}: ${m.body}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.registerTool(
    "agmsg_consume",
    {
      description: "Consume the oldest unread message (marks as read). Returns the message content.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      const db = openDb(dbPath);
      const msg = consumeMyNextMessage(db, getCfg());
      db.close();
      if (!msg) {
        return { content: [{ type: "text" as const, text: "No unread messages." }] };
      }
      return { content: [{ type: "text" as const, text: NOTIFICATION(msg.from_agent, msg.body) }] };
    }
  );

  server.registerTool(
    "agmsg_count",
    {
      description: "Count unread messages addressed to you.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      const db = openDb(dbPath);
      const n = countMyUnread(db, getCfg());
      db.close();
      return { content: [{ type: "text" as const, text: String(n) }] };
    }
  );

  server.registerTool(
    "agmsg_teams",
    {
      description: "List all teams that have messages in the database.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      const db = openDb(dbPath);
      const teams = listTeams(db);
      db.close();
      if (teams.length === 0) {
        return { content: [{ type: "text" as const, text: "No teams found." }] };
      }
      return { content: [{ type: "text" as const, text: teams.join("\n") }] };
    }
  );

  server.registerTool(
    "agmsg_members",
    {
      description: "List all agents in the current team.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      const db = openDb(dbPath);
      const members = listMembers(db, getCfg().teamName);
      db.close();
      if (members.length === 0) {
        return { content: [{ type: "text" as const, text: "No members found." }] };
      }
      return { content: [{ type: "text" as const, text: members.join("\n") }] };
    }
  );

  server.registerTool(
    "agmsg_setup",
    {
      description: "Setup wizard for agmsg. Check configuration status or initialize a new configuration.",
      inputSchema: {
        team_name: z.string().optional().describe("Team name to configure (only when setting up)"),
        agent_name: z.string().optional().describe("Agent name to configure (only when setting up)"),
      },
    },
    async ({ team_name, agent_name }) => {
      if (isConfigured(sp)) {
        const s = resolveSettings(sp);
        return { content: [{ type: "text" as const, text: `Already configured. team=${s.teamName} agent=${s.agentName}` }] };
      }
      if (!team_name || !agent_name) {
        return { content: [{ type: "text" as const, text: "Not configured. Please provide team_name and agent_name to set up." }] };
      }
      saveConfig(sp, { teamName: team_name, agentName: agent_name });
      ensureDb(dbPath);
      return { content: [{ type: "text" as const, text: `Configuration saved. team=${team_name} agent=${agent_name}` }] };
    }
  );

  return server;
}

async function main(): Promise<void> {
  const sp = process.env.AGMSG_STORAGE_PATH ?? DEFAULT_STORAGE_PATH;
  const settings = resolveSettings(sp);
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

  console.log(`[agmsg monitor] team=${cfg.teamName} agent=${cfg.agentName} interval=${interval}ms`);

  let pending = false;
  // Signal file for Stop Hook integration
  const signalPath = path.join(sp, ".pending");

  while (true) {
    const db = openDb(dbPath);
    const n = countMyUnread(db, cfg);
    db.close();

    if (n > 0 && !pending) {
      pending = true;
      // Write signal file so external hooks can detect pending messages
      try { Bun.write(signalPath, String(n)); } catch {}
      const db2 = openDb(dbPath);
      const msgs = listMyUnread(db2, cfg);
      db2.close();
      for (const msg of msgs) {
        console.log(NOTIFICATION(msg.from_agent, msg.body));
      }
    } else if (n === 0 && pending) {
      pending = false;
      try { Bun.write(signalPath, "0"); } catch {}
    }

    await new Promise(r => setTimeout(r, interval));
  }
}

// Only run when executed directly (not imported)
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
