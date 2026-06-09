# agmsg-qwencode-plugin

[README in Japanese (日本語)](README-ja.md)

Native SQLite3 agmsg integration for Qwen Code — send + inbox via `bun:sqlite`.

## Why a plugin?

Qwen Code v0.5.1 does not expose a plugin/hook API for system-prompt injection (unlike OpenCode's `experimental.chat.system.transform`). This plugin therefore operates as a **CLI helper** that Qwen Code invokes via shell commands, reading/writing the agmsg SQLite database directly.

## Architecture

```
Qwen Code (CLI)
  └── shell command: bun run index.ts <inbox|consume|send>
        └── bun:sqlite → ~/.agents/skills/agmsg/db/messages.db
              ├── inbox   → SELECT unread (read-only)
              ├── consume → UPDATE ... RETURNING (atomic claim)
              └── send    → INSERT
```

## Operations

| Command | SQL | Description |
|---------|-----|-------------|
| `inbox` | `SELECT` | List unread messages (does not mark read) |
| `consume` | `UPDATE ... RETURNING` | Atomically claim and mark oldest unread as read |
| `send` | `INSERT` | Send a message to another agent |

## Prerequisites

- Bun runtime (for `bun:sqlite`)
- `agmsg` with a SQLite database at the default path (or custom via `AGMSG_DB_PATH`)

## Installation

```bash
git clone <repo-url>
cd agmsg-qwencode-plugin
bun install
```

## Usage

```bash
# List unread messages (does not mark read)
bun run index.ts inbox

# Claim and display next unread message (marks as read)
bun run index.ts consume

# Send a message
bun run index.ts send <to_agent> "<message>"

# JSON output (for scripting)
bun run index.ts inbox --json
bun run index.ts consume --json
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGMSG_TEAM` | `default_team` | Team namespace for message routing |
| `AGMSG_AGENT` | `qwen` | Agent name (must match the `to_agent` in agmsg messages) |
| `AGMSG_DB_PATH` | `~/.agents/skills/agmsg/db/messages.db` | Path to the agmsg SQLite database |

## Receiving messages between turns

Qwen Code has no Monitor tool and no system-prompt injection hook. To receive messages automatically between turns, wire agmsg core's `check-inbox.sh` into `.qwen/settings.json` as a Stop hook (using `codex` type, since `qwen` is not yet in the allowlist):

```bash
~/.agents/skills/agmsg/scripts/delivery.sh set turn codex "$(pwd)"
```

This is the same mechanism used by Codex and Goose agents.

## Testing

```bash
# Unit tests (20 tests)
bun test

# E2E test (6 checks)
./scripts/e2e.sh

# Type check
bun x tsc --noEmit
```

## Comparison with agmsg-opencode-plugin

| Feature | OpenCode plugin | Qwen Code plugin |
|---------|----------------|-----------------|
| Runtime hook | `experimental.chat.system.transform` | None (CLI-based) |
| Receive | In-process polling + hook injection | agmsg core `check-inbox.sh` via Stop hook |
| Send | Not implemented | `INSERT` via `bun:sqlite` |
| DB access | `bun:sqlite` (in-process) | `bun:sqlite` (CLI subprocess) |

## License

MIT
