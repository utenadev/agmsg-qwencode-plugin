import { describe, it, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { listUnread, consumeNext, sendMessage } from "../index.js";

// ---------------------------------------------------------------------------
// Test configuration
// ---------------------------------------------------------------------------

const TEAM = "test-team";
const AGENT = "qwen";
process.env.AGMSG_AGENT = AGENT; // for sendMessage() which reads from env

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

function cli(dbPath: string, args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "..", "index.ts"), ...args], {
    env: {
      ...process.env,
      AGMSG_DB_PATH: dbPath,
      AGMSG_TEAM: TEAM,
      AGMSG_AGENT: AGENT,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    exitCode: proc.exitCode,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agmsg-qwencode-"));
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
    CREATE INDEX idx_unread ON messages(team, to_agent, created_at) WHERE read_at IS NULL;
  `);
  db.close();
  return dbPath;
}

function seed(
  dbPath: string,
  row: { team: string; from_agent: string; to_agent: string; body?: string; created_at?: string },
) {
  const db = new Database(dbPath);
  const cols = "team, from_agent, to_agent, body" + (row.created_at ? ", created_at" : "");
  const placeholders = "?, ?, ?, ?" + (row.created_at ? ", ?" : "");
  const params: any[] = [row.team, row.from_agent, row.to_agent, row.body ?? "hello"];
  if (row.created_at) params.push(row.created_at);
  db.run(`INSERT INTO messages (${cols}) VALUES (${placeholders})`, ...params);
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listUnread()", () => {
  it("returns empty array when no unread messages exist", () => {
    const dbPath = freshDb();
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs).toEqual([]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("returns unread messages for matching team and agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Hello from gemini" });
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("Hello from gemini");
    expect(msgs[0].from_agent).toBe("gemini");
    expect(msgs[0].read_at).toBeNull();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not return messages for a different team", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: "other-team", from_agent: "gemini", to_agent: AGENT, body: "Wrong team" });
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs).toEqual([]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not return messages for a different agent", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: "codex", body: "Wrong agent" });
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs).toEqual([]);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("returns ALL-targeted messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "coordinator", to_agent: "ALL", body: "Broadcast" });
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("Broadcast");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("returns messages in FIFO order (oldest first)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "a", to_agent: AGENT, body: "First", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: TEAM, from_agent: "b", to_agent: AGENT, body: "Second" });
    const msgs = listUnread(dbPath, TEAM, AGENT);
    expect(msgs.length).toBe(2);
    expect(msgs[0].body).toBe("First");
    expect(msgs[1].body).toBe("Second");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not mark messages as read (list only)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "test" });
    listUnread(dbPath, TEAM, AGENT);
    expect(countRead(dbPath)).toBe(0);
    expect(countUnread(dbPath)).toBe(1);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("throws when database does not exist", () => {
    expect(() => listUnread("/nonexistent/db.sqlite", TEAM, AGENT)).toThrow("agmsg database not found");
  });
});

describe("consumeNext()", () => {
  it("returns null when no unread messages exist", () => {
    const dbPath = freshDb();
    const msg = consumeNext(dbPath, TEAM, AGENT);
    expect(msg).toBeNull();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("atomically claims and marks message as read", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Consume me" });
    const msg = consumeNext(dbPath, TEAM, AGENT);
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("Consume me");
    expect(msg!.read_at).not.toBeNull();
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("consumes oldest message first (FIFO)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "a", to_agent: AGENT, body: "Oldest", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: TEAM, from_agent: "b", to_agent: AGENT, body: "Newest" });
    const msg = consumeNext(dbPath, TEAM, AGENT);
    expect(msg!.body).toBe("Oldest");
    expect(msg!.from_agent).toBe("a");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not consume already-read messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "a", to_agent: AGENT, body: "Already read" });
    const db = new Database(dbPath);
    db.run("UPDATE messages SET read_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
    db.close();
    const msg = consumeNext(dbPath, TEAM, AGENT);
    expect(msg).toBeNull();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("consumes messages targeted to ALL", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "coordinator", to_agent: "ALL", body: "For everyone" });
    const msg = consumeNext(dbPath, TEAM, AGENT);
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("For everyone");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("throws when database does not exist", () => {
    expect(() => consumeNext("/nonexistent/db.sqlite", TEAM, AGENT)).toThrow("agmsg database not found");
  });
});

describe("sendMessage()", () => {
  it("inserts a message and returns result", () => {
    const dbPath = freshDb();
    const result = sendMessage(dbPath, TEAM, "gemini", "Hello from qwen");
    expect(result.ok).toBe(true);
    expect(result.id).toBeGreaterThan(0);
    expect(result.to).toBe("gemini");
    expect(result.team).toBe(TEAM);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("inserted message is visible as unread on the recipient side", () => {
    const dbPath = freshDb();
    sendMessage(dbPath, TEAM, "gemini", "Test message");
    const msgs = listUnread(dbPath, TEAM, "gemini");
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("Test message");
    expect(msgs[0].from_agent).toBe(AGENT);
    expect(msgs[0].to_agent).toBe("gemini");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("supports messages to ALL", () => {
    const dbPath = freshDb();
    const result = sendMessage(dbPath, TEAM, "ALL", "Broadcast from qwen");
    expect(result.ok).toBe(true);
    const qwenMsgs = listUnread(dbPath, TEAM, "qwen");
    const codexMsgs = listUnread(dbPath, TEAM, "codex");
    expect(qwenMsgs.some((m) => m.body === "Broadcast from qwen")).toBe(true);
    expect(codexMsgs.some((m) => m.body === "Broadcast from qwen")).toBe(true);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("does not allow spoofing from_agent", () => {
    const dbPath = freshDb();
    // sendMessage no longer accepts fromAgent — from_agent is forced to AGMSG_AGENT
    sendMessage(dbPath, TEAM, "gemini", "Forced sender");
    const db = new Database(dbPath);
    const rows = db.query("SELECT from_agent FROM messages").all() as { from_agent: string }[];
    db.close();
    expect(rows.length).toBe(1);
    expect(rows[0].from_agent).toBe(AGENT);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("throws when database does not exist", () => {
    expect(() => sendMessage("/nonexistent/db.sqlite", TEAM, "gemini", "test")).toThrow(
      "agmsg database not found",
    );
  });
});

describe("round-trip: send → consume", () => {
  it("agent A sends to agent B, agent B consumes", () => {
    const dbPath = freshDb();
    sendMessage(dbPath, TEAM, "gemini", "Integration test");
    const msg = consumeNext(dbPath, TEAM, "gemini");
    expect(msg).not.toBeNull();
    expect(msg!.body).toBe("Integration test");
    expect(msg!.from_agent).toBe(AGENT);
    expect(consumeNext(dbPath, TEAM, "gemini")).toBeNull();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("FIFO order across multiple messages", () => {
    const dbPath = freshDb();
    sendMessage(dbPath, TEAM, "gemini", "Msg 1");
    sendMessage(dbPath, TEAM, "gemini", "Msg 2");
    sendMessage(dbPath, TEAM, "gemini", "Msg 3");

    const m1 = consumeNext(dbPath, TEAM, "gemini");
    const m2 = consumeNext(dbPath, TEAM, "gemini");
    const m3 = consumeNext(dbPath, TEAM, "gemini");
    const m4 = consumeNext(dbPath, TEAM, "gemini");

    expect(m1!.body).toBe("Msg 1");
    expect(m2!.body).toBe("Msg 2");
    expect(m3!.body).toBe("Msg 3");
    expect(m4).toBeNull();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });
});

describe("qwen-hook CLI", () => {
  it("outputs { ok: true } when no unread messages", () => {
    const dbPath = freshDb();
    const result = cli(dbPath, ["qwen-hook"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("outputs additionalContext JSON when unread message exists", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Hello from gemini" });
    const result = cli(dbPath, ["qwen-hook"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[agmsg]");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("gemini");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Hello from gemini");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("marks message as read after hook invocation", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "Consume me" });
    cli(dbPath, ["qwen-hook"]);
    const result = cli(dbPath, ["qwen-hook"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.hookSpecificOutput).toBeUndefined();
    expect(countRead(dbPath)).toBe(1);
    expect(countUnread(dbPath)).toBe(0);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("consumes oldest message first (FIFO)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "a", to_agent: AGENT, body: "First", created_at: "2024-01-01T00:00:00Z" });
    seed(dbPath, { team: TEAM, from_agent: "b", to_agent: AGENT, body: "Second" });
    const result = cli(dbPath, ["qwen-hook"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("a");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("First");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("handles messages with special characters (quotes, newlines)", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: 'He said "hello"\nand then left' });
    const result = cli(dbPath, ["qwen-hook"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('He said "hello"');
    expect(parsed.hookSpecificOutput.additionalContext).toContain("and then left");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("handles ALL-targeted messages", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "coordinator", to_agent: "ALL", body: "Broadcast msg" });
    const result = cli(dbPath, ["qwen-hook"]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Broadcast msg");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("coordinator");
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });

  it("bundles multiple unread messages into one notification", () => {
    const dbPath = freshDb();
    seed(dbPath, { team: TEAM, from_agent: "gemini", to_agent: AGENT, body: "First msg" });
    seed(dbPath, { team: TEAM, from_agent: "codex", to_agent: AGENT, body: "Second msg" });
    const result = cli(dbPath, ["qwen-hook"]);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("First msg");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Second msg");
    // Both should be consumed in one call
    expect(countUnread(dbPath)).toBe(0);
    expect(countRead(dbPath)).toBe(2);
    rmSync(join(dbPath, ".."), { recursive: true, force: true });
  });
});
