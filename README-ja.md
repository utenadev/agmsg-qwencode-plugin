# agmsg-qwencode-plugin

agmsg MCP server プラグイン for Qwen Code — SQLite ベースのエージェント間メッセージング。

## アーキテクチャ

```
Qwen Code
    │
    ▼
agmsg-qwencode-plugin (MCP server)
    │
    ├─ agmsg_send      → sendMessage()
    ├─ agmsg_inbox     → listMyUnread()
    ├─ agmsg_consume   → consumeMyNextMessage()
    ├─ agmsg_count     → countMyUnread()
    ├─ agmsg_teams     → listTeams()
    ├─ agmsg_members   → listMembers()
    └─ agmsg_setup     → setupWizard（設定確認 / 初期化）
    │
    ▼
SQLite (WAL mode)
```

AI エージェントは7つの MCP ツール経由でのみ操作できます。データベースの直接アクセスはできません。

## インストール

```bash
cd ~/.qwen/extensions
git clone <repo-url> agmsg-qwencode
cd agmsg-qwencode
bun install
```

Qwen Code を再起動すると、拡張機能が自動的に読み込まれます。

## 設定

環境変数、またはストレージディレクトリ内の `config.yaml` で設定します：

```yaml
team_name: my_team
agent_name: qwen
watch_interval: 10000
```

環境変数（設定ファイルより優先）：
- `AGMSG_STORAGE_PATH` — ストレージディレクトリ（デフォルト: `~/.agents/skills/agmsg`）
- `AGMSG_TEAM` — チーム名
- `AGMSG_AGENT` — エージェント名
- `AGMSG_WATCH_INTERVAL` — ポーリング間隔（ミリ秒）

## 開発

```bash
bun install
bun test          # テスト実行
bun run typecheck # 型チェック
bun run build     # dist/ にコンパイル
bun run monitor   # モニターループ（未読メッセージをポーリング）
```

## テスト

37 テスト（common.test.ts: 21 + server.test.ts: 16）:

```
bun test
```

テストはInMemoryTransport を使用した MCP サーバーテストと、SQLite を使った単体テストの両方をカバーしています。

## ライセンス

MIT
