# CLAUDE.md — Taikai-killer エージェント共通指示

このリポジトリで作業する全エージェント（**claude / gemini**）が従う規約。
設計の正は [`docs/`](./docs/README.md)。speca `CLAUDE.md` の書き方を流用（[steal-from-speca.md](./docs/steal-from-speca.md) F）。

## スタック（2026-06-11 確定）
- **TypeScript/Node** に統一（orchestrator も dashboard server も TS）。**Scrapling クロールのみ Python サイドカー**（`crawl-py/`）。
- モデルは **Claude + Gemini、両方サブスクリプション**。**claude CLI / gemini CLI を subprocess で駆動**（従量課金なし）。フェーズ×モデルは config で手動指定。
- 実行は[通常マシン・サンドボックス無効（隔離なし）](./docs/execution-premise.md)。使い捨てホストは使わない。

## Key Design Decisions（断定形・最上位）
- **単一ワーカーの失敗でループを止めない。** 失敗は partial に記録して局所スキップ。停止は**レート枯渇・ヒューマンレビューゲート・暴走停止(CB)のみ**。
- **コスト上限はデフォルト無制限。** 任意で `budget_usd` を指定したときだけ強制終了（exit 64）。未指定なら追跡のみで止めない（README「レート枯渇まで無限」/ D5）。
- **Partial results are first-class.** `outputs/{run}/partials/*.json` はログでなく**フェーズ間契約**。80%完了なら80%を次フェーズが消費する。Resume はディレクトリ glob スキャンのみ（状態DB・UUID を持たない）。
- **スキップ時も出力ファイルは必ず書く。** これが無いと Resume が item を取りこぼす（partial-first の必須要件）。
- **Circuit Breaker はフェーズ共有。** `consecutive_failures=5` / `total_retries=20` / `consecutive_empty_results=3` でトリップ→exit 65。
- **`E_RATELIMIT` は失敗にカウントしない。** 待機→復活→resume であって失敗ではない（CB の `consecutive_failures` に加算しない）。
- **決定論的失敗はリトライしない。** `E_CODE_TEST` は同一プロンプト再試行を禁止し、自己改善プロンプトで内容を変えて再生成のみ。
- **プロンプトは静的。** オーケストレータは穴埋め（`QUEUE_FILE`/`CONTEXT_FILE`/`OUTPUT_FILE`）のみ。変異させるのは data（戦略/閾値JSON）だけ、指示文は変異させない（再現性のため）。
- **評価器・テストの改ざん禁止。** 「テストを消す/編集して勝つ」自己欺瞞は禁止（報酬ハッキング対策 / Issue #2）。
- **評価ルブリックは外部化。** 大会固有ルールはコードに埋めず `TOURNAMENT_INFO.json`/`SCORING_RUBRIC.json`/`定義.json`/`題材.json` から注入。

## データフロー命名規約（固定）
- partial: `outputs/{run}/partials/S{n}_PARTIAL_W{worker}B{batch}_{ISO8601}.json`
- queue: `outputs/{run}/S{n}_QUEUE_W{worker}.json`
- log: `outputs/{run}/logs/S{n}_W{worker}B{batch}.jsonl`
- run dir: `outputs/{ISO8601}-{git短縮hash}-{大会slug}/`
- 状態3系統: `outputs/{run}/`（成果物・不変）/ `.taikai/runs/{id}/state.json`（可変・owner_pid）/ `~/.taikai/runtime.json`（永続）

## 環境変数
- `TAIKAI_RUN_ID` — 決定論的 run-id（resume の stitching に必須）
- `FORCE_EXECUTE=1` — resume をバイパスして強制実行
- `{PROVIDER}_MODEL` — runtime ごとのモデル指定（claude/gemini）。認証は CLI 側のサブスクログインを利用（API キーは持たない）

## Required — no hardcoded defaults
- `TOURNAMENT_INFO.json` / `SCORING_RUBRIC.json` / `定義.json` / `題材.json` が欠落したら当該フェーズを**止める**（黙ってデフォルトで進めない＝exit 1）。

## プロンプト規約
- 全プロンプトは `<task>`（IO契約）＋`<critical_requirements>`（譲れない条件）構造、100-300行。
- フェーズ別にツール許可を絞る（「集中力ガード」＝推論品質のため）。
- 探索的・横断的=skill フォーク／項目単位で閉じる=インライン。

## 実行前提
- [通常マシン・サンドボックス無効・隔離なし（リスク受容）](./docs/execution-premise.md)。安全は隔離でなく運用ガード（CB・予算・レビューゲート）で担保。詰まったら [troubleshooting.md](./docs/troubleshooting.md) の4ステップ。
