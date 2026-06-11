# 運用 Runbook — 無限ループ運用のトラブルシュート

S2..S6 をレート枯渇まで∞ループで回す前提の運用手順。speca `troubleshooting.md` の型を流用（[steal-from-speca.md](./steal-from-speca.md) E-5）。
実行前提は[通常マシン・サンドボックス無効・隔離なし](./execution-premise.md)。

---

## 4ステップ確認順序（詰まったら必ずこの順）

1. **stderr 末尾50行** — オーケストレータ本体の例外
2. **`outputs/{run}/logs/<phase>_W*B*.jsonl` 末尾** — ワーカーの tool_use ループ / API timeout / overload
3. **`.taikai/runs/{id}/state.json`** — supervisor がそのrunをどう認識しているか（status / owner_pid）
4. **`outputs/{run}/partials/*.json`** — どこまで保存済みか（partial-first なのでここまでは無駄にならない）

---

## 症状別の対処

| 症状 | 対処 |
|---|---|
| **暴走（全batch失敗 / tool_use ループ）** | Circuit Breaker が **exit 65** でトリップ済みのはず。logs jsonl 末尾で原因（ループ/timeout/overload）を特定。CB 3カウンタ: `consecutive_failures=5` / `total_retries=20` / `consecutive_empty_results=3`（steal A-2） |
| **再開したい** | `--force` で resume 状態を無視。**破損 partial は該当 batch だけ削除して resume**（例 `rm outputs/{run}/partials/S5_PARTIAL_W0B5_*.json`）。queue 破損は `rm .../S5_QUEUE_*.json` で再生成 |
| **orphan run（プロセス死亡だが running 表示）** | `state.json` の **`owner_pid` がOSに存在しなければ orphan**。supervisor 起動時の `reconcile_orphans` が自動で `running→crashed` にリラベル。手動なら state.json を直接patch。**∞ループ＋物理切断（USBレター変動・断続切断）で頻発するので必須** |
| **レート枯渇（429）** | `E_RATELIMIT`：**失敗にカウントせず**待機→復活→resume。または別モデル（Claude↔Gemini）に切替。`E_RATELIMIT` は CB の `consecutive_failures` に**加算しない**（独自分岐） |
| **コスト超過** | **`budget_usd` を指定したときだけ** `BudgetExceeded` で **exit 64**（result 保存＋通知、90%で early-stop）。デフォルト無制限では発火しない（D5） |
| **workspace 肥大（戦略多数で数GB）** | `projects/{strategy_id}/` は **bare clone + `git worktree add --detach`** でディスク節約（D13）。不要 worktree を rm（次回再生成） |
| **MCP 不安定（クロール/解析）** | `E_CRAWL`：MCP 失敗→**built-in（requests/シェル `rg`）にフォールバック**（steal D-3）。「N項目個別MCPコール」より「1コマンドでバッチ→マップ参照」 |
| **ホスト汚染/破壊** | `E_HOST`：**通常マシン運用のため自動破棄はしない**。検知して通知＋停止、復旧は手動（IaC再作成は任意）。`outputs/` は別ディスク/クラウドへ定期バックアップ推奨 |
| **状態リセット（run単位）** | `rm -rf .taikai/runs/{id}/ outputs/{run}/`。`~/.taikai/runtime.json`（永続選好）は消さない |

---

## 終了コード規約（CB / 予算）

| code | 意味 | トリガ |
|---|---|---|
| 64 | `BudgetExceeded` | USD 予算上限（**`budget_usd` 指定時のみ**。デフォルト無制限では無効） |
| 65 | `CircuitBreakerTripped` | 連続失敗5 / 総リトライ20 / 連続空出力3 |
| 2  | runtime 未実装 | 未登録 runtime 指定（silent fallback 禁止 / fail-fast） |

無人運用では終了コードを **Dashboard/Slack 通知**に変換する（通知が来ないと「無限ループ」が「無限停止」になるため、**exit code→Slack webhook の通知は初回実装の必須項目**）。

---
*関連: directory-structure.md（state 3系統分離）, decisions.md（D11/D13）, execution-premise.md*
