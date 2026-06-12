# ディレクトリ構成（確定）— nyx speca / presentation-agent 準拠

Taikai-killer のフォルダ構成を、nyx foundation の実プロジェクト
[**speca**](https://github.com/NyxFoundation/speca)（全体パイプライン）と
[**presentation-agent**](https://github.com/NyxFoundation/presentation-agent)（発表生成）の
**実構造を直接取得して**確定する。これにより `docs/decisions.md` の **D1（フォルダ vs branch）を「フォルダ構造」で確定**する。

> 取得元の実物（2026-06-11 時点）:
> - speca: `scripts/orchestrator/`・`prompts/`・`schemas/`・`outputs/{ts}-{commit}-{target}/` の3層契約構造
> - presentation-agent: `Makefile` + `inputs/` + `prompts/(01..09 + self-improvement)` + `slides.md`

---

## 設計方針（speca から踏襲する4原則）

1. **フェーズ別 prompt 分離** — `prompts/<phase>_<role>.md`（speca: `01a_crawl.md`, `04_review_worker.md`）
2. **フェーズ間 JSON Schema 契約** — `schemas/` に「データ型 / `Phase*Partial` / `*Event` / `RunManifest`」の3+1層（D2/D9 を満たす）
3. **orchestrator を独立パッケージ化** — runner/queue/batch/collector/factory/resume/watchdog/config/paths（D11/D13/D14）
4. **run 単位の outputs ディレクトリ** — `outputs/{ISO8601}-{commit}-{tournament}/` に成果物・ログ・提出物を隔離（D9/D15/D17）
5. **評価ルブリックの外部化（大会非依存）** — 大会固有の評価軸・配点・ルールはコードに埋めず `TOURNAMENT_INFO.json`/`SCORING_RUBRIC.json`/`定義.json`/`題材.json` から注入。ハーネス本体を別大会に転用可能に保つ（speca `BUG_BOUNTY_SCOPE.json` 流用 / [steal-from-speca.md](./steal-from-speca.md) E-1）

スタック（**2026-06-11 確定**）: **TypeScript/Node** に統一（speca の Python orchestrator を TS に書き換え）。dashboard server も TS/Node。**Scrapling クロールのみ Python サイドカー**。モデルは **Claude + Gemini（サブスク）を CLI subprocess で駆動**。発表は presentation-agent（後で vendor）。

---

## トップレベル構成（確定）

```
Taikai-killer/
├── README.md
├── CLAUDE.md                 # エージェント共通指示
├── package.json / tsconfig   # TS コア依存（pnpm/npm）
├── Makefile                  # フェーズ実行のエントリ
├── .github/                  # CI（schema 検証・lint・tsc）
│
├── orchestrator/             # ★中核ハーネス（TS。speca scripts/orchestrator/ を移植）
├── prompts/                  # フェーズ別ワーカープロンプト（版管理＝D20）
├── schemas/                  # フェーズ間 JSON 契約（D2/D9）
├── templates/                # template.md（文体統一）＋ projects 雛形（D1/D20）
├── projects/                 # 戦略ごとの実装ワークスペース（D1：フォルダ並行）
├── evolution/                # 遺伝子セッション（まず単一プール→island化／D18）
├── benchmarks/               # S6 評価ランナー・eval 定義（D17）
├── knowledge/                # S2 外部知見の収集物（クロール/論文）
├── crawl-py/                 # ★Scrapling クロールの Python サイドカー（TSから subprocess）
├── dashboard/                # speca web/ を vendor。server は TS に書換中、frontend=React/Vite。D6
├── presentation/             # 発表生成（presentation-agent は後で vendor）
├── outputs/                  # run 単位の成果物（.gitignore）
├── docs/                     # 設計ドキュメント（本ファイル群）
└── tests/                    # スキーマ/オーケストレータのテスト
```

---

## orchestrator/（speca 実構成を TS 移植）

speca `scripts/orchestrator/`（Python）の実ファイルを **TS に移植**して対応づける（下記は `.py`→`.ts`）。
runtime は **claude / gemini の CLI を subprocess で駆動**（サブスク認証をそのまま利用、従量課金なし）。

（TS 移植。`speca: <name>.py` は移植元）

> **実装注（2026-06-11 Grep 確認）**: 下記ツリーは設計上の理想形。実在ファイルに **実在実装済み（runner 配線済み）／テストテストのみ（実装＋vitest 緑だが runner 未配線）／未作成未実装** を併記する。判定とテスト数の正は [implementation-status.md](./implementation-status.md)（`npx vitest run` の実測値はそちらに集約し、本ファイルからは参照のみ＝ここに数値を重複させない）。`queue.ts`/`batch.ts`/`factory.ts`/`watchdog.ts`/`costTracker.ts` は **未実装（ファイルなし）** で、当該責務は runner.ts に内包または MVP スコープ外。

```
orchestrator/
├── index.ts             # 実在: CLI エントリ（probe/run/doctor/evolve を dispatch。claude+gemini register）
├── runner.ts            # 実在: 縦串本体 S3→S5→S6＋battle 分岐（runSlice/doctor を export）。speca: runner.py
├── runtimes/
│   ├── claudeRunner.ts  # 実在: claude CLI subprocess（実 run で S3/S5 生成実績。spawn 層は未テスト）
│   ├── geminiRunner.ts  # テスト: gemini CLI subprocess（register 済/全フェーズ claude 固定＝未使用。認証未設定で error.code=41）
│   └── geminiMcp.ts     # テスト: gemini MCP 連携の知見（未配線）
├── runtimeRegistry.ts   # 実在: Claude/Gemini の2ランナー登録＋runCLISubprocess（D4/D19）。codex等は将来
├── collector.ts         # 実在: S3 戦略 dedup（純ロジック。runner 配線済み）。speca: collector.py
├── validate.ts          # 実在: 検証ラッパ（ajv 委譲）。runner 配線済み
├── battle.ts            # 実在: round-robin 純集計＋じゃんけん優劣表（battle 分岐で配線）
├── battleRunner.ts      # 実在: 戦略プロセス同士の spawn 対戦 I/O（janken-run 実績。spawn 層はテスト外）
├── s6battle.ts          # 実在: battle→BenchResult 変換＋rank（battle 分岐で配線）
├── resume.ts            # テスト: partial glob スキャンで resume（D9）。**resume.ts モジュールは runner 未配線**。ただし S3 段の resume は runner.ts の inline loadExistingS3() で別途動く（AC5 部分）
├── idempotency.ts       # テスト: 冪等キー生成（D10）。**runner 未配線**
├── idempotencyStore.ts  # テスト: 冪等マーカー集合（D10×D9）。**runner 未配線**（resume と組で「二重実行しない」未達）
├── s2.ts                # テスト: S2 外部知見クロール＋知見INDEX（D7）。**runner 未配線**（MVP 仕様通りスキップ）
├── crawl.ts             # テスト: Python サイドカー呼び出し（s2 経由のみ）。実 spawn は未検証
├── circuitBreaker.ts    # 実在: 連続失敗5/総リトライ20/連続空3 でトリップ（D11。S5 ループで配線）。stall 検出は未実装
├── events.ts            # 実在: append-only イベント書込（D9 write-only。runner 配線済み）
├── notify.ts            # 実在: best-effort 通知（欠落5。runner 配線済み）
├── backup.ts            # 実在: 成果物バックアップ（欠落6。TAIKAI_BACKUP_DIR 未設定なら no-op）
├── archiver.ts          # テスト: run アーカイブ（zstd tarball / steal E-6）。**runner 未配線**。speca: archiver.py
├── paths.ts             # 実在: outputs パス規約（D2。runner 配線済み）。speca: paths.py
├── schemas.ts           # 実在: ajv JSON Schema 検証（schemas.test 19）。speca: schemas.py
├── types.ts             # 実在: フェーズ間データ契約（TS型）
├── config.ts            # 実在: PhaseConfig / CB しきい値 / MVP_PHASES（speca: config.py）。予算追跡(costTracker)は未実装
└── runSummary.ts        # テスト: run サマリ生成（summarizeRun/foldPhases 純ロジック・観測用）。**実在だが git untracked（未コミット）**・**runner/index 未配線**（dashboard-lite/readers.ts に I/O 委譲。Grep 確認: runner.ts も index.ts も import せず）
```

> **未実装（ファイル不在）**: `queue.ts`/`batch.ts`（Work Queue/batch 分割）・`factory.ts`（ワーカー生成）・`watchdog.ts`（stuck 検知）・`costTracker.ts`（budget 追跡 D5）は **MVP スコープ外**で未着手。runner は 1 周・単一戦略のため queue/batch/factory を要さず、CB は circuitBreaker.ts に内包。

> **CLI 到達点（index.ts 実測）**: `taikai probe`（claude CLI 駆動確認）/ `taikai run`（縦串 1 周）/ `taikai doctor`（起動前バリデータ）/ `taikai evolve`（D18① じゃんけん数値進化デモ）の4コマンドが dispatch される。

---

## prompts/（フェーズ別・命名規約）

speca の `<phase><sub>_<role>.md` を Taikai-killer の S1..S6 に対応させる。

> **実装注（2026-06-11 Glob 確認）**: 下記ツリーは設計上の理想形（命名規約の目標形）。**実在は 3 ファイルのみ**で、命名も実態とドキュメントで食い違う（実 `S1_rules.md` ⇄ 設計 `S1a_rules_extract.md`）。orchestrator セクションと同様に **実在／未作成** を併記する。実ファイル名を確定命名規約に寄せるか、本ツリーを実態へ畳むかは未決（命名規約の最終確定はこのファイルの外で詰める）。

```
prompts/
├── S1_rules.md                # 実在: 大会ルール抽出（設計名 S1a_rules_extract.md ⇄ 実 S1_rules.md で命名乖離）
├── S3_strategy.md             # 実在: 戦略大量生成（設計名 S3_strategy_worker.md ⇄ 実 S3_strategy.md）
├── S5_selfimprove.md          # 実在: S5 自己改善＝Reflexion ループ（D22。旧「D21 evaluator-optimizer」を統合改名）
│   # ---- 以下 未作成（設計上の理想形・ファイル不在）----
├── S1d_edge_questions.md      # 未作成: きわどい定義→質問.json
├── S2a_search_words.md        # 未作成: 検索ワード生成
├── S2b_crawl_worker.md        # 未作成: クロール（Scrapling/playwright）
├── S2c_paper_worker.md        # 未作成: 論文（Semantic Scholar）
├── S4_requirement_refine.md   # 未作成: 要件精緻化
├── S5_codegen_worker.md       # 未作成: コード生成（自己改善・S5_selfimprove と分離する場合）
├── S6_benchmark.md            # 未作成: ベンチ評価
├── _self_improve.md           # 未作成: 自己改善（presentation-agent 10/11 準拠）
└── _template.md → templates/template.md（未作成・文体統一の単一ソース）
```

- **版管理（D20 / steal E-4）**: 各 prompt は**イミュータブル**。自己改善ループの成果は `prompts/locked/<phase>/v{n}.md`＋`manifest.json`（baseline/improved スコア・コスト・seed・dataset_hash を記録＝プロバナンス完全保全）に固定。`config.py` の `prompt_override_path`＋`--locked` で baseline⇄改善版を切替。
- **共通テンプレ（steal C-2）**: 全 prompt は `<task>`（IO契約）＋`<critical_requirements>`（譲れない条件、例「**スキップ時も出力ファイルは必ず書く**」=partial-first 成立の必須要件）構造で固定。`template.md` で全プロバイダ同一文体を強制。
- **ツール許可（steal C-3）**: フェーズ別にツール許可を絞る＝「集中力ガード」（権限でなく推論品質のため。S3 に Bash を渡さない等）。

---

## schemas/（フェーズ間 JSON 契約 — speca 3層＋メタ）

speca の `Phase*Partial` / `*Event` / `RunManifest` / `PartialMetadata` を型ドメインだけ差し替える設計だが、**実在は下記 10 ファイルのみ**（実数の正は [implementation-status.md](./implementation-status.md) D2 行）。orchestrator/prompts セクションと同様に **実在／未作成** を分離する。

> **実装注（2026-06-11 Glob 確認）**: schemas/ には `schemas.ts`(ajv selfcheck 緑) が検証する 10 個の `*.schema.json` が実在。`RunManifest`/`PartialMetadata`/各 `*Event`/各 `S{n}Partial`/`Question`/`Definition`/`Subject`/`SearchWord`/`CrawledUrl`/`Requirement` は **未作成（設計上の理想形）**。

```
schemas/
│   # ---- 実在 10 ファイル（schemas.ts が selfcheck）----
├── BenchResult.schema.json          # 実在: result.json
├── CodeAttempt.schema.json          # 実在: S5 単一試行（D22 Reflexion の1 attempt）
├── CodegenResult.schema.json        # 実在: S5 生成結果（feedbackHistory 含む）
├── LeaderboardEntry.schema.json     # 実在: leaderboard.json の1行
├── PhaseArtifact.schema.json        # 実在: 共通エンベロープ（architecture.md）
├── ProjectManifest.schema.json      # 実在: projects/{id}/manifest.json（language/run_cmd/test_cmd）
├── Provenance.schema.json           # 実在: derived_from プロバナンス
├── ScoringRubric.schema.json        # 実在: SCORING_RUBRIC.json
├── Strategy.schema.json             # 実在: 戦略_*.json
├── TournamentInfo.schema.json       # 実在: TOURNAMENT_INFO.json
│   # ---- 未作成（設計上の理想形・ファイル不在）----
├── RunManifest.schema.json          # 未作成: ★再現性 model完全ID/seed/temp/commit/prompt_hash（D17）
├── PartialMetadata.schema.json      # 未作成: worker/batch/timestamp/idempotency_key
├── Question / Definition / Subject / SearchWord / CrawledUrl / Requirement  # 未作成: payload データ型
├── S1Partial … S6Partial.schema.json                                        # 未作成: フェーズ partial（speca: Phase0XPartial）
└── *Event.schema.json (PipelineStarted/PhaseStarted/PhaseCompleted/PhaseFailed/CircuitBreakerTripped/BudgetExceeded/PipelineCompleted)  # 未作成: append-only イベント（D9）
```

---

## outputs/（run 単位 — speca のディレクトリ規約を踏襲）

speca の実物 `outputs/2026-05-13T14-36-26Z-8802b47-openlist/` 形式をそのまま採用。

> **実装注（2026-06-11）**: 「確定」なのは **ディレクトリ命名規約（partial / run dir / 状態3系統の配置）**まで。実 run が現に書く成果物（`result.json`/`partials/`/`events/`/`leaderboard.json`）は 実在だが、**`.taikai/runs/{id}/state.json`・`~/.taikai/runtime.json` の可変状態は runner 未配線**（[implementation-status.md](./implementation-status.md) AC5: `resume.ts`/`idempotencyStore.ts` モジュールは実装＋テスト緑だが `runner.ts` が import せず）。**ただし S3 段の resume は runner.ts の inline `loadExistingS3()` が `partials/` の S3 partial を消費して動く**＝「殺して再実行」しても S3 戦略は再生成されない（S5 attempt 単位の resume と idempotency 二重実行ガードだけが未配線）。下記ツリーに 実在/未作成: を併記する。

```
outputs/                              # .gitignore（*.png/*.md だけ allowlist）
└── {ISO8601}-{commit}-{tournament}/  # 1 run = S1 once → (S2..S6)*∞
    ├── TOURNAMENT_INFO.json   # 実在: ★最小入力: 大会の識別（名前/URL/締切/言語/制約）E-1
    ├── SCORING_RUBRIC.json    # 実在: ★最小入力: 評価軸/配点/禁止事項（ルブリック外部化）E-1
    ├── events/        # 実在: append-only イベントログ（D9。events.ts 配線済み）
    ├── partials/      # 実在: S{n}_PARTIAL_W{w}B{b}_{ts}.json（D2。実 run で S3/S5 partial 実在）
    ├── logs/          # 実在: ワーカー別 trajectory（agent_id 付き / D15）
    ├── graphs/        # 未作成: 戦略系統・進化系統図（進化ループ未配線のため未生成）
    ├── submitted/     # 未作成: 大会提出物（submit はレビューゲート止まり）
    ├── run_manifest.json   # 未作成: 不変メタ＝再現性マニフェスト（D17。RunManifest schema 自体も未作成）
    └── result.json    # 実在: S6 レポート（実 run 実績あり）
outputs/leaderboard.json   # 実在: ★run 横断の最強選抜（同一 rubric_ref で比較／欠落8。実 run で追記実績）
$TAIKAI_BACKUP_DIR/        # 実在: ★result確定ごとに複製（欠落6。backup.ts 配線済み。未設定なら no-op。USB宛てはC:ステージ→robocopy /MT）

.taikai/                   # runner未配線: ★可変状態（成果物と分離 / steal E-2）— .gitignore
└── runs/{id}/
    └── state.json         # 未作成未配線: status / owner_pid / cancel_requested / budget（orphan検出用。resume.ts/idempotencyStore.ts と同じく runner が未 import。なお S3 resume は inline loadExistingS3() で別経路で動く＝AC5 部分）
~/.taikai/runtime.json     # 未作成未配線: ユーザ永続選好（秘密は入れない＝環境変数のみ）
```

- **命名規約（確定）**: partial = `S{n}_PARTIAL_W{worker}B{batch}_{ISO8601}.json`、run dir = `{ISO8601}-{git短縮hash}-{大会slug}`。
- **状態3系統分離（E-2）**: `outputs/{run}/`（成果物・不変）／`.taikai/runs/{id}/state.json`（supervisor可変状態・`owner_pid` で orphan 検出）／`~/.taikai/runtime.json`（永続選好）。**APIキーは設定に保存せず環境変数から読む**。
- **Release 保全（E-6）**: 大容量生データ（evolution/islands・trajectory）は Git でなく GitHub Release に zstd tarball、repo は系統図/result.md だけ allowlist。タグ `taikai-{tournament}-{date}-{strategy_id}`、sidecar manifest（sha256）で復元検証。

---

## projects/ と evolution/（D1 / D18 の具体化）

```
projects/                       # 戦略ごとに独立フォルダ（branch でなくフォルダ＝D1）
├── _skeleton/                  # 対象言語のテンプレ（entrypoint/テスト配線。MVPは1言語ぶん／欠落1）
└── {strategy_id}/              # 戦略1つ＝1ワークスペース（worktree 任意）。書込はこの中だけ（R4最小ガード）
    ├── strategy.json           # Strategy.schema.json 準拠
    ├── manifest.json           # language/run_cmd/test_cmd/timeout_ms（実行環境／欠落1）
    ├── src/                    # 生成コード
    ├── tests/                  # テスト（provided/generate/heldout）。S5開始時にsha256凍結（欠落2）
    └── bench/                  # この戦略のベンチ結果

evolution/                      # 遺伝子セッション（D18）★初期スコープ外（run数が増えてから）
│   # 実装注（2026-06-11 Glob 確認）: 実在=テスト緑の純ロジック / 未作成。本番進化ループは runner 未配線（評価器D3確定まで意図的に起動しない＝設計通り）。
├── numericOptimizer.ts         # テスト実在: ★①数値最適化＝LLM不要（ヒルクライム/seed固定）。テスト緑・runner未配線
├── jankenStrategy.ts           # テスト実在: じゃんけん数値パラメータ戦略
├── jankenEvolve.ts             # テスト実在: 数値戦略を勝率で進化（D18①実証）。テスト緑・本番未配線
├── evolveDemo.ts               # テスト実在: D18① end-to-end デモ薄ラッパ
├── pool.json                   # 未作成: まず単一プール（戦略JSONの配列）で開始する設計
└── config.ts                   # 未作成: 進化ハイパラ（island化は後追い。island/移住周期は将来）
```

> **D18 注（2トラック分離）**:
> - **① 数値最適化トラック（LLM不要）**: 閾値・パラメータ・重み（例: じゃんけんAIの出す確率）は **`numericOptimizer.ts` が普通のコードで回す**（GA/ヒルクライム/CMA-ES 等）。**S6 評価関数を呼んでスコア→数値を変異→繰り返す**だけで、LLM は一切呼ばない。決定的（seed固定可→再現性◎）・無料・高速で、LLM進化なら数十回のところを数万回回せる。数値変更は **AI 以外の要因（最適化アルゴリズム）で起こる**。
> - **② 構造変異トラック（LLM）**: approach・アルゴリズム自体の質的飛躍は **S5 が LLM で生成**（FunSearch/AlphaEvolve 型）。
> - 前提: ①は「**評価関数が LLM 抜きで速く呼べる**」こと（生成済みプログラムを実行してスコアを返すだけ）。
> - 初期は **単一プール（`pool.json`）のみ**。island/program_db/移住は run 数が3桁規模になってから（**評価器 D3 が固まるのが前提＝評価器確定まで進化は起動しない**）。

- **worktree 運用（D13）**: `projects/{strategy_id}/` を git worktree に割り当てる場合、共有 `.git` への commit は orchestrator のミューテックスで直列化、`index.lock` は retry-backoff。**初回 run では不要（∞並行が走ってから）**。

---

## speca → Taikai-killer 対応表

| speca | Taikai-killer | 役割 |
|---|---|---|
| `scripts/orchestrator/` | `orchestrator/` | ハーネス中核（ほぼ流用） |
| `prompts/01a_crawl.md` | `prompts/S2b_crawl_worker.md` | フェーズ別ワーカー |
| `schemas/Phase03Partial` | `schemas/S3Partial` | フェーズ間契約 |
| `schemas/*Event` | `schemas/*Event` | append-only イベント（そのまま） |
| `schemas/RunManifest` | `schemas/RunManifest` | 再現性（そのまま） |
| `outputs/{ts}-{commit}-{target}/` | `outputs/{ts}-{commit}-{tournament}/` | run 隔離（そのまま） |
| `benchmarks/` | `benchmarks/` | eval（そのまま） |
| `cli/` `website/` | `dashboard/` | UI |
| (presentation-agent) | `presentation/` | 発表生成 vendor |

---

## これで確定すること
- **D1 → フォルダ構造で確定**（branch は使わず `projects/{strategy_id}/`、必要時のみ worktree）
- **D2 → `schemas/` の3+1層で確定**（speca と同型）
- 命名規約（partial / run dir / prompt 版）を固定

## 残（このファイルの外で詰める）
- 各 `*.schema.json` の中身（D2 実装）
- `orchestrator/config.py` のハイパラ初期値（D18：island数・閾値・予算）
- speca orchestrator の fork/vendor 方法（コピー vs サブモジュール）

---
*構成は nyx [speca](https://github.com/NyxFoundation/speca) / [presentation-agent](https://github.com/NyxFoundation/presentation-agent) の実取得構造に基づく。関連: docs/architecture.md, docs/decisions.md, Issue #1/#2*
