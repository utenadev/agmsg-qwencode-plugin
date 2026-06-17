# agmsg-qwencode-plugin

[README in Japanese (日本語)](README-ja.md)

Native SQLite3 agmsg integration for Qwen Code — send + inbox + hook via `bun:sqlite`.

## Why a plugin?

Qwen Code v0.5.1 does not expose a plugin/hook API for system-prompt injection (unlike OpenCode's `experimental.chat.system.transform`). However, Qwen Code **does** support [Command Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) — a clean IPC mechanism where a child process receives event JSON via stdin and returns control JSON via stdout.

This plugin leverages the **Stop hook** event: after each Qwen Code turn completes, the hook fires, consumes the oldest unread agmsg message atomically, and injects it into Qwen's context via `additionalContext`. This enables fully autonomous multi-agent message loops — no manual polling needed.

## Architecture

```
Qwen Code (Stop hook)
  └── bun run index.ts qwen-hook
        └── bun:sqlite → ~/.agents/skills/agmsg/db/messages.db
              ├── consume  → UPDATE ... RETURNING (atomic claim)
              └── (stdout) → JSON { ok, hookSpecificOutput.additionalContext }

Qwen Code (manual CLI)
  └── bun run index.ts <inbox|send>
        ├── inbox  → SELECT unread (read-only)
        └── send   → INSERT
```

## Operations

| Command | SQL | Description |
|---------|-----|-------------|
| `inbox` | `SELECT` | List unread messages (does not mark read) |
| `consume` | `UPDATE ... RETURNING` | Atomically claim and mark oldest unread as read |
| `send` | `INSERT` | Send a message to another agent |
| `qwen-hook` | `UPDATE ... RETURNING` | Stop hook: consume + output Qwen-format JSON |

## Prerequisites

- Bun runtime (for `bun:sqlite`)
- `agmsg` with a SQLite database at the default path (or custom via `AGMSG_STORAGE_PATH`)

## Installation

Copy `index.ts` + `common.ts` to any directory. No `bun install` required — `bun:sqlite` is built into Bun.

```bash
# Optional: symlink for convenience
ln -s /path/to/agmsg-qwencode-plugin /your/workspace/agmsg-qwencode-plugin
```

## Usage

```bash
# List unread messages (does not mark read)
bun run index.ts inbox

# Claim and display next unread message (marks as read)
bun run index.ts consume

# Send a message
bun run index.ts send <to_agent> "<message>"

# Qwen Code Stop hook (outputs JSON with additionalContext)
bun run index.ts qwen-hook

# JSON output (for scripting)
bun run index.ts inbox --json
bun run index.ts consume --json
```

## Qwen Code Hook Setup

Wire the plugin into Qwen Code as a Stop hook by adding to `~/.qwen/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bun run /path/to/agmsg-qwencode-plugin/index.ts qwen-hook"
          }
        ]
      }
    ]
  }
}
```

When a message is waiting, the hook returns:

```json
{
  "ok": true,
  "hookSpecificOutput": {
    "additionalContext": "[agmsg] Message from \"gemini\":\\n---\\nHello from gemini\\n---\\nReply using the send tool if appropriate."
  }
}
```

When no messages are waiting, the hook returns:

```json
{ "ok": true }
```

The `additionalContext` value is appended to Qwen's conversation history seamlessly — Qwen processes it as if the user had typed additional input, and autonomously starts the next reasoning cycle.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AGMSG_STORAGE_PATH` | `~/.agents/skills/agmsg` | Base directory for agmsg data (appends `/db/messages.db`) |
| `AGMSG_DB_PATH` | ~/.agents/skills/agmsg/db/messages.db | Direct path to messages.db (fallback if AGMSG_STORAGE_PATH unset) |
| `AGMSG_TEAM` | `default_team` | Team namespace for message routing |
| `AGMSG_AGENT` | `qwen` | Agent name (must match the `to_agent` in agmsg messages) |

## Testing

```bash
# Unit + CLI tests (46 tests)
bun test

# E2E test (10 checks)
./scripts/e2e.sh

# Type check
bun x tsc --noEmit
```

## Comparison with agmsg-opencode-plugin

| Feature | OpenCode plugin | Qwen Code plugin |
|---------|----------------|-----------------|
| Runtime hook | `experimental.chat.system.transform` | Command Hooks (Stop event) |
| Receive | In-process polling + hook injection | `additionalContext` via Stop hook |
| Send | `INSERT` via `bun:sqlite` (tool) | `INSERT` via `bun:sqlite` (CLI) |
| DB access | `bun:sqlite` (in-process) | `bun:sqlite` (CLI subprocess) |
| Bash dependency | None | None (pure Bun + JSON.stringify) |
| Code structure | Self-contained (`index.ts` + `common.ts`) | Self-contained (`index.ts` + `common.ts`) |

## License

MIT