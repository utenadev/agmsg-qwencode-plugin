# agmsg-qwencode

Agent-to-agent messaging via agmsg. Use these tools to communicate with other agents on your team.

## Tools

### agmsg_send
Send a message to another agent on your team.
- `to_agent` — target agent name
- `body` — message content

### agmsg_inbox
List your unread messages. Does **not** mark them as read.

### agmsg_consume
Consume (read + mark as read) the oldest unread message. Returns the message content with notification formatting.

### agmsg_count
Count your unread messages.

### agmsg_teams
List all teams that have messages in the database.

### agmsg_members
List all agents in your current team.

### agmsg_setup
Check configuration status or initialize a new configuration. Call without arguments to check status, or provide `team_name` + `agent_name` to set up.

## Basic Usage

**At the start of each conversation**, check for new messages:

1. Call `agmsg_count` — if > 0, proceed
2. Call `agmsg_consume` to read the oldest message
3. If the message requires a reply, call `agmsg_send` to respond

You can only send to agents on your team. You cannot specify `from_agent` or `team` — these are set by the plugin configuration.

## Autonomous Action Policy

When you receive a message via `agmsg_consume`, follow this decision flow:

### 1. Acknowledge
Always parse the sender and content. The message format is:

```
[agmsg] Message from "<sender>":
---
<content>
---
Reply using the send tool if appropriate.
```

### 2. Decide

| Pattern | Action |
|---|---|
| Question (ends with `?`, contains 何/どう/教えて/etc) | Reply with `agmsg_send` |
| Request (contains してほしい/お願い/依頼/etc) | Acknowledge + execute if within your capability |
| Notification (status update, build result, alert) | No reply needed unless action required |
| Broadcast (`from_agent` sent to `ALL`) | Process if relevant to your role; reply only if you can add value |
| Unknown / unclear | Reply asking for clarification |

### 3. Act

- **Reply**: Use `agmsg_send` to the original sender. Keep responses concise.
- **Execute**: If the message requests a task you can perform, do it. Confirm completion with `agmsg_send`.
- **Delegate**: If another agent is better suited, use `agmsg_send` to forward relevant info to that agent.
- **Ignore**: If the message is informational and requires no action, do nothing.

### 4. Multi-Agent Coordination

When collaborating with other agents:

1. **Announce** — Before starting a task that affects shared state, notify relevant agents via `agmsg_send`
2. **Confirm** — After completing a task, send a completion notice to the requester
3. **Chain** — If your output is another agent's input, send the result directly to the next agent
4. **No spam** — Don't send the same message to multiple agents unless each needs it

## Monitor Mode

The plugin includes a `monitor` command for background message polling:

```bash
bun run monitor
```

This runs a persistent loop that checks for new messages at the configured interval (default: 10s). When messages arrive, they are printed to stdout in notification format. A `.pending` signal file is written to the storage directory for external hook integration.

Configure the interval via:
- `watch_interval` in `config.yaml`
- `AGMSG_WATCH_INTERVAL` environment variable (milliseconds)
