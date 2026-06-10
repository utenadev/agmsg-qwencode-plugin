# agmsg-qwencode-plugin

[README in English](README.md)

`bun:sqlite` を利用し、Qwen Code エージェントへ agmsg のメッセージ送受信機能を提供するネイティブプラグインです。

## なぜプラグインか

Qwen Code v0.5.1 には OpenCode の `experimental.chat.system.transform` に相当するシステムプロンプト注入フックはありませんが、[Command Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) というクリーンな IPC 機構を公式サポートしています。子プロセスが stdin でイベント JSON を受け取り、stdout で制御 JSON を返します。

このプラグインは **Stop フック** を活用します。Qwen Code が 1 ターン完了するたびにフックが発火し、未読メッセージをアトミックに取得して `additionalContext` 経由で Qwen の文脈へ注入します。手動ポーリング不要で、完全自律的なマルチエージェントメッセージングループを実現します。

## アーキテクチャ

```
Qwen Code (Stop フック)
  └── bun run index.ts qwen-hook
        └── bun:sqlite → ~/.agents/skills/agmsg/db/messages.db
              ├── consume  → UPDATE ... RETURNING（アトミック取得）
              └── (stdout) → JSON { ok, hookSpecificOutput.additionalContext }

Qwen Code (手動 CLI)
  └── bun run index.ts <inbox|send>
        ├── inbox  → SELECT 未読一覧（読み取り専用）
        └── send   → INSERT
```

## 操作一覧

| コマンド | SQL | 説明 |
|---------|-----|------|
| `inbox` | `SELECT` | 未読メッセージ一覧（既読化しない） |
| `consume` | `UPDATE ... RETURNING` | 最古の未読メッセージをアトミックに取得＋既読化 |
| `send` | `INSERT` | 他エージェントへメッセージ送信 |
| `qwen-hook` | `UPDATE ... RETURNING` | Stop フーク用：消費＋Qwen 形式 JSON 出力 |

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

# Qwen Code Stop フック（additionalContext 付き JSON を出力）
bun run index.ts qwen-hook

# JSON 出力（スクリプト用）
bun run index.ts inbox --json
bun run index.ts consume --json
```

## Qwen Code フック設定

`~/.qwen/settings.json` にプラグインを Stop フックとして登録します：

```json
{
  "hooks": [
    {
      "type": "command",
      "name": "agmsg-inbox-linker",
      "description": "各ターン完了時に agmsg メッセージを Qwen の文脈へ注入する",
      "events": ["Stop"],
      "command": "bun run /path/to/agmsg-qwencode-plugin/index.ts qwen-hook",
      "timeout": 5000
    }
  ]
}
```

メッセージがある場合、フークは以下を返します：

```json
{
  "ok": true,
  "hookSpecificOutput": {
    "additionalContext": "【agmsgシステム通知: 他のエージェントからメッセージが届きました】\n[2024-01-01T00:00:00Z] gemini → qwen: Hello from gemini"
  }
}
```

メッセージがない場合：

```json
{ "ok": true }
```

`additionalContext` の値は Qwen の会話履歴にシームレスに結合され、ユーザーが追加プロンプトを入力したのと同様に処理されます。Qwen は自律的に次の推論サイクルを開始します。

## 環境変数

| 変数 | デフォルト値 | 説明 |
|------|-------------|------|
| `AGMSG_TEAM` | `default_team` | メッセージルーティング対象のチーム |
| `AGMSG_AGENT` | `qwen` | エージェント名（agmsg の `to_agent` と一致させる） |
| `AGMSG_DB_PATH` | `~/.agents/skills/agmsg/db/messages.db` | agmsg SQLite データベースのパス |

## テスト

```bash
# ユニットテスト＋CLI テスト（26 テスト）
bun test

# E2E テスト（6 チェック）
./scripts/e2e.sh

# 型チェック
bun x tsc --noEmit
```

## agmsg-opencode-plugin との比較

| 機能 | OpenCode プラグイン | Qwen Code プラグイン |
|------|-------------------|---------------------|
| ランタイムフック | `experimental.chat.system.transform` | Command Hooks（Stop イベント） |
| 受信 | インポプロセスポーリング＋フック注入 | Stop フック経由 `additionalContext` |
| 送信 | 未実装 | `INSERT` via `bun:sqlite` |
| DB アクセス | `bun:sqlite`（インプロセス） | `bun:sqlite`（CLI サブプロセス） |
| Bash 依存 | なし | なし（Bun + JSON.stringify のみ） |

## ライセンス

MIT
