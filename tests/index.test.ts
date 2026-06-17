import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { openDb, listMyUnread, consumeMyNextMessage, sendMessage } from "../common.ts";

const tmpDirs = new Set<string>();

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agmsg-qwencode-plugin-test-"));
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
    row.team,
    row.from_agent,
    row.to_agent,
    row.body ?? "hello"
  );
  db.close();
}

function countRead(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.query("SELECT COUNT(*) AS cnt FROM messages WHERE read_at IS NOT NULL").get() as { cnt: number };
  db.close();
  return row.cnt;
}

function countUnread(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.query("SELECT COUNT(*) AS cnt FROM messages WHERE read_at IS NULL").get() as { cnt: number };
  db.close();
  return row.cnt;
}

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

  it("returns ALL-targeted messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "broadcaster", to_agent: "ALL", body: "Broadcast" });
    const db = openDb(dbPath);
    const msgs = listMyUnread(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msgs.length).toBe(1);
    expect(msgs[0].to_agent).toBe("ALL");
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
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "agent", body: "First", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: "team", from_agent: "a2", to_agent: "agent", body: "Second" });

    const db = openDb(dbPath);
    const msg = consumeMyNextMessage(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("First");
    db.close();

    expect(countUnread(dbPath)).toBe(1);
    expect(countRead(dbPath)).toBe(1);
  });

  it("marks message as read atomically", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "team", from_agent: "a1", to_agent: "agent", body: "Test" });
    const db = openDb(dbPath);
    const msg = consumeMyNextMessage(db, { dbPath, teamName: "team", agentName: "agent" });
    expect(msg).not.toBeNull();
    db.close();
    expect(countUnread(dbPath)).toBe(0);
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
    const row = db2.query("SELECT from_agent, to_agent FROM messages").get() as any;
    db2.close();

    expect(row.from_agent).toBe("real-sender");
    expect(row.to_agent).toBe("recipient");
  });
});
