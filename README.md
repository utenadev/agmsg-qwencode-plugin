# agmsg-qwencode-plugin

agmsg MCP server plugin for Qwen Code — agent-to-agent messaging over SQLite.

## Architecture

```
Qwen Code
    │
    ▼
agmsg-qwencode-plugin (MCP server)
    │
    ├─ agmsg_send      → sendMessage()
    ├─ agmsg_inbox     → listMyUnread()
    ├─ agmsg_consume      → consumeMyNextMessage()
    ├─ agmsg_count        → countMyUnread()
    ├─ agmsg_teams        → listTeams()
    ├─ agmsg_members      → listMembers()
    ├─ agmsg_setup        → setupWizard (check status or init config)
    ├─ agmsg_check        → countMyUnread() + listMyUnread()
    └─ agmsg_auto_consume → consumeMyNextMessage() + parseMessageType()
    │
    ▼
SQLite (WAL mode)
```

AI agents can only interact through the 9 MCP tools. The database is fully hidden.

## Installation

```bash
cd ~/.qwen/extensions
git clone <repo-url> agmsg-qwencode
cd agmsg-qwencode
bun install
```

Then restart Qwen Code. The extension will be loaded automatically.

## Configuration

Set environment variables or create `config.yaml` in the storage directory:

```yaml
team_name: my_team
agent_name: qwen
watch_interval: 10000
```

Environment variables (override config file):
- `AGMSG_STORAGE_PATH` — storage directory (default: `~/.agents/skills/agmsg`)
- `AGMSG_TEAM` — team name
- `AGMSG_AGENT` — agent name
- `AGMSG_WATCH_INTERVAL` — poll interval in ms

## Development

```bash
bun install
bun test          # run all tests
bun run typecheck # type check
bun run build     # compile to dist/
bun run monitor   # monitor loop (poll for unread messages)
```

## License

MIT
