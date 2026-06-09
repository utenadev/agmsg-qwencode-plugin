# agmsg-qwencode-plugin

[README in English](README.md)

`bun:sqlite` を利用し、Qwen Code エージェントへ agmsg のメッセージ送受信機能を提供するネイティブプラグインです。

## なぜプラグインか

Qwen Code v0.5.1 には OpenCode の `experimental.chat.system.transform` に相当するシステムプロンプト注入フックがありません。そのため、**CLI ツールとして呼び出す方式**をとります。Qwen Code からシェルコマンド経由で呼び出され、agmsg の SQLite データベースに直接アクセスします。

## アーキテクチャ

```
Qwen Code (CLI)
  └── シェルコマンド: bun run index.ts <inbox|consume|send>
        └── bun:sqlite → ~/.agents/skills/agmsg/db/messages.db
              ├── inbox   → SELECT 未読一覧（読み取り専用）
              ├── consume → UPDATE ... RETURNING（アトミック取得）
              └── send    → INSERT
```

## 操作一覧

| コマンド | SQL | 説明 |
|---------|-----|------|
| `inbox` | `SELECT` | 未読メッセージ一覧（既読化しない） |
| `consume` | `UPDATE ... RETURNING` | 最古の未読メッセージをアトミックに取得＋既読化 |
| `send` | `INSERT` | 他エージェントへメッセージ送信 |

## 前提条件

- Bun ランタイム（`bun:sqlite` のため）
- `agmsg` の SQLite データベース（デフォルトパス、または `AGMSG_DB_PATH` で指定）

## インストール

```bash
git clone <repo-url>
cd agmsg-qwencode-plugin
bun install
```

## 使い方

```bash
# 未読メッセージ一覧（既読化しない）
bun run index.ts inbox

# 次回の未読メッセージを取得（既読化する）
bun run index.ts consume

# メッセージ送信
bun run index.ts send <宛先エージェント> "<メッセージ>"

# JSON 出力（スクリプト用）
bun run index.ts inbox --json
bun run index.ts consume --json
```

## 環境変数

| 変数 | デフォルト値 | 説明 |
|------|-------------|------|
| `AGMSG_TEAM` | `default_team` | メッセージルーティング対象のチーム |
| `AGMSG_AGENT` | `qwen` | エージェント名（agmsg の `to_agent` と一致させる） |
| `AGMSG_DB_PATH` | `~/.agents/skills/agmsg/db/messages.db` | agmsg SQLite データベースのパス |

## ターン間の自動受信

Qwen Code には Monitor ツールがなく、システムプロンプト注入フックもありません。ターン間に自動でメッセージを受信するには、agmsg コアの `check-inbox.sh` を `.qwen/settings.json` の Stop フック経由で呼び出します（`qwen` が allowlist に未登録のため `codex` タイプを使用）:

```bash
~/.agents/skills/agmsg/scripts/delivery.sh set turn codex "$(pwd)"
```

Codex や Goose と同じ方式です。

## テスト

```bash
# ユニットテスト（20 テスト）
bun test

# E2E テスト（6 チェック）
./scripts/e2e.sh

# 型チェック
bun x tsc --noEmit
```

## agmsg-opencode-plugin との比較

| 機能 | OpenCode プラグイン | Qwen Code プラグイン |
|------|-------------------|---------------------|
| ランタイムフック | `experimental.chat.system.transform` | なし（CLI ベース） |
| 受信 | インポプロセスポーリング＋フック注入 | agmsg コア `check-inbox.sh` を Stop フック経由 |
| 送信 | 未実装 | `INSERT` via `bun:sqlite` |
| DB アクセス | `bun:sqlite`（インプロセス） | `bun:sqlite`（CLI サブプロセス） |

## ライセンス

MIT
