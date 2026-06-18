import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, readFileSync } from "fs";

const tmpDirs = new Set<string>();
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agmsg-test-"));
  tmpDirs.add(dir);
  const dbPath = join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      read_at TEXT
    );
    CREATE INDEX idx_unread ON messages(team, to_agent, read_at) WHERE read_at IS NULL;
  `);
  db.close();
  return dbPath;
}

function seed(dbPath: string, row: { team: string; from_agent: string; to_agent: string; body?: string }) {
  const db = new Database(dbPath);
  db.run(
    "INSERT INTO messages (team, from_agent, to_agent, body) VALUES (?, ?, ?, ?)",
    row.team, row.from_agent, row.to_agent, row.body ?? "hello"
  );
  db.close();
}

import {
  openDb,
  listMyUnread,
  consumeMyNextMessage,
  sendMessage,
  listTeams,
  listMembers,
  isConfigured,
  saveConfig,
  ensureDb,
} from "../common.ts";

describe("openDb", () => {
  it("opens a database with WAL mode enabled", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    expect(db).toBeDefined();
    db.close();
  });
});

describe("listMyUnread", () => {
  it("returns empty array when no unread messages", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs).toEqual([]);
    db.close();
  });

  it("returns unread messages for matching agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "agent", body: "Hello" });
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("Hello");
    expect(msgs[0].from_agent).toBe("a1");
    db.close();
  });

  it("does not return messages for different team", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "other", from_agent: "a1", to_agent: "agent", body: "Hello" });
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs.length).toBe(0);
    db.close();
  });

  it("does not return messages for different agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "other", body: "Hello" });
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs.length).toBe(0);
    db.close();
  });

  it("does not return ALL-targeted messages (broadcast not supported)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "broadcaster", to_agent: "ALL", body: "Broadcast" });
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs.length).toBe(0);
    db.close();
  });
});

describe("consumeMyNextMessage", () => {
  it("returns null when no unread messages", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    const msg = consumeMyNextMessage(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msg).toBeNull();
    db.close();
  });

  it("atomically claims and returns the oldest unread message", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "agent", body: "First" });
    seed(dbPath, { team: "team", from_agent: "a2", to_agent: "agent", body: "Second" });
    const db = openDb(dbPath);
    const msg = consumeMyNextMessage(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("First");
    db.close();
  });

  it("marks message as read atomically", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "agent", body: "Test" });
    const db = openDb(dbPath);
    consumeMyNextMessage(db, { dbPath, teamName: "team", agentName: "agent" });
    db.close();
    const db2 = openDb(dbPath);
    const row = db2.query("SELECT read_at FROM messages WHERE id = 1").get() as { read_at: string };
    db2.close();
    expect(row.read_at).not.toBeNull();
  });
});

describe("sendMessage", () => {
  it("inserts a message and returns the result", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    const result = sendMessage(db, { dbPath, teamName: "team", agentName: "sender" }, "recipient", "Hello");
    expect(result.ok).toBe(true);
    expect(result.to).toBe("recipient");
    expect(result.team).toBe("team");
    expect(result.id).toBeGreaterThan(0);
    db.close();
  });

  it("forces from_agent to configured agent name", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    sendMessage(db, { dbPath, teamName: "team", agentName: "real-sender" }, "recipient", "Test");
    db.close();
    const db2 = openDb(dbPath);
    const row = db2.query("SELECT from_agent FROM messages WHERE id = 1").get() as { from_agent: string };
    db2.close();
    expect(row.from_agent).toBe("real-sender");
  });
});

describe("listTeams", () => {
  it("returns empty array when no teams exist", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    const teams = listTeams(db);
    expect(teams).toEqual([]);
    db.close();
  });

  it("returns distinct team names", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team-a", from_agent: "a1", to_agent: "a2", body: "msg1" });
    seed(dbPath, { team: "team-b", from_agent: "b1", to_agent: "b2", body: "msg2" });
    seed(dbPath, { team: "team-a", from_agent: "a2", to_agent: "a1", body: "msg3" });
    const db = openDb(dbPath);
    const teams = listTeams(db);
    expect(teams).toEqual(["team-a", "team-b"]);
    db.close();
  });
});

describe("listMembers", () => {
  it("returns empty array when no messages in team", () => {
    const dbPath = freshDb();
    const db = openDb(dbPath);
    const members = listMembers(db, "team");
    expect(members).toEqual([]);
    db.close();
  });

  it("returns distinct agent names in team", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "alice", to_agent: "bob", body: "msg1" });
    seed(dbPath, { team: "team", from_agent: "bob", to_agent: "charlie", body: "msg2" });
    const db = openDb(dbPath);
    const members = listMembers(db, "team");
    expect(members).toEqual(["alice", "bob", "charlie"]);
    db.close();
  });
});

describe("isConfigured", () => {
  it("returns false when no config.yaml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-cfg-test-"));
    tmpDirs.add(dir);
    expect(isConfigured(dir)).toBe(false);
  });

  it("returns true when config.yaml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-cfg-test-"));
    tmpDirs.add(dir);
    saveConfig(dir, { teamName: "t", agentName: "a" });
    expect(isConfigured(dir)).toBe(true);
  });
});

describe("saveConfig", () => {
  it("writes config.yaml with team_name and agent_name", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-cfg-test-"));
    tmpDirs.add(dir);
    saveConfig(dir, { teamName: "my-team", agentName: "my-agent" });
    const content = readFileSync(join(dir, "config.yaml"), "utf-8");
    expect(content).toContain('team_name: "my-team"');
    expect(content).toContain('agent_name: "my-agent"');
  });

  it("includes watch_interval when provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-cfg-test-"));
    tmpDirs.add(dir);
    saveConfig(dir, { teamName: "t", agentName: "a", watchInterval: 5000 });
    const content = readFileSync(join(dir, "config.yaml"), "utf-8");
    expect(content).toContain("watch_interval: 5000");
  });
});

describe("ensureDb", () => {
  it("creates the database and tables if not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-ensuredb-test-"));
    tmpDirs.add(dir);
    const dbPath = join(dir, "sub", "db", "messages.db");
    ensureDb(dbPath);
    const db = new Database(dbPath);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[];
    db.close();
    expect(tables.some(t => t.name === "messages")).toBe(true);
    expect(indexes.some(i => i.name === "idx_unread")).toBe(true);
    expect(indexes.some(i => i.name === "idx_history")).toBe(true);
  });

  it("is idempotent — does not fail if called twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "agmsg-ensuredb-test-"));
    tmpDirs.add(dir);
    const dbPath = join(dir, "db", "messages.db");
    ensureDb(dbPath);
    ensureDb(dbPath);
    const db = new Database(dbPath);
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    db.close();
    expect(tables.some(t => t.name === "messages")).toBe(true);
  });
});
