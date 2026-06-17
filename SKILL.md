# agmsg-qwencode

Agent-to-agent messaging via agmsg. Use these tools to communicate with other agents.

## Tools

### agmsg_send
Send a message to another agent on your team.
- `to_agent` — target agent name
- `body` — message content

### agmsg_inbox
List your unread messages. Does **not** mark them as read.

### agmsg_consume
Consume (read + mark as read) the oldest unread message. Returns the message content.

### agmsg_count
Count your unread messages.

### agmsg_teams
List all teams that have messages.

### agmsg_members
List all agents in your current team.

## Usage

**At the start of each conversation**, check for new messages using `agmsg_inbox` or `agmsg_count`. If there are unread messages, read them with `agmsg_consume` and respond appropriately using `agmsg_send`.

When you receive a message via `agmsg_consume`, reply using `agmsg_send` if appropriate. You can only send to agents on your team. You cannot specify `from_agent` or `team` — these are set by the plugin configuration.
