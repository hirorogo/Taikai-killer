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

スタック: **Python + uv**（speca と同じ `pyproject.toml`/`uv.lock`）をコアに、CLI/Dashboard は Node、発表は Slidev（presentation-agent を vendor）。

---

## トップレベル構成（確定）

```
Taikai-killer/
├── README.md
├── CLAUDE.md                 # エージェント共通指示（speca 準拠）
├── pyproject.toml / uv.lock  # Python コア依存
├── Makefile                  # フェーズ実行のエントリ（presentation-agent 準拠）
├── .github/                  # CI（schema 検証・lint）
│
├── orchestrator/             # ★中核ハーネス（speca scripts/orchestrator/ を流用）
├── prompts/                  # フェーズ別ワーカープロンプト（版管理＝D20）
├── schemas/                  # フェーズ間 JSON 契約（D2/D9）
├── templates/                # template.md（文体統一）＋ projects 雛形（D1/D20）
├── projects/                 # 戦略ごとの実装ワークスペース（D1：フォルダ並行）
├── evolution/               # 遺伝子セッション＝island model（D18）
├── benchmarks/               # S6 評価ランナー・eval 定義（D17）
├── knowledge/                # S2 外部知見の収集物（クロール/論文）
├── dashboard/                # Next.js + Slack/Discord bot（ヒューマンレビュー＝D6）
├── presentation/             # 発表生成（presentation-agent を vendor）
├── outputs/                  # run 単位の成果物（.gitignore）
├── docs/                     # 設計ドキュメント（本ファイル群）
└── tests/                    # スキーマ/オーケストレータのテスト
```

---

## orchestrator/（speca 実構成を流用）

speca `scripts/orchestrator/` の実ファイルを Taikai-killer 用に対応づける。

```
orchestrator/
├── __init__.py
├── runner.py            # フェーズ実行の中核（speca: runner.py）
├── api_runner.py        # LLM API 経由ワーカー（speca: api_runner.py）
├── runtime_registry.py  # ★マルチモデル統一層 claude/gemini/codex/ollama/copilot（D19）
├── copilot_runner.py    # モデル別ランナーの例（speca に実在）
├── queue.py             # Work Queue / batch 分割（speca: queue.py, batch.py）
├── batch.py
├── collector.py         # 並列ワーカー出力の統廃合・dedup（speca: collector.py）
├── factory.py           # フェーズ→ワーカー生成（speca: factory.py）
├── resume.py            # 再開（D9：イベント replay）
├── watchdog.py          # 停滞/暴走検知（D11：stuck 5パターン＋除外窓）
├── circuit_breaker.py   # 失敗率/連続失敗/無進捗でトリップ（D11）
├── cost_tracker.py      # USD 予算・tag budget・90%早期停止（D10/コスト）
├── idempotency.py       # ★hash(prompt+model+params+phase) キャッシュ（D10）
├── event_models.py      # イベント型（speca: event_models.py）
├── json_events.py       # append-only イベント書込（speca: json_events.py / D9）
├── archiver.py          # run のアーカイブ（speca: archiver.py）
├── paths.py             # outputs パス規約（speca: paths.py）
├── schemas.py           # スキーマロード/検証（speca: schemas.py）
└── config.py            # ハイパラ（island数・閾値・予算）（speca: config.py）
```

---

## prompts/（フェーズ別・命名規約）

speca の `<phase><sub>_<role>.md` を Taikai-killer の S1..S6 に対応させる。

```
prompts/
├── S1a_rules_extract.md       # 大会ルール抽出
├── S1d_edge_questions.md      # きわどい定義→質問.json
├── S2a_search_words.md        # 検索ワード生成
├── S2b_crawl_worker.md        # クロール（Scrapling/playwright）
├── S2c_paper_worker.md        # 論文（Semantic Scholar）
├── S3_strategy_worker.md      # 戦略大量生成
├── S4_requirement_refine.md   # 要件精緻化
├── S5_codegen_worker.md       # コード生成（自己改善）
├── S5_eval_optimizer.md       # evaluator-optimizer ループ（D21）
├── S6_benchmark.md            # ベンチ評価
├── _self_improve.md           # 自己改善（presentation-agent 10/11 準拠）
└── _template.md → templates/template.md（文体統一の単一ソース）
```

- **版管理（D20 / steal E-4）**: 各 prompt は**イミュータブル**。自己改善ループの成果は `prompts/locked/<phase>/v{n}.md`＋`manifest.json`（baseline/improved スコア・コスト・seed・dataset_hash を記録＝プロバナンス完全保全）に固定。`config.py` の `prompt_override_path`＋`--locked` で baseline⇄改善版を切替。
- **共通テンプレ（steal C-2）**: 全 prompt は `<task>`（IO契約）＋`<critical_requirements>`（譲れない条件、例「**スキップ時も出力ファイルは必ず書く**」=partial-first 成立の必須要件）構造で固定。`template.md` で全プロバイダ同一文体を強制。
- **ツール許可（steal C-3）**: フェーズ別にツール許可を絞る＝「集中力ガード」（権限でなく推論品質のため。S3 に Bash を渡さない等）。

---

## schemas/（フェーズ間 JSON 契約 — speca 3層＋メタ）

speca の `Phase*Partial` / `*Event` / `RunManifest` / `PartialMetadata` をそのまま型ドメインだけ差し替える。

```
schemas/
├── PhaseArtifact.schema.json        # 共通エンベロープ（architecture.md）
├── PartialMetadata.schema.json      # worker/batch/timestamp/idempotency_key
├── RunManifest.schema.json          # ★再現性: model完全ID/seed/temp/commit/prompt_hash（D17）
│   # ---- データ型（payload）----
├── Question.schema.json             # 質問.json
├── Definition.schema.json           # 定義.json
├── Subject.schema.json              # 題材.json
├── SearchWord.schema.json           # 検索ワード.json
├── CrawledUrl.schema.json           # urlクロール.json
├── Strategy.schema.json             # 戦略_*.json
├── Requirement.schema.json          # 要件定義_*.json
├── BenchResult.schema.json          # result.json
│   # ---- フェーズ partial（speca: Phase0XPartial）----
├── S1Partial.schema.json
├── S2Partial.schema.json
├── S3Partial.schema.json … S6Partial.schema.json
│   # ---- イベント（append-only / D9）----
├── PipelineStartedEvent.schema.json
├── PhaseStartedEvent.schema.json
├── PhaseCompletedEvent.schema.json
├── PhaseFailedEvent.schema.json
├── CircuitBreakerTrippedEvent.schema.json   # speca に実在
├── BudgetExceededEvent.schema.json          # speca に実在
└── PipelineCompletedEvent.schema.json
```

---

## outputs/（run 単位 — speca のディレクトリ規約を踏襲）

speca の実物 `outputs/2026-05-13T14-36-26Z-8802b47-openlist/` 形式をそのまま採用。

```
outputs/                              # .gitignore（*.png/*.md だけ allowlist）
└── {ISO8601}-{commit}-{tournament}/  # 1 run = S1 once → (S2..S6)*∞
    ├── TOURNAMENT_INFO.json   # ★最小入力: 大会の識別（名前/URL/締切/言語/制約）E-1
    ├── SCORING_RUBRIC.json    # ★最小入力: 評価軸/配点/禁止事項（ルブリック外部化）E-1
    ├── events/        # append-only イベントログ（D9）
    ├── partials/      # S{n}_PARTIAL_W{w}B{b}_{ts}.json（D2）
    ├── logs/          # ワーカー別 trajectory（agent_id 付き / D15）
    ├── graphs/        # 戦略系統・進化系統図
    ├── submitted/     # 大会提出物（speca: submitted/）
    ├── run_manifest.json   # 不変メタ＝再現性マニフェスト（D17）
    └── result.json    # S6 レポート

.taikai/                   # ★可変状態（成果物と分離 / steal E-2）— .gitignore
└── runs/{id}/
    └── state.json         # status / owner_pid / cancel_requested / budget（orphan検出用）
~/.taikai/runtime.json     # ユーザ永続選好（秘密は入れない＝環境変数のみ）
```

- **命名規約（確定）**: partial = `S{n}_PARTIAL_W{worker}B{batch}_{ISO8601}.json`、run dir = `{ISO8601}-{git短縮hash}-{大会slug}`。
- **状態3系統分離（E-2）**: `outputs/{run}/`（成果物・不変）／`.taikai/runs/{id}/state.json`（supervisor可変状態・`owner_pid` で orphan 検出）／`~/.taikai/runtime.json`（永続選好）。**APIキーは設定に保存せず環境変数から読む**。
- **Release 保全（E-6）**: 大容量生データ（evolution/islands・trajectory）は Git でなく GitHub Release に zstd tarball、repo は系統図/result.md だけ allowlist。タグ `taikai-{tournament}-{date}-{strategy_id}`、sidecar manifest（sha256）で復元検証。

---

## projects/ と evolution/（D1 / D18 の具体化）

```
projects/                       # 戦略ごとに独立フォルダ（branch でなくフォルダ＝D1）
├── _skeleton/                  # 使い回す雛形（templates/ から生成）
└── {strategy_id}/              # 戦略1つ＝1ワークスペース（worktree 任意）
    ├── strategy.json           # Strategy.schema.json 準拠
    ├── src/                    # 生成コード
    └── bench/                  # この戦略のベンチ結果

evolution/                      # 遺伝子セッション（FunSearch/AlphaEvolve 準拠 / D18）
├── islands/{0..N}/             # island model（初期 island=5〜10）
├── program_db/                 # signature クラスタ・系統（短い解優遇）
└── config.py                   # 移住周期・探索率・カスケード閾値
```

- **worktree 運用（D13）**: `projects/{strategy_id}/` を git worktree に割り当てる場合、共有 `.git` への commit は orchestrator のミューテックスで直列化、`index.lock` は retry-backoff。

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
