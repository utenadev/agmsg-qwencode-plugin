import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../index.ts";

const tmpDirs = new Set<string>();
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function createTestEnv(): { storagePath: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "agmsg-server-test-"));
  tmpDirs.add(dir);
  const dbDir = join(dir, "db");
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "messages.db");
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
  return { storagePath: dir, dbPath };
}

function seed(dbPath: string, row: { team: string; from_agent: string; to_agent: string; body?: string; created_at?: string }) {
  const db = new Database(dbPath);
  if (row.created_at) {
    db.run(
      "INSERT INTO messages (team, from_agent, to_agent, body, created_at) VALUES (?, ?, ?, ?, ?)",
      row.team, row.from_agent, row.to_agent, row.body ?? "hello", row.created_at
    );
  } else {
    db.run(
      "INSERT INTO messages (team, from_agent, to_agent, body) VALUES (?, ?, ?, ?)",
      row.team, row.from_agent, row.to_agent, row.body ?? "hello"
    );
  }
  db.close();
}

async function createConnectedClient(storagePath: string, teamName: string, agentName: string): Promise<Client> {
  const server = createServer(storagePath, teamName, agentName);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

describe("MCP server", () => {
  it("creates a server with tools registered", () => {
    const { storagePath } = createTestEnv();
    const server = createServer(storagePath, "test-team", "qwen");
    expect(server).toBeDefined();
  });
});

describe("agmsg_send", () => {
  it("sends a message to another agent", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_send", arguments: { to_agent: "bob", body: "Hello bob" } });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Message sent to bob");
    await client.close();
  });

  it("forces from_agent to configured agent name", async () => {
    const { storagePath, dbPath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    await client.callTool({ name: "agmsg_send", arguments: { to_agent: "bob", body: "Test" } });
    await client.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT from_agent, to_agent FROM messages WHERE id = 1").get() as any;
    db.close();
    expect(row.from_agent).toBe("qwen");
    expect(row.to_agent).toBe("bob");
  });
});

describe("agmsg_inbox", () => {
  it("returns empty when no unread messages", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_inbox", arguments: {} });
    expect(result.content[0].text).toBe("No unread messages.");
    await client.close();
  });

  it("lists unread messages without marking as read", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "Hello" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_inbox", arguments: {} });
    expect(result.content[0].text).toContain("alice");
    expect(result.content[0].text).toContain("Hello");
    await client.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT read_at FROM messages WHERE id = 1").get() as any;
    db.close();
    expect(row.read_at).toBeNull();
  });
});

describe("agmsg_consume", () => {
  it("returns empty when no unread messages", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_consume", arguments: {} });
    expect(result.content[0].text).toBe("No unread messages.");
    await client.close();
  });

  it("consumes oldest unread message and marks as read", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "First", created_at: "2026-01-01T00:00:00Z" });
    seed(dbPath, { team: "test-team", from_agent: "bob", to_agent: "qwen", body: "Second", created_at: "2026-01-01T00:00:01Z" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_consume", arguments: {} });
    expect(result.content[0].text).toContain("alice");
    expect(result.content[0].text).toContain("First");
    expect(result.content[0].text).toContain("[agmsg]");
    await client.close();
  });
});

describe("agmsg_count", () => {
  it("returns 0 when no unread messages", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_count", arguments: {} });
    expect(result.content[0].text).toBe("0");
    await client.close();
  });

  it("returns correct count of unread messages", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "msg1" });
    seed(dbPath, { team: "test-team", from_agent: "bob", to_agent: "qwen", body: "msg2" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_count", arguments: {} });
    expect(result.content[0].text).toBe("2");
    await client.close();
  });
});

describe("agmsg_teams", () => {
  it("returns empty when no teams", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_teams", arguments: {} });
    expect(result.content[0].text).toBe("No teams found.");
    await client.close();
  });

  it("lists distinct teams", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "team-a", from_agent: "a1", to_agent: "a2", body: "msg1" });
    seed(dbPath, { team: "team-b", from_agent: "b1", to_agent: "b2", body: "msg2" });
    const client = await createConnectedClient(storagePath, "team-a", "qwen");
    const result = await client.callTool({ name: "agmsg_teams", arguments: {} });
    expect(result.content[0].text).toContain("team-a");
    expect(result.content[0].text).toContain("team-b");
    await client.close();
  });
});

describe("agmsg_members", () => {
  it("returns empty when no members", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_members", arguments: {} });
    expect(result.content[0].text).toBe("No members found.");
    await client.close();
  });

  it("lists distinct agents in team", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "bob", body: "msg1" });
    seed(dbPath, { team: "test-team", from_agent: "bob", to_agent: "charlie", body: "msg2" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_members", arguments: {} });
    expect(result.content[0].text).toContain("alice");
    expect(result.content[0].text).toContain("bob");
    expect(result.content[0].text).toContain("charlie");
    await client.close();
  });
});

describe("agmsg_setup", () => {
  it("returns already-configured status when config exists", async () => {
    const { storagePath } = createTestEnv();
    writeFileSync(
      join(storagePath, "config.yaml"),
      "team_name: existing-team\nagent_name: existing-agent\n"
    );
    const client = await createConnectedClient(storagePath, "existing-team", "existing-agent");
    const result = await client.callTool({ name: "agmsg_setup", arguments: {} });
    expect(result.content[0].text).toContain("Already configured");
    expect(result.content[0].text).toContain("existing-team");
    expect(result.content[0].text).toContain("existing-agent");
    await client.close();
  });

  it("returns not-configured prompt when no args given", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_setup", arguments: {} });
    expect(result.content[0].text).toContain("Not configured");
    expect(result.content[0].text).toContain("team_name and agent_name");
    await client.close();
  });

  it("saves config and creates DB when team_name and agent_name provided", async () => {
    const { storagePath, dbPath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({
      name: "agmsg_setup",
      arguments: { team_name: "new-team", agent_name: "new-agent" },
    });
    expect(result.content[0].text).toContain("Configuration saved");
    expect(result.content[0].text).toContain("new-team");
    expect(result.content[0].text).toContain("new-agent");
    await client.close();
    // Verify config.yaml was written
    const cfgContent = readFileSync(join(storagePath, "config.yaml"), "utf-8");
    expect(cfgContent).toContain('team_name: "new-team"');
    expect(cfgContent).toContain('agent_name: "new-agent"');
  });
});

describe("agmsg_check", () => {
  it("returns empty when no unread messages", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_check", arguments: {} });
    expect(result.content[0].text).toBe("No unread messages.");
    await client.close();
  });

  it("returns count and messages when unread exists", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "Hello" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_check", arguments: {} });
    expect(result.content[0].text).toContain("1 unread message(s)");
    expect(result.content[0].text).toContain("alice");
    expect(result.content[0].text).toContain("Hello");
    await client.close();
  });

  it("does not mark messages as read", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "Hello" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    await client.callTool({ name: "agmsg_check", arguments: {} });
    await client.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT read_at FROM messages WHERE id = 1").get() as any;
    db.close();
    expect(row.read_at).toBeNull();
  });
});

describe("agmsg_auto_consume", () => {
  it("returns empty when no unread messages", async () => {
    const { storagePath } = createTestEnv();
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_auto_consume", arguments: {} });
    expect(result.content[0].text).toBe("No unread messages.");
    await client.close();
  });

  it("classifies question and suggests reply action", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "What is the status?" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_auto_consume", arguments: {} });
    expect(result.content[0].text).toContain("question=true");
    expect(result.content[0].text).toContain("request=false");
    expect(result.content[0].text).toContain("action: reply with agmsg_send");
    await client.close();
  });

  it("classifies request and suggests execute action", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "レビューしてほしい" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_auto_consume", arguments: {} });
    expect(result.content[0].text).toContain("question=false");
    expect(result.content[0].text).toContain("request=true");
    expect(result.content[0].text).toContain("action: acknowledge and execute");
    await client.close();
  });

  it("classifies notification and suggests no reply", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "Build passed." });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    const result = await client.callTool({ name: "agmsg_auto_consume", arguments: {} });
    expect(result.content[0].text).toContain("question=false");
    expect(result.content[0].text).toContain("request=false");
    expect(result.content[0].text).toContain("action: no reply needed");
    await client.close();
  });

  it("marks message as read", async () => {
    const { storagePath, dbPath } = createTestEnv();
    seed(dbPath, { team: "test-team", from_agent: "alice", to_agent: "qwen", body: "Hello?" });
    const client = await createConnectedClient(storagePath, "test-team", "qwen");
    await client.callTool({ name: "agmsg_auto_consume", arguments: {} });
    await client.close();
    const db = new Database(dbPath);
    const row = db.query("SELECT read_at FROM messages WHERE id = 1").get() as any;
    db.close();
    expect(row.read_at).not.toBeNull();
  });
});
