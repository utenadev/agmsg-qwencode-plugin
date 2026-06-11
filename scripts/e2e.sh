#!/usr/bin/env bash
# e2e.sh — End-to-end test for agmsg-qwencode-plugin
#
# 1. Creates a temporary agmsg database
# 2. Seeds an unread message for team=test-team / to_agent=qwen
# 3. Runs `bun run index.ts inbox` and `consume` to verify read path
# 4. Runs `bun run index.ts send` to verify write path
# 5. Verifies the message was consumed (read_at populated)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR=$(mktemp -d /tmp/agmsg-qwencode-e2e-XXXXX)
TEAM="test-team"
AGENT="qwen"
PASS=0
FAIL=0

cleanup() { rm -rf "$E2E_DIR"; }
trap cleanup EXIT

echo "=== agmsg-qwencode-plugin E2E Test ==="
echo "Temp dir: $E2E_DIR"

# Create test agmsg database
DB_PATH="$E2E_DIR/e2e.db"
sqlite3 "$DB_PATH" <<'SQL'
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
SQL

# Seed: gemini sends to qwen
sqlite3 "$DB_PATH" \
  "INSERT INTO messages (team, from_agent, to_agent, body) VALUES ('$TEAM', 'gemini', '$AGENT', 'E2E test message from gemini')"

echo "[setup] Unread messages in test DB:"
sqlite3 "$DB_PATH" "SELECT id, team, from_agent, to_agent, body, read_at FROM messages"

echo ""
echo "[test 1] inbox — list unread"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts inbox)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "E2E test message from gemini"; then
  echo "[PASS] inbox shows unread message"
  PASS=$((PASS + 1))
else
  echo "[FAIL] inbox did not show unread message"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 2] consume — claim and mark read"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts consume)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "E2E test message from gemini"; then
  echo "[PASS] consume returned the message"
  PASS=$((PASS + 1))
else
  echo "[FAIL] consume did not return the message"
  FAIL=$((FAIL + 1))
fi

# Verify read_at is set
READ_AT=$(sqlite3 "$DB_PATH" "SELECT read_at FROM messages WHERE team='$TEAM' AND to_agent='$AGENT'")
if [ -n "$READ_AT" ]; then
  echo "[PASS] Message was marked as read (read_at=$READ_AT)"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message was NOT marked as read"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 3] send — qwen sends to gemini"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts send gemini "Hello from qwen E2E")
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "Sent to gemini"; then
  echo "[PASS] send succeeded"
  PASS=$((PASS + 1))
else
  echo "[FAIL] send failed"
  FAIL=$((FAIL + 1))
fi

# Verify gemini can see it
GEMINI_UNREAD=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM messages WHERE team='$TEAM' AND to_agent='gemini' AND read_at IS NULL")
if [ "$GEMINI_UNREAD" -eq 1 ]; then
  echo "[PASS] gemini sees 1 unread message"
  PASS=$((PASS + 1))
else
  echo "[FAIL] gemini sees $GEMINI_UNREAD unread messages (expected 1)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 4] consume again — no more messages"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts consume)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "No new messages"; then
  echo "[PASS] consume correctly reports no new messages"
  PASS=$((PASS + 1))
else
  echo "[FAIL] consume did not report no new messages"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 5] qwen-hook — empty inbox returns { ok: true }"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts qwen-hook)
echo "$OUTPUT"
PARSED_OK=$(echo "$OUTPUT" | jq -r '.ok' 2>/dev/null)
PARSED_HOOK=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput' 2>/dev/null)
if [ "$PARSED_OK" = "true" ] && [ "$PARSED_HOOK" = "null" ]; then
  echo "[PASS] qwen-hook returns { ok: true } with no messages"
  PASS=$((PASS + 1))
else
  echo "[FAIL] qwen-hook did not return expected empty JSON (ok=$PARSED_OK, hook=$PARSED_HOOK)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 6] qwen-hook — unread message returns additionalContext JSON"
# Seed a new unread message
sqlite3 "$DB_PATH" \
  "INSERT INTO messages (team, from_agent, to_agent, body) VALUES ('$TEAM', 'codex', '$AGENT', 'Hook test from codex')"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts qwen-hook)
echo "$OUTPUT"
PARSED_OK=$(echo "$OUTPUT" | jq -r '.ok' 2>/dev/null)
PARSED_CTX=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null)
if [ "$PARSED_OK" = "true" ] && [ "$PARSED_CTX" != "null" ] && echo "$PARSED_CTX" | grep -q 'Hook test from codex'; then
  echo "[PASS] qwen-hook returns additionalContext with message"
  PASS=$((PASS + 1))
else
  echo "[FAIL] qwen-hook did not return expected additionalContext (ok=$PARSED_OK, ctx=$PARSED_CTX)"
  FAIL=$((FAIL + 1))
fi

# Verify the message was consumed
HOOK_READ_AT=$(sqlite3 "$DB_PATH" "SELECT read_at FROM messages WHERE body='Hook test from codex'")
if [ -n "$HOOK_READ_AT" ]; then
  echo "[PASS] Message consumed by qwen-hook (read_at=$HOOK_READ_AT)"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message was NOT consumed by qwen-hook"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "[test 7] qwen-hook — second call returns empty (already consumed)"
OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_AGENT="$AGENT" AGMSG_DB_PATH="$DB_PATH" bun run index.ts qwen-hook)
echo "$OUTPUT"
PARSED_OK=$(echo "$OUTPUT" | jq -r '.ok' 2>/dev/null)
PARSED_HOOK=$(echo "$OUTPUT" | jq -r '.hookSpecificOutput' 2>/dev/null)
if [ "$PARSED_OK" = "true" ] && [ "$PARSED_HOOK" = "null" ]; then
  echo "[PASS] qwen-hook returns empty after consumption"
  PASS=$((PASS + 1))
else
  echo "[FAIL] qwen-hook did not return empty after consumption (ok=$PARSED_OK, hook=$PARSED_HOOK)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
