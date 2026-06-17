#!/usr/bin/env bash
# e2e.sh -- End-to-end test for agmsg-qwencode-plugin
#
# Prerequisites:
#   - bun CLI available in PATH
#   - sqlite3 available in PATH
#
# Tests:
#   1. Creates a temporary agmsg database with unread messages
#   2. Runs bun run index.ts qwen-hook
#   3. Verifies JSON output format
#   4. Verifies message was consumed (read_at populated)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

cleanup() { rm -rf "$E2E_DIR"; }

echo "=== agmsg-qwencode-plugin E2E Test ==="

if ! command -v bun &>/dev/null; then
  echo "[FATAL] bun CLI not found in PATH"
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "[FATAL] sqlite3 not found in PATH"
  exit 1
fi

E2E_DIR=$(mktemp -d /tmp/agmsg-qwencode-plugin-e2e-XXXXX)
TEAM="test-team"
AGENT="qwen"
trap cleanup EXIT

echo "Temp workspace: $E2E_DIR"

# Create test agmsg database
mkdir -p "$E2E_DIR/db"
DB_PATH="$E2E_DIR/db/messages.db"
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

sqlite3 "$DB_PATH" \
  "INSERT INTO messages (team, from_agent, to_agent, body) VALUES ('$TEAM', 'e2e-tester', '$AGENT', 'E2E test message')"

echo "[setup] Unread messages in test DB:"
sqlite3 "$DB_PATH" "SELECT id, team, from_agent, to_agent, body, read_at FROM messages"

echo ""
echo "[exec] bun run $ROOT_DIR/index.ts qwen-hook"
echo "       AGMSG_TEAM=$TEAM AGMSG_STORAGE_PATH=$E2E_DIR"
echo ""

OUTPUT=$(cd "$ROOT_DIR" && AGMSG_TEAM="$TEAM" AGMSG_STORAGE_PATH="$E2E_DIR" bun run index.ts qwen-hook)

echo "[output] $OUTPUT"
echo ""

echo "=== Verification ==="

# Check JSON output format
if echo "$OUTPUT" | jq -e '.ok == true' >/dev/null 2>&1; then
  echo "[PASS] Output has ok: true"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Output missing ok: true"
  FAIL=$((FAIL + 1))
fi

# Check hookSpecificOutput exists and has additionalContext
if echo "$OUTPUT" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1; then
  echo "[PASS] Output has hookSpecificOutput.additionalContext"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Output missing hookSpecificOutput.additionalContext"
  FAIL=$((FAIL + 1))
fi

# Check additionalContext contains the message
if echo "$OUTPUT" | grep -q "E2E test message"; then
  echo "[PASS] Message content found in additionalContext"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message content NOT found in additionalContext"
  FAIL=$((FAIL + 1))
fi

# PRIMARY: Verify message was consumed
READ_AT=$(sqlite3 "$DB_PATH" "SELECT read_at FROM messages WHERE team='$TEAM' AND to_agent='$AGENT'")
if [ -n "$READ_AT" ]; then
  echo "[PASS] Message was marked as read (read_at=$READ_AT) -- plugin hook confirmed"
  PASS=$((PASS + 1))
else
  echo "[FAIL] Message was NOT marked as read -- plugin did not consume the message"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1