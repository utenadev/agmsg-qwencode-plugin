import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";

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
     WHERE team = ? AND to_agent = ? AND read_at IS NULL
     ORDER BY created_at ASC`
  ).all(cfg.teamName, cfg.agentName) as AgmsgMessage[];
}

export function consumeMyNextMessage(db: Database, cfg: PluginConfig): AgmsgMessage | null {
  const msg = db.query(
    `UPDATE messages SET read_at = datetime('now')
     WHERE id = (
       SELECT id FROM messages
       WHERE team = ? AND to_agent = ? AND read_at IS NULL
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

export function listTeams(db: Database): string[] {
  const rows = db.query(
    `SELECT DISTINCT team FROM messages ORDER BY team ASC`
  ).all() as { team: string }[];
  return rows.map(r => r.team);
}

export function listMembers(db: Database, teamName: string): string[] {
  const rows = db.query(
    `SELECT DISTINCT from_agent AS agent FROM messages WHERE team = ?
     UNION
     SELECT DISTINCT to_agent AS agent FROM messages WHERE team = ?
     ORDER BY agent ASC`
  ).all(teamName, teamName) as { agent: string }[];
  return rows.map(r => r.agent);
}

export function countMyUnread(db: Database, cfg: PluginConfig): number {
  const row = db.query(
    `SELECT COUNT(*) as count FROM messages
     WHERE team = ? AND to_agent = ? AND read_at IS NULL`
  ).get(cfg.teamName, cfg.agentName) as { count: number };
  return row.count;
}

export const NOTIFICATION = (fromAgent: string, body: string): string =>
  `[agmsg] Message from "${fromAgent}":\n---\n${body}\n---\nReply using the send tool if appropriate.`;

export const CONFIG_FILE = "config.yaml";

export interface Settings {
  teamName: string;
  agentName: string;
  watchInterval: number;
}

const DEFAULTS: Settings = {
  teamName: "default_team",
  agentName: "qwen",
  watchInterval: 10_000,
};

function parseYamlValue(raw: string): string | number {
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return trimmed.replace(/^["']|["']$/g, "");
}

function loadYaml(text: string): Partial<Settings> {
  const out: Record<string, string | number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const val = trimmed.slice(colon + 1).trim();
    out[key] = parseYamlValue(val);
  }
  const keyMap: Record<string, keyof Settings> = {
    team_name: "teamName",
    agent_name: "agentName",
    watch_interval: "watchInterval",
  };
  const result: Partial<Settings> = {};
  for (const [yamlKey, prop] of Object.entries(keyMap)) {
    if (out[yamlKey] !== undefined) {
      (result[prop] as string | number) = out[yamlKey]!;
    }
  }
  return result;
}

function configPath(storagePath: string): string {
  return path.resolve(storagePath, CONFIG_FILE);
}

export function loadSettings(storagePath: string): Partial<Settings> {
  const cp = configPath(storagePath);
  if (!fs.existsSync(cp)) return {};
  try {
    return loadYaml(fs.readFileSync(cp, "utf-8"));
  } catch {
    return {};
  }
}

export function resolveSettings(storagePath: string): Settings {
  const fileSettings = loadSettings(storagePath);
  return {
    teamName: process.env.AGMSG_TEAM ?? fileSettings.teamName ?? DEFAULTS.teamName,
    agentName: process.env.AGMSG_AGENT ?? fileSettings.agentName ?? DEFAULTS.agentName,
    watchInterval: parseInt(
      process.env.AGMSG_WATCH_INTERVAL ?? String(fileSettings.watchInterval ?? DEFAULTS.watchInterval), 10
    ),
  };
}

export function isConfigured(storagePath: string): boolean {
  return fs.existsSync(configPath(storagePath));
}

export function saveConfig(storagePath: string, cfg: { teamName: string; agentName: string; watchInterval?: number }): void {
  const cp = configPath(storagePath);
  const lines = [
    `# agmsg configuration`,
    `team_name: "${cfg.teamName}"`,
    `agent_name: "${cfg.agentName}"`,
  ];
  if (cfg.watchInterval !== undefined) {
    lines.push(`watch_interval: ${cfg.watchInterval}`);
  }
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, lines.join("\n") + "\n", "utf-8");
}

export function ensureDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_unread ON messages(team, to_agent, read_at) WHERE read_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_history ON messages(team, created_at DESC);
  `);
  db.close();
}
