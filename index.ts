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

import { Database } from "bun:sqlite";
import os from "os";
import path from "path";
import fs from "fs";

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
// Database helpers
// ---------------------------------------------------------------------------

function openDb(dbPath: string): Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`agmsg database not found at ${dbPath}. Run agmsg join first.`);
  }
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  return db;
}

// ---------------------------------------------------------------------------
// Inbox — read and consume unread messages
// ---------------------------------------------------------------------------

export interface AgmsgMessage {
  id: number;
  team: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

/**
 * Fetch all unread messages for the configured team+agent, oldest first.
 * Does NOT mark them as read — use consumeNext() for atomic claim.
 */
export function listUnread(dbPath: string, team: string, agent: string): AgmsgMessage[] {
  const db = openDb(dbPath);
  try {
    const rows = db.query(
      `SELECT id, team, from_agent, to_agent, body, created_at, read_at
       FROM messages
       WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
       ORDER BY created_at ASC`
    ).all(team, agent) as AgmsgMessage[];
    return rows;
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
  const db = openDb(dbPath);
  try {
    const msg = db.query(
      `UPDATE messages
       SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
       WHERE id = (
         SELECT id FROM messages
         WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING id, team, from_agent, to_agent, body, created_at, read_at`
    ).get(team, agent) as AgmsgMessage | undefined;
    return msg ?? null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Send — insert a new message
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  id: number;
  to: string;
  team: string;
}

/**
 * Send a message to another agent in the same team.
 */
export function sendMessage(
  dbPath: string,
  team: string,
  fromAgent: string,
  toAgent: string,
  body: string,
): SendResult {
  const db = openDb(dbPath);
  try {
    const result = db.query(
      `INSERT INTO messages (team, from_agent, to_agent, body)
       VALUES (?, ?, ?, ?)
       RETURNING id`
    ).get(team, fromAgent, toAgent, body) as { id: number };
    return { ok: true, id: result.id, to: toAgent, team };
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

function formatMessage(msg: AgmsgMessage): string {
  return `[${msg.created_at}] ${msg.from_agent} → ${msg.to_agent}: ${msg.body}`;
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
          console.log(`  ${formatMessage(m)}`);
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
        console.log(formatMessage(msg));
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
      const result = sendMessage(cfg.dbPath, cfg.team, cfg.agent, toAgent, body);
      console.log(`Sent to ${result.to} in team ${result.team} (id=${result.id})`);
      break;
    }

    case "qwen-hook": {
      const msg = consumeNext(cfg.dbPath, cfg.team, cfg.agent);
      if (!msg) {
        console.log(JSON.stringify({ ok: true }));
      } else {
        const contextText =
          `【agmsgシステム通知: 他のエージェントからメッセージが届きました】\n` +
          `[${msg.created_at}] ${msg.from_agent} → ${msg.to_agent}: ${msg.body}`;
        const response = {
          ok: true,
          hookSpecificOutput: {
            additionalContext: contextText,
          },
        };
        console.log(JSON.stringify(response));
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
