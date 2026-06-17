import os from "os";
import path from "path";
import fs from "fs";

import {
  openDb,
  listMyUnread,
  consumeMyNextMessage,
  sendMessage as sendMessageDb,
  NOTIFICATION,
} from "./common.js";
import type { AgmsgMessage, SendResult } from "./common.js";

const DEFAULT_STORAGE_PATH = path.join(os.homedir(), ".agents", "skills", "agmsg");

interface Config {
  dbPath: string;
  team: string;
  agent: string;
}

function loadConfig(): Config {
  const storagePath = process.env.AGMSG_STORAGE_PATH;
  const fromStorage = storagePath ? path.join(storagePath, "db", "messages.db") : undefined;
  return {
    dbPath: fromStorage ?? process.env.AGMSG_DB_PATH ?? path.join(DEFAULT_STORAGE_PATH, "db", "messages.db"),
    team: process.env.AGMSG_TEAM ?? "default_team",
    agent: process.env.AGMSG_AGENT ?? "qwen",
  };
}

export function listUnread(dbPath: string, team: string, agent: string): AgmsgMessage[] {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`agmsg database not found at ${dbPath}. Run agmsg join first.`);
  }
  const db = openDb(dbPath);
  try {
    return listMyUnread(db, { dbPath, teamName: team, agentName: agent });
  } finally {
    db.close();
  }
}

export function consumeNext(dbPath: string, team: string, agent: string): AgmsgMessage | null {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`agmsg database not found at ${dbPath}. Run agmsg join first.`);
  }
  const db = openDb(dbPath);
  try {
    return consumeMyNextMessage(db, { dbPath, teamName: team, agentName: agent });
  } finally {
    db.close();
  }
}

export function sendMessage(
  dbPath: string,
  team: string,
  toAgent: string,
  body: string,
): SendResult {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`agmsg database not found at ${dbPath}. Run agmsg join first.`);
  }
  const db = openDb(dbPath);
  try {
    return sendMessageDb(db, { dbPath, teamName: team, agentName: loadConfig().agent }, toAgent, body);
  } finally {
    db.close();
  }
}

export function runQwenHook(dbPath: string, team: string, agent: string): string {
  const notifications: string[] = [];
  while (true) {
    const msg = consumeNext(dbPath, team, agent);
    if (!msg) break;
    notifications.push(NOTIFICATION(msg.from_agent, msg.body));
  }
  if (notifications.length === 0) {
    return JSON.stringify({ ok: true });
  }
  return JSON.stringify({
    ok: true,
    hookSpecificOutput: {
      additionalContext: notifications.join("\n\n---\n\n"),
    },
  });
}

function printUsage(): void {
  console.error(`agmsg-qwencode-plugin CLI

Usage:
  agmsg-qwencode inbox [--json]          List unread messages (does not mark read)
  agmsg-qwencode consume [--json]        Claim and display next unread message
  agmsg-qwencode send <to> <message>     Send a message to another agent
  agmsg-qwencode qwen-hook               Qwen Code Stop hook (outputs JSON with additionalContext)

Environment:
  AGMSG_STORAGE_PATH   Base dir for agmsg data (appends /db/messages.db)
  AGMSG_DB_PATH        Direct path to messages.db (fallback if AGMSG_STORAGE_PATH unset)
  AGMSG_TEAM      Team name (default: default_team)
  AGMSG_AGENT     Agent name (default: qwen)
`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const cmd = args[0];
  const cfg = loadConfig();

  switch (cmd) {
    case "inbox": {
      const json = args.includes("--json");
      const msgs = listUnread(cfg.dbPath, cfg.team, cfg.agent);
      if (json) {
        console.log(JSON.stringify(msgs, null, 2));
      } else if (msgs.length === 0) {
        console.log("No new messages.");
      } else {
        console.log(`${msgs.length} unread message(s):`);
        for (const m of msgs) {
          console.log(`  [${m.created_at}] ${m.from_agent} → ${m.to_agent}: ${m.body}`);
        }
      }
      break;
    }

    case "consume": {
      const json = args.includes("--json");
      const msg = consumeNext(cfg.dbPath, cfg.team, cfg.agent);
      if (json) {
        console.log(JSON.stringify(msg, null, 2));
      } else if (!msg) {
        console.log("No new messages.");
      } else {
        console.log(`[${msg.created_at}] ${msg.from_agent} → ${msg.to_agent}: ${msg.body}`);
      }
      break;
    }

    case "send": {
      const toAgent = args[1];
      const body = args.slice(2).join(" ");
      if (!toAgent || !body) {
        console.error("Usage: agmsg-qwencode send <to_agent> <message>");
        process.exit(1);
      }
      const result = sendMessage(cfg.dbPath, cfg.team, toAgent, body);
      console.log(`Sent to ${result.to} in team ${result.team} (id=${result.id})`);
      break;
    }

    case "qwen-hook": {
      console.log(runQwenHook(cfg.dbPath, cfg.team, cfg.agent));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

if (import.meta.path === Bun.main) {
  main();
}