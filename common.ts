import { Database } from "bun:sqlite";

export interface AgmsgMessage {
  id: number;
  team: string;
  from_agent: string;
  to_agent: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface PluginConfig {
  dbPath: string;
  teamName: string;
  agentName: string;
}

export interface SendResult {
  ok: boolean;
  id: number;
  to: string;
  team: string;
}

export function openDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  return db;
}

export function listMyUnread(db: Database, cfg: PluginConfig): AgmsgMessage[] {
  return db.query(
    `SELECT id, team, from_agent, to_agent, body, created_at, read_at
     FROM messages
     WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
     ORDER BY created_at ASC`
  ).all(cfg.teamName, cfg.agentName) as AgmsgMessage[];
}

export function consumeMyNextMessage(db: Database, cfg: PluginConfig): AgmsgMessage | null {
  const msg = db.query(
    `UPDATE messages SET read_at = datetime('now')
     WHERE id = (
       SELECT id FROM messages
       WHERE team = ? AND (to_agent = ? OR to_agent = 'ALL') AND read_at IS NULL
       ORDER BY created_at ASC LIMIT 1
     )
     RETURNING id, team, from_agent, to_agent, body, created_at, read_at`
  ).get(cfg.teamName, cfg.agentName) as AgmsgMessage | undefined;
  return msg ?? null;
}

export function sendMessage(db: Database, cfg: PluginConfig, toAgent: string, body: string): SendResult {
  const result = db.query(
    `INSERT INTO messages (team, from_agent, to_agent, body, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     RETURNING id`
  ).get(cfg.teamName, cfg.agentName, toAgent, body) as { id: number };
  return { ok: true, id: result.id, to: toAgent, team: cfg.teamName };
}

export function NOTIFICATION(fromAgent: string, body: string): string {
  return `[agmsg] Message from "${fromAgent}":\n---\n${body}\n---\nReply using the send tool if appropriate.`;
}