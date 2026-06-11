/**
 * agmsg-qwencode-plugin
 *
 * Native SQLite3 agmsg integration for Qwen Code.
 *
 * Qwen Code v0.5.1 does not expose a plugin/hook API for system-prompt
 * injection (unlike OpenCode's experimental.chat.system.transform).
 * This plugin therefore operates as a CLI helper that Qwen Code invokes
 * via shell commands, reading/writing the agmsg SQLite database directly
 * through bun:sqlite.
 *
 * Two operations:
 *   inbox  — SELECT unread messages, UPDATE read_at (atomic consume)
 *   send   — INSERT a new message
 *
 * Receiving messages between turns is handled by agmsg core's check-inbox.sh
 * wired into .qwen/settings.json Stop hook (codex type, since qwen is not
 * yet in the allowlist). This plugin covers the send side and provides
 * a programmatic inbox read for scripts that need it.
 */

import os from "os";
import path from "path";
import fs from "fs";

import {
  openDb,
  listMyUnread,
  consumeMyNextMessage,
  sendMessage as sendMessageDb,
  NOTIFICATION,
} from "agmsg-common-plugin";
import type { AgmsgMessage, SendResult } from "agmsg-common-plugin";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".agents", "skills", "agmsg", "db", "messages.db",
);

interface Config {
  dbPath: string;
  team: string;
  agent: string;
}

function loadConfig(): Config {
  return {
    dbPath: process.env.AGMSG_DB_PATH ?? DEFAULT_DB_PATH,
    team: process.env.AGMSG_TEAM ?? "default_team",
    agent: process.env.AGMSG_AGENT ?? "qwen",
  };
}

// ---------------------------------------------------------------------------
// Inbox — read and consume unread messages (wrapper over common-plugin)
// ---------------------------------------------------------------------------

/**
 * Fetch all unread messages for the configured team+agent, oldest first.
 * Does NOT mark them as read — use consumeNext() for atomic claim.
 */
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

/**
 * Atomically claim and return the oldest unread message.
 * Uses UPDATE ... RETURNING for race-condition-free consumption.
 * Returns null when no unread messages exist.
 */
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

// ---------------------------------------------------------------------------
// Send — insert a new message (wrapper over common-plugin)
// ---------------------------------------------------------------------------

/**
 * Send a message to another agent in the same team.
 * from_agent is forced to the configured agent name (AGMSG_AGENT) — cannot be spoofed.
 */
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

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.error(`agmsg-qwencode-plugin CLI

Usage:
  agmsg-qwencode inbox [--json]          List unread messages (does not mark read)
  agmsg-qwencode consume [--json]        Claim and display next unread message
  agmsg-qwencode send <to> <message>     Send a message to another agent
  agmsg-qwencode qwen-hook               Qwen Code Stop hook (outputs JSON with additionalContext)

Environment:
  AGMSG_DB_PATH   Path to messages.db (default: ~/.agents/skills/agmsg/db/messages.db)
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
      const notifications: string[] = [];
      while (true) {
        const msg = consumeNext(cfg.dbPath, cfg.team, cfg.agent);
        if (!msg) break;
        notifications.push(NOTIFICATION(msg.from_agent, msg.body));
      }
      if (notifications.length === 0) {
        console.log(JSON.stringify({ ok: true }));
      } else {
        console.log(JSON.stringify({
          ok: true,
          hookSpecificOutput: {
            additionalContext: notifications.join("\n\n---\n\n"),
          },
        }));
      }
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

// Run CLI when executed directly (not imported as module)
if (import.meta.path === Bun.main) {
  main();
}
