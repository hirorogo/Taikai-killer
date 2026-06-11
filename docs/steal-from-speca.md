# speca md 精読 → 流用パターン集（パクれるもの）

speca (NyxFoundation/speca) の md（agent-design / OPTIMIZATION_NOTES / project-structure / config-files / multi-runtime / troubleshooting / release-artifacts / PHASE_B_DESIGN ほか）を精読し、Taikai-killer に**流用できるパターンだけ**を抽出した。speca固有（Ethereum監査）で使えないものは末尾に明記。

> 凡例: ★=最重要・即流用 / 出典は speca のファイル名

---

## A. ハーネス設計

### A-1 ★ 失敗モードを4分類してリトライ可否を変える
- 出典: `agent-design/harness.md`, `overview.md`
- speca: `MaxTurnsExhausted`（決定論的→**リトライしない**）／一時APIエラー（5xx/rate→指数バックオフ最大3回）／スキーマ検証失敗（リトライせず partial を寛容に書く）／`BudgetExceeded`・`CircuitBreakerTripped`（即停止）。「決定論的失敗のリトライは無駄、かつ予算を実質押し上げる」。
- **流用**: `architecture.md` のエラー経路表に**「リトライ可否」列を追加**。`E_CODE_TEST` は同一プロンプトでの単純リトライ禁止→**自己改善プロンプトで内容を変えて再生成のみ**。

### A-2 ★ サーキットブレーカーは3カウンタ（数値そのまま流用）
- 出典: `harness.md`, `CLAUDE.md`
- speca: フェーズあたり共有CB。`consecutive_failures=5` / `total_retries=20` / `consecutive_empty_results=3` のいずれかで作動→実行中タスクをキャンセルし**exit 65**。
- **流用**: しきい値3種をそのまま採用。`consecutive_empty_results=3` は S5 の空ループ検知に直結。**ただし `E_RATELIMIT` は CB の failures にカウントしない**（待機→復活→resume であって失敗ではない）。これは speca に無い Taikai-killer 独自分岐＝明示必須。

### A-3 ★ PhaseConfig：フェーズを1エントリで宣言（config駆動）
- 出典: `harness.md`（config.py→base.py→runner.py→watchdog.py の浅い依存）
- speca: `PhaseConfig` が「プロンプトパス・IO glob・バッチ戦略・CB閾値・コスト上限・MCPサーバ・ツール許可」を1箇所で宣言。新フェーズ追加＝config 1行＋プロンプト＋スキーマ。
- **流用**: S1..S6 を `PhaseConfig` エントリで宣言。`orchestrator/config.py` の中核に。

### A-4 ワーカー数とバッチサイズの分離
- 出典: `harness.md`
- speca: バッチサイズ1（1項目=1プロンプト）＋ `--workers 4 --max-concurrent 8` で1キーを使い切る。
- **流用**: S3/S5 は「1戦略=1ワーカー」。ただし Taikai-killer はマルチプロバイダなので**プロバイダごとに max-concurrent を持つ**拡張（speca は単一キー前提で未対応）。

---

## B. Context Engineering（肥大化対策）

### B-1 ★ Partial = フェーズ間契約（状態DBを持たない）
- 出典: `context-engineering.md`, `harness.md`, `CLAUDE.md`
- speca: `outputs/<phase>_PARTIAL_*.json` はログでなく**契約**。Resume はディレクトリ glob スキャンだけ（状態DB・UUID・孤児クリーンアップ無し）。partial 出力は first-class（80%完了なら80%を次フェーズが消費）。検証は glob 時に寛容に。SQLite を**あえて使わない**（grep可・publish可優先）。
- **流用**: 既採用済み命名と完全一致。**Resume を「partial の item_id スキップ」だけにし状態DBを持たない**。これは**破壊前提運用（execution-premise）と完全に噛み合う**（ホスト破壊→再作成→partial から resume）。Collector の検証は寛容に（1件不一致で全捨てしない）。

### B-2 ★ 派生インデックスでコンテキストを項目あたりコストから切り離す
- 出典: `context-engineering.md`（Subgraph index）, `OPTIMIZATION_NOTES.md`
- speca: ロード時に一度だけ逆引きインデックスを構築、ワーカーは必要エントリだけ参照→Phase 03 トークン40-60%削減。
- **流用**: S4/S5 で S2 外部知見を全文投入すると破綻。**S2 ロード時に `知見INDEX.json`（戦略タグ/キーワード→知見ファイルパス逆引き）を一度だけ構築**、各ワーカーは関連知見だけ pull。「全文は output に貯める／投入は index 経由」。

### B-3 事前解決フェーズ（1度払って後で取り返す）
- 出典: `context-engineering.md`, `OPTIMIZATION_NOTES.md`（Code Resolution Pre-execution）
- speca: 監査前に Phase 02c で「コード位置の事前解決のみ」実行→本体は推論に集中。MCP 70-80%・トークン40-60%削減。
- **流用**: S5 の前に**「要件↔実装の対応付け事前解決フェーズ」**（README 5a を独立フェーズ化）。「既存コードのどこを触るか/新規か/スコープ外か」を先に解決。

### B-4 ★ slim スキーマ（下流が読まないフィールドは生まない）
- 出典: `context-engineering.md`
- speca: 使われないコンテキストはデッドウェイト。`covers` を単一文字列、`reachability` を4フィールドに削減。
- **流用**: `Strategy`/`BenchResult` 等は**次フェーズが実際に読むフィールドだけ**に絞る。特に S3 戦略 JSON は大量生成されるので肥大が全体を遅くする。

### B-5 静的プロンプト＋データだけ変異（再現性と進化の両立）
- 出典: `context-engineering.md`（オーケストレータはプロンプトを編集しない）
- speca: プロンプトは静的ファイル、オーケストレータは穴埋めのみ（動的プロンプトは監査不可）。
- **流用**: 再現性が最終目標なので強く採用。ただし進化的最適化と両立させるため**変異対象は data（戦略JSON・閾値JSON）だけ、指示文は変異させない**と切り分け。

---

## C. Prompt & Skill

### C-1 ★ Skill フォーク vs インラインの使い分け基準
- 出典: `prompts-and-skills.md`
- speca: 探索的・横断的=skill（`context: fork`）／項目単位で閉じる=インライン。インライン化で項目あたり15-25%短縮・品質劣化なし。
- **流用**: **S2 クロール（横断探索）=skill フォーク**、**S3/S4/S5（1戦略で閉じる）=インライン**。

### C-2 ★ プロンプト共通構造 `<task>` / `<critical_requirements>`（= template.md の実装）
- 出典: `prompts-and-skills.md`
- speca: 全プロンプトが先頭 `<task>`（IO契約）＋`<critical_requirements>`（譲れない条件、例「スキップ時も出力ファイルは必ず書く」）。100-300行。
- **流用**: README 項目11「template.md で文体一致」の**実装そのもの**。全エージェントプロンプトをこの構造で固定。「**スキップ時も出力ファイルは必ず書く**」は partial-first(B-1) 成立の必須要件。マルチプロバイダで同一テンプレ強制の効果大。

### C-3 ★ フェーズ別ツール許可リスト（権限ガードでなく「集中力ガード」）
- 出典: `prompts-and-skills.md`, `CLAUDE.md`
- speca: フェーズごとにツール許可を絞る。効果は①誤操作防止 ②**モデルの行動空間を絞って推論の質を上げる**。Phase 03/04 は Read/Write/Grep/Glob のみ。
- **流用**: execution-premise（サンドボックス無効）と矛盾しない——あれは「**安全のための**隔離はしない」であって「**品質のための**行動制限をしない」ではない。**②の理由でツール許可を絞る**（S3 戦略生成に Bash を渡すと脱線、S6 評価で Write を絞り result 汚染防止）。「集中力ガード」として位置づけ。

### C-4 上流に強モデル・下流に高速モデル
- 出典: `prompts-and-skills.md`
- speca: 前半（知識構造構築）=Opus、後半（実装検証）=Sonnet。「カバレッジの bottleneck は上流」。
- **流用**: **S1/S3（カバレッジを縛る上流）に強モデル、S5/S6 に高速安価モデル**。ただし具体モデル名・精度数値は監査での実測値＝**数値は流用不可、原則のみ**。

---

## D. OPTIMIZATION_NOTES（コスト/速度）

### D-1 早期終了でトークン削減（ただし品質地点では禁止）
- speca: 自明に安全な対象を早期スキップ。**ただし品質を守る場所では早期 exit を明示的に禁止**。
- **流用**: S3 で「明らかに重複/実現不可」を S4 前に安価に drop。**S5 テスト判定・S6 評価では短絡禁止**（手抜き判定で偽の優勝が混入する）。

### D-2 ★ プロンプトキャッシュを最大化するバッチ編成
- speca: 共通コンテキスト（skill/schema）を据え置き、同一ファイルの項目をまとめてバッチ→ヒット率50%→80%。
- **流用**: バッチビルダーで**ランダム分割でなく「類似戦略/同一題材を同じワーカーに固める」**。README 4「フォルダ構成を使い回す」はキャッシュ効率と一致。

### D-3 ★ MCP 過依存をやめて built-in に退避した実例
- 出典: `OPTIMIZATION_NOTES.md`（Phase 02c Bug Fix）
- speca: MCP tree_sitter で解決率17.3%まで低下（不安定でカスケード失敗）→ built-in `rg`/`grep` に置換し「全シンボルを1正規表現で grep 1回→マップ参照」で>80%。教訓「MCP は安定インフラにだけ、不安定なら built-in 退避」。
- **流用**: S2 クロール（Scrapling/playwright-mcp）に**MCP 不安定時の built-in フォールバックを最初から設計**（`E_CRAWL` に「MCP失敗→requests/シェル再試行」）。「N項目を個別MCPコール」より「1コマンドでバッチ→マップ参照」。

---

## E. config駆動・運用（structure/ops より）

### E-1 ★ 大会1件＝最小入力JSONセット（ルブリック外部化）
- 出典: `config-files.md`, `quickstart.md`
- speca: 入力は `outputs/TARGET_INFO.json`＋`BUG_BOUNTY_SCOPE.json` の2つだけ＝パイプライン唯一の入力。**重大度ルブリックをコードでなく設定に置く→本体をコンテスト非依存に保つ**。`speca doctor` が起動前に検証。
- **流用**: `TOURNAMENT_INFO.json`（大会の識別: 名前/URL/締切/言語/制約）＋`SCORING_RUBRIC.json`（評価軸/配点/禁止事項）を `outputs/{run}/` 直下に。**設計第5原則「評価ルブリックの外部化（大会非依存）」**を追加。`taikai doctor` 起動前バリデータ。

### E-2 ★ 状態を3系統に分離（run固有/supervisor状態/ユーザ永続）
- 出典: `multi-runtime.md`, `troubleshooting.md`
- speca: `outputs/{run}/`（成果物）／`.speca/runs/<id>/state.json`（status/owner_pid/cancel_requested/budget）／`~/.speca/runtime.json`（永続選好）。**APIキーは設定に保存せず環境変数から読む**。
- **流用**: `.taikai/runs/<id>/state.json`（可変: status/owner_pid/cancel_requested）と `outputs/{run}/run_manifest.json`（不変メタ）を**分離**。`owner_pid` は orphan 検出に必須（∞ループ＋物理切断で頻発）。秘密は環境変数のみ。

### E-3 ★ マルチランタイム登録（runtime_registry の実装解／D19）
- 出典: `multi-runtime.md`
- speca: 2系統のランナー抽象＝**CLI subprocess型**（claude/copilot/gemini/codex）と**OpenAI互換HTTP型**（`APIRunner` 基底→Codex/Gemini/Ollama がサブクラスで base_url/model だけ差替）。env規約 `{PROVIDER}_API_KEY/MODEL/BASE_URL`。`--list-runtimes` で availability 自己診断。未実装は**silent fallback でなく exit 2**。Ollama/Copilot 定額は cost=0。
- **流用（D4で更新）**: 確定は **Claude + Gemini の2つを CLI subprocess** で駆動（speca の HTTP `APIRunner` 階層はサブスク CLI に流用不可）。`runtimeRegistry.ts` に `checkAvailable()`、env命名規約を config に固定、**未実装 runtime は exit 2**。codex/ollama/copilot は将来。

### E-4 ★ 自己改善の成果物 = locked prompt + manifest（プロバナンス）
- 出典: `PHASE_B_DESIGN.md`
- speca: 自己改善ループの成果を `prompts/<task>/locked/<phase>/v1.md`＋`manifest.json`（baseline_recall/locked_recall/recall_delta_pp/rounds/cost/seed/dataset_hash）。`PhaseConfig.prompt_override_path`＋`--locked` で baseline⇄改善版を切替。eval ハーネスは orchestrator を import のみで触らず別パッケージに隔離。
- **流用**: D20 の prompt 版管理を**`prompts/locked/<phase>/v{n}.md`＋manifest.json（improved/baseline スコア・コスト・seed・dataset_hash）**に強化。`config.py` に `prompt_override_path`＋`--locked`。自己改善ループは `evolution/`（orchestrator から import のみ）に隔離。

### E-5 ★ ∞ループ運用の troubleshooting Runbook
- 出典: `troubleshooting.md`
- speca の実運用対処: **batch粒度 resume**（破損 `PARTIAL_W{w}B{b}` だけ rm して再開）／**orphan検出**（`state.json` の `owner_pid` が無ければ orphan→`reconcile_orphans` で `running→crashed`）／429で runtime を ollama/codex に切替／workspace肥大は **bare clone + worktree**／最後の砦 `rm -rf .speca/ outputs/`。**4ステップ確認順序**（stderr末尾→logs jsonl末尾→state.json→PARTIAL）。
- **流用**: `docs/troubleshooting.md`（作成済み）。

### E-6 成果物の Release bundle 保全
- 出典: `release-artifacts.md`
- speca: 大容量生データは Git でなく **GitHub Release に zstd tarball**。repo は図/表/レビューmd だけ allowlist。タグ `bench-<rq>-<date>-<suffix>`、sidecar `<tag>.manifest.json`（archive_sha256/ファイル数）で復元検証。publish は `workflow_dispatch` 手動。
- **流用**: 進化生データ（islands/program_db/trajectory）は Release に zstd bundle、repo は系統図/result.md だけ allowlist。タグ `taikai-<tournament>-<date>-<strategy_id>`、sidecar manifest で完全性検証。

---

## F. CLAUDE.md で真似るべき項目
- 出典: speca `CLAUDE.md`
- **Key Design Decisions を1行ずつ断定形で列挙**／データフロー命名規約を固定／環境変数一覧（`FORCE_EXECUTE=1` 等の resume バイパス、決定論的 run-id）／「Required xxx — no hardcoded defaults（欠落なら exit 1）」。
- **流用**: Taikai-killer の `CLAUDE.md`（作成済み）。

---

## 流用不可（speca固有）
- **3ゲート recall-safe フィルタ / STRIDE+CWE / proof-attempt / severity_classification** はセキュリティ監査固有＝**流用不可**。ただしメタ原則だけ抽象化可:「却下基準が安いゲートを先に・soft-reject禁止・判定は後段に集約」→ S6 戦略足切り順序に応用、「領域知識はプロンプトに埋めず外部JSONから注入」→ 大会ルールを `定義.json`/`題材.json` から注入。
- **MCP tree-sitter は claude 専用** → multi-runtime は「全フェーズ等価」でない。コード解析フェーズは runtime 固定が必要。
- **具体数値（削減%・精度・モデル選定・workers/concurrent）** は監査での実測値＝**再計測前提、数値は流用不可・手法のみ流用**。

---
*speca 実 md の精読に基づく。関連: directory-structure.md / architecture.md / decisions.md / troubleshooting.md / Issue #1#2*
