# 実装状況の棚卸し（正直版）

リポジトリを実際に Read/Grep して、コードがどこまで「動く」かを誇張せずに記録する。
判定語は4段階で厳密に区別する:

- **動く** = runner（縦串本体）に配線され、実 run で `result.json` / 成果物を生成した実績がある
- **テストのみ** = vitest 純ロジックテストは緑だが、実パイプライン（runner / spawn / LLM）には未配線、または実プロセスでの動作未実証
- **未配線** = 実装はあるが `orchestrator/runner.ts` から呼ばれていない（import されていない）
- **未検証** = LLM 発火・外部認証・実プロセスなど、ユニットテストでは確かめられない部分が未実証

検証時点: 2026-06-13。`npx vitest run` = **37 ファイル / 590 テスト 全 pass**（実測。テスト数・ファイル数の正はここに集約し、他ドキュメントは本書を参照する）。
設計の正は [`docs/`](./README.md)。本書は設計（D番号）に対する**実装の現在地**だけを述べる。

> 2026-06-13 更新差分: 標準化クエストフレームワーク（`orchestrator/quest/`）と自己対戦コオエボリューション（`coevolve.ts`・Hall of Fame 込み）を追加し、テストは 349→590 に増えた。§1.6 に新規モジュール表、§7（quests.md §7.5）に実測を記す。MVP 縦串（§2-4）の状態は据え置き。

---

## 0. 一目でわかる結論

- **縦串MVP（Issue #3）は実通している。** test型（fizzbuzz）と対戦型（janken）の両方が `taikai run` で `result.json` を出した実績が `outputs/` に残る。
- **Issue #3 の AC は 6/6 全達成（2026-06-13・§4）**。resume（S3＋S5 attempt）・テスト改ざん検知・D22 reflexion・result provenance まで実 run で実証済み。
- ただし **runner に配線されているのは S3→S5→S6 の最小経路だけ**。S2 / archiver / 進化 / Gemini / dashboard は「実装＋テスト緑」だが **runner からは呼ばれていない（未配線）**（`resume.ts`/`idempotencyStore.ts` は 2026-06-13 に S5 へ配線済＝もう未配線ではない）。
- **LLM 発火に依存する箇所（S3 戦略生成・S5 生成・S5 reflector）は実 run で実証済み**（reflector は `toy-impossible` で multi-attempt 発火を確認・§3-1）。ただし**ユニットテストでは検証不能**なので「動く（実 run 実績あり）」と「未検証（自動テスト外）」を引き続き分けて明記する。
- Gemini は `index.ts` に **register 済み**。**2026-06-13 に Windows spawn バグを修正**（`shell:true` が空引数 `-p ""` を落とし「Not enough arguments」で**実は全く発火していなかった**→ `cmd.exe /c` 方式に変更し認証段（error.code=41）まで到達を確認）。`taikai probe-gemini` で検証可能。残るは**ユーザが認証（`GOOGLE_GENAI_USE_GCA` 等）を設定**すれば実生成が動く状態（どのフェーズも既定 `model:"claude"` なのは据え置き）。
- **標準化クエストフレームワーク（`orchestrator/quest/`・§1.6）は別経路で動く。** `taikai quest`/`taikai coevolve` は runner（縦串 MVP）とは独立に CLI 配線済で、LLM 非依存の数値最適化（GA/ヒルクライム）＋自己対戦コオエボリューション（Hall of Fame 込み）を実 spawn で回し、`best_params.json`/`champion_params.json` を生成した実績がある（実測は quests.md §7.5）。MVP 縦串の「S2/進化/Gemini 未配線」とは別レイヤなので混同しない。

---

## 1. 実装済みモジュール表

「runner配線」列: 済=runner.ts が import して実行する / 未=未配線（テスト or 他モジュールからのみ参照）。

### 1.1 オーケストレータ共有層（読むだけ＝担当外、現状把握用）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/index.ts` | CLI エントリ（probe/probe-gemini/run/doctor/quest/coevolve/loop…）。claude+gemini を register | なし | — | 動く（probe/probe-gemini/run/doctor/quest/coevolve 実行可） |
| `orchestrator/runner.ts` | 縦串本体 S3→S5→S6＋battle 分岐 | なし（実 run で実証） | 本体 | 動く |
| `orchestrator/config.ts` | PhaseConfig / CB しきい値 / MVP_PHASES | なし | 済 | 動く |
| `orchestrator/types.ts` | フェーズ間データ契約（TS型） | （schemas で間接） | 済 | 動く |
| `orchestrator/paths.ts` | outputs パス規約（D2） | （resume 等で間接） | 済 | 動く |
| `orchestrator/runtimeRegistry.ts` | CLI runtime 統一層（D4） | なし | 済 | 動く |
| `orchestrator/schemas.ts` | ajv JSON Schema 検証 | `schemas.test.ts`(19) | 済(validate 経由) | 動く |

### 1.2 runner に配線済み（=動く）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/runtimes/claudeRunner.ts` | claude CLI subprocess driver | `geminiRunner.test.ts` は gemini側。claude純ロジックは未テスト | 済 | 動く（実 run で S3/S5 生成実績）。spawn部は未テスト |
| `orchestrator/notify.ts` | best-effort 通知（欠落5） | `notify.test.ts`(8) | 済 | 動く |
| `orchestrator/events.ts` | append-only イベントログ（D9 write-only） | `events.test.ts`(9) | 済 | 動く |
| `orchestrator/circuitBreaker.ts` | CB 暴走停止（D11） | `circuitBreaker.test.ts`(9) | 済 | 動く |
| `orchestrator/collector.ts` | S3 戦略 dedup（純ロジック） | `collector.test.ts`(18) | 済 | 動く |
| `orchestrator/validate.ts` | 検証ラッパ（ajv 委譲） | `validate.test.ts`(14) | 済 | 動く |
| `orchestrator/backup.ts` | 成果物バックアップ（欠落6） | `backup.test.ts`(13) | 済 | 動く（`TAIKAI_BACKUP_DIR` 未設定なら no-op） |
| `orchestrator/battle.ts` | round-robin 純集計＋じゃんけん優劣表 | `battle.test.ts`(18) | 済(battle分岐) | 動く |
| `orchestrator/battleRunner.ts` | 戦略プロセス同士の spawn 対戦 I/O | `battleRunner.test.ts`(18 純ロジックのみ) | 済(battle分岐) | 動く（janken-run 実績）。spawn部はテスト外 |
| `orchestrator/s6battle.ts` | battle→BenchResult 変換＋rank | `s6battle.test.ts`(12) | 済(battle分岐) | 動く |

### 1.3 実装＋テスト緑だが runner 未配線

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/s2.ts` | S2 外部知見クロール＋知見INDEX（D7） | `s2.test.ts`(41) | 未 | テストのみ・未配線（runner は S2 を呼ばない＝MVP仕様通りスキップ） |
| `orchestrator/crawl.ts` | クロール（Python サイドカー呼び出し） | `crawl.test.ts`(15) | 未(s2経由のみ) | テストのみ・未配線。サイドカー実 spawn は未検証 |
| `orchestrator/resume.ts` | partial glob スキャンで resume（D9） | `resume.test.ts`(9) | 未 | テストのみ・**resume.ts モジュール自体は runner未配線**。ただし S3 段の resume は runner.ts の inline `loadExistingS3()`（L428-442）で別途実装され**動く**（§2.1 / AC5 参照） |
| `orchestrator/idempotency.ts` | 冪等キー生成（D10） | `idempotency.test.ts`(11) | 未 | テストのみ・未配線 |
| `orchestrator/idempotencyStore.ts` | 冪等マーカー集合（D10×D9） | `idempotencyStore.test.ts`(13) | 未 | テストのみ・未配線（resume と組で AC「二重実行しない」未達） |
| `orchestrator/archiver.ts` | run アーカイブ（zstd tarball / steal E-6） | `archiver.test.ts`(9) | 未 | テストのみ・未配線 |
| `orchestrator/runtimes/geminiRunner.ts` | gemini CLI driver（D4 2モデル目） | `geminiRunner.test.ts`(14 純ロジック) | register済・`probe-gemini` 配線 | **Windows spawn 修正済（2026-06-13）**: `cmd.exe /c gemini …args` で空引数を保ち**認証段（code=41）まで到達を実機確認**。`parseGeminiError` で error.code を診断に surface。実生成はユーザ認証設定後に動く（auth 未設定のため最終応答のみ未検証） |
| `orchestrator/runtimes/geminiMcp.ts` | gemini MCP 連携の知見 | `geminiMcp.test.ts`(11) | 未 | テストのみ・未配線 |

### 1.4 進化トラック（D18①）— 実証デモ・本番未配線

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `evolution/numericOptimizer.ts` | ヒルクライム最適化（決定的・seed固定） | `numericOptimizer.test.ts`(12) | 未 | テストのみ。LLM非依存・純ロジック |
| `evolution/jankenStrategy.ts` | じゃんけん数値パラメータ戦略 | （jankenEvolution 経由） | 未 | テストのみ |
| `evolution/jankenEvolve.ts` | 数値戦略を勝率で進化（D18①実証） | `jankenEvolution.test.ts`(16) | 未 | テストのみ・**本番進化ループ未配線**（評価器D3確定まで起動しない＝設計通り） |
| `evolution/evolveDemo.ts` | D18① end-to-end デモ薄ラッパ | `evolveDemo.test.ts`(9) | 未 | テストのみ・未配線（commit 6371b03 で tracked。9テスト緑） |

### 1.6 標準化クエストフレームワーク（横断ハーネス・`index.ts` 配線済）

D8（SBQ 全分野を狙う標準化フレーム）の実体。`taikai quest`/`taikai coevolve` で実走する。runner（縦串 MVP）とは独立した CLI 経路で、**LLM を呼ばない数値最適化トラック**（D18①）。各 adapter は Python サイドカーを spawn して評価する（決定的・seed 固定）。

| ファイル | 役割 | テスト | CLI 配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/quest/adapter.ts` | `QuestAdapter<Candidate>`／`NumericCandidate` 契約 | （各 adapter で間接） | — | 動く（型契約） |
| `orchestrator/quest/runQuest.ts` | 汎用実行ループ（initialize→evaluate→optimize→submit）。`--ga N` で populationGA、既定はヒルクライム | `quest.test.ts`(9) | `taikai quest` | 動く（実 spawn で best_params.json 生成） |
| `orchestrator/quest/populationGA.ts` | 個体群 GA（交叉＋突然変異＋エリート保存・決定的） | `populationGA.test.ts`(11) | quest 経由 | 動く |
| `orchestrator/quest/parallelEval.ts` | 並行プール `mapConcurrent`/`mapConcurrentSettled`（順序保持・決定的） | `parallelEval.test.ts`(14) | coevolve 経由 | 動く |
| `orchestrator/quest/coevolve.ts` | 自己対戦コオエボリューション＋**Hall of Fame（対戦相手アーカイブ）**。昇格判定は殿堂平均勝率 | `coevolve.test.ts`(46) | `taikai coevolve [--archiveSize N]` | 動く（実 spawn・champion_params.json 生成・実測 quests.md §7.5） |
| `orchestrator/quest/xqAdapter.ts` | X Quest=7並べ adapter（`evaluate.py` spawn） | `xqAdapter.test.ts`(26) | `taikai quest --quest xq` | 動く |
| `orchestrator/quest/aiHyperoptAdapter.ts` | AI Quest=ハイパラ最適 adapter | `aiHyperoptAdapter.test.ts`(26) | `--quest ai` | 動く |
| `orchestrator/quest/roboControlAdapter.ts` | Robo Quest=制御 adapter | `roboControlAdapter.test.ts`(26) | `--quest robo` | 動く |
| `orchestrator/quest/dataInsightAdapter.ts` | Data Quest=特徴選択 adapter | `dataInsightAdapter.test.ts`(27) | `--quest data` | 動く |

実コード（Python サイドカー・X Quest）: `quests/xq-7narabe/{engine.py,ai_param.py,ai_medium.py,evaluate.py,evaluate_coevo.py,measure.py}`。spawn I/O 自体は vitest 範囲外だが、`taikai coevolve` の実走で多数の評価プロセスが完走し champion を生成した実績がある（§7.5）。**未到達**: `ai_mc.py`（PIMC）は勝ち越し未確立で未配線（quests.md §4.2）。

### 1.5 dashboard-lite（read-only ビューア）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `dashboard-lite/server.ts` | outputs/leaderboard を read-only 提供 | `dashboardLite.test.ts`(13) / `dashboardFull.test.ts`(17) / `dashboardSSE.test.ts`(8) | 未(独立プロセス) | テストのみ。runner とは別プロセス、実起動は未検証 |
| `dashboard-lite/readers.ts` | outputs read-only リーダ | 同上 | — | テストのみ |
| `orchestrator/runSummary.ts` | run サマリ生成（`summarizeRun`/`foldPhases` 純ロジック・観測用。readers.ts に I/O 委譲） | `runSummary.test.ts`（**git untracked**） | 未(runner/index 未import) | テストのみ・未配線・**実在だが git untracked（未コミット）**（runner も index も import せず、観測用に独立） |
| `dashboard/` (frontend) | speca から vendor した React UI | — | — | vendor 物・本プロジェクト未統合 |

---

## 2. 実動する縦串（vertical slice）の状態

`outputs/` に残る実 run の成果物で「実際に通った」ことを確認した。

### 2.1 test型（fizzbuzz）— 実通

- `outputs/dev-run/result.json`: `eval_mode:"test"`, `strategy_id:"S3-001"`, `passed_test_ratio:1`, `rank:1`
- `outputs/fbp-run/result.json`: `toy-fizzbuzz-plus`, `passed_test_ratio:1`
- 経路: doctor → S3（Claude LLM で戦略生成）→ dedup → S5（D22 Reflexion ループ・テスト sha256 凍結）→ S6（テスト再ハッシュ検証＋pytest採点）→ result.json → leaderboard 追記 → 通知。
- partial 実物あり: `outputs/dev-run/partials/S3_PARTIAL_*.json`（3件）, `S5_PARTIAL_W0B1_*.json`(status:ok, provenance.derived_from=["S3-001"])。
- **resume（S3 段）**: 再実行時 runner は `loadExistingS3()` で上記 `S3_PARTIAL_*.json` を読み、`status!=="error"` の戦略を再利用して **S3 の LLM 再生成をスキップ**（runner.ts L225-228・L428-442）。`outputs/dev-run/partials/` に S3 partial が現存するため、この run を再実行すれば S3 は再生成されない＝AC5 の S3 部分は実コードで動く。
- **動く（実 run 実績）**。ただし S3/S5/S5-reflector の LLM 発火は自動テスト範囲外（=「動いた形跡はあるが再現性は手続き的・未検証」）。

### 2.2 対戦型（janken）— 実通

- `outputs/janken-run/result.json`: `eval_mode:"battle"`, winner `beat-last`, `win_rate:0.475`, `battle.record{wins:19,losses:0,draws:21}`, opponents `[always-rock, cycle]`。
- 経路: rubric.eval_mode=="battle" 分岐 → `players/{id}/` を読み（3体）→ runBattleEval（spawn で総当たり 20 ラウンド）→ toBenchResults（rank 付与）→ result.json＋leaderboard（3体分）。
- プレイヤーは実 Python（`examples/toy-janken/players/{always-rock,beat-last,cycle}/player.py`）。
- **動く（実 run 実績）**。spawn 対戦 I/O はユニットテスト外だが、実 run で 40 マッチ完走している。

### 2.3 test型（toy-hard / ローマ数字）— 実通

- `outputs/hard-run/result.json`: `eval_mode:"test"`, `strategy_id:"S3-roman-tablemap"`, `rubric_ref:"toy-hard-roman-rules"`, `passed_test_ratio:1`, `rank:1`。
- 入力は `examples/toy-hard/`（commit 6371b03 で tracked: TOURNAMENT_INFO/SCORING_RUBRIC/spec.md/tests/test_roman.py）。S3 hardening（JSON 厳格リトライ）と S3 resume を検証した難問 run。
- **動く（実 run 実績）**。LLM 発火は §2.1 同様に自動テスト範囲外。

### 2.4 縦串に「入っていない」もの（MVP仕様通り）

mvp-vertical-slice.md の原則「無限ループ・S2大量クロール・S4独立・並列・進化・island・2モデル目は入れない」に沿って、runner は **1周だけ・S2/S4スキップ・単一戦略のみ S5 実装**。これは欠陥ではなく**スコープ通り**。MVP の DoD に含まれていた resume（AC5）は 2026-06-13 に S3＋S5 attempt 段とも充足済み（§4）。

---

## 3. スタブ・未配線・未検証の明示リスト

レビューが疑う「動くと言いつつ動かない」を先回りで列挙する。

1. **S5 reflector の LLM 発火（D22 既定=LLM）**: `runner.ts:reflect()` は実装済み。**実発火を実 run で確認済み（2026-06-13）**: `examples/toy-impossible` で attempt 1→2→3 の各失敗後に reflector が発火し、`[S5] reflect:` の改善指示が出た（reflector は仕様の充足不能性まで正しく診断）。`TAIKAI_REFLECTOR=template` で LLM 省略可。ユニットテストは無い（LLM 依存のため実 run 証跡で代替）。
2. **geminiRunner: 認証設定後に実生成**（Windows spawn バグは 2026-06-13 修正済）: `cmd.exe /c gemini …args` 方式で**引数解釈は正しくなり認証段（error.code=41）まで到達を実機確認**。全フェーズ既定 `model:"claude"` は据え置き。`GEMINI_API_KEY`/`GOOGLE_GENAI_USE_GCA` 未設定だと code=41（`taikai probe-gemini` が明示）。`checkAvailable` は `--version` のみで認証を見ない。**最終 LLM 応答だけはユーザ認証が要るため未検証**（プラミングは検証済）。
3. **S2 が runner 未配線**（resume/idempotency は **解消（2026-06-13）**）: `s2.ts`/`crawl.ts` は依然 runner 未配線（MVP スコープ通り）。一方 **`resume.ts`/`idempotencyStore.ts` は runner に配線済**になった: S3 段は inline `loadExistingS3()`、**S5 attempt 段は `IdempotencyStore.loadFromRun` で完了 attempt をスキップ**（AC5 達成・実 run 実証）。残る未配線は S2 クロールのみ。
4. **archiver / crawl サイドカー実 spawn**: archiver は未配線。crawl は s2 経由のみで、Python サイドカー（`crawl-py/crawl.py`）の実 spawn は自動テストでモック化されており**実プロセス未検証**。
5. **進化ループ（D18）本番未起動**: jankenEvolve/evolveDemo はデモ。decisions.md「評価器D3確定まで起動しない」に従い**意図的に未配線**（設計通りだが「動く進化」ではない）。
6. ~~**CodegenResult が書かれていない**~~ → **解消（2026-06-13）**: runner は S5 ループ後に `CodegenResult{strategy_id,passed,attempts,feedbackHistory,finalFeedback?}` を `S5R` partial に書く（`validateArtifact("CodegenResult")` で契約検証）。実 run（toy-fizzbuzz）で `partials/S5R_PARTIAL_W0B0_*.json` が生成され `feedbackHistory:["attempt 1: PASS (exit 0)"]` を永続化することを確認済み。ただし **複数 attempt（失敗注入）での reflector 実発火証跡は別途必要**（fizzbuzz は 1 attempt PASS なので feedbackHistory が 1 要素）。
7. **dashboard-lite 実起動未検証**: HTTP サーバはテスト緑だが、runner と別プロセスで、実ブラウザ表示は未確認。
8. **git untracked（未コミット）ファイル**: `orchestrator/runSummary.ts`, `tests/runSummary.test.ts`, `scripts/` が untracked（commit されていない）。`evolution/evolveDemo.ts`/`tests/evolveDemo.test.ts`/`examples/toy-hard/` は commit 6371b03 で tracked 済み（過去の「未コミット」記述は訂正）。
9. **claudeRunner の spawn 層が未テスト**: 純ロジック（extractText/buildArgs）すら named export されておらず、geminiRunner と非対称（gemini は純ロジックを export しテスト済み）。

---

## 4. Issue #3 Acceptance Criteria 達成状況

| # | AC | 判定 | 根拠 |
|---|---|---|---|
| AC1 | `python3`＋`claude` CLI 環境で `taikai run` 一発で `result.json` が出る | 達成 | `outputs/dev-run/result.json`・`fbp-run` が実在。経路は runner.runSlice |
| AC2 | わざと通らない仕様にすると D22 ループが3回試行し reflector feedback を feedbackHistory に残す | **達成（2026-06-13）** | `examples/toy-impossible`（同一入力に矛盾する2正解を要求＝充足不能の provided テスト）で実 run 実証: `[S5] attempt 1/2/3: FAIL`＋各失敗で `[S5] reflect:` が発火。`S5R` partial に `attempts:3`・`feedbackHistory:["attempt 1: FAIL","attempt 2: FAIL","attempt 3: FAIL"]`・`passed:false`・`finalFeedback`（reflector が「仕様自体が充足不能」と正しく診断）を永続化。result は best-so-far ratio=0.667 |
| AC3 | `tests/` を改変すると S6 が E_TEST_TAMPER で失格 | **達成（2026-06-13）** | `hashDir(projTests)` を S5開始時に凍結→S6で再ハッシュ→不一致で `E_TEST_TAMPER`+notify+exit 1。**故障注入 `TAIKAI_TAMPER_INJECT=1`（既定 off）で実 run 実証**: `[S6] E_TEST_TAMPER: テストが改変された → 失格`／`notify.jsonl` に `{"type":"E_TEST_TAMPER","strategy":"S3-001"}`／**exit 1**／result.json 未生成（採点せず失格）を確認 |
| AC4 | TOURNAMENT_INFO 必須欠落で S1 が exit 1＋通知 | 達成 | `doctor()` が必須6フィールド検査→欠落で `E_S1_INPUT` notify→exit 1 |
| AC5 | 途中で殺して再実行すると partial から resume（同 attempt を二重実行しない） | **達成（2026-06-13）** | S3 段は inline `loadExistingS3()` で既存戦略を再利用。**S5 attempt 段も `IdempotencyStore.loadFromRun(runDir,"S5")`（resume.ts→idempotencyStore.ts を配線）で完了済み attempt をスキップ**。実 run で実証: attempt 1 を FAIL 記録のまま再起動→`[S5] attempt 1: resume skip（冪等hit, FAIL）` で **LLM 再生成せず**、`[S5] attempt 2: PASS` で続行。S5R partial が `feedbackHistory:["attempt 1: FAIL（resume・LLM再生成スキップ）","attempt 2: PASS"]` を記録。冪等hit は `cb.recordSkip("idempotent_hit")`＝失敗に加算しない（D10/D11） |
| AC6 | result.json から provenance.derived_from で戦略→要件→ルールまで遡れる | **達成（2026-06-13）** | result.json に `provenance{produced_by:"S6", derived_from:[strategy_id], source_ref:rubric_ref}` を載せた（型＋schema＋runner 2 箇所）。実 run（toy-fizzbuzz）で result→`S3-fizzbuzz-modulo`（戦略 partial の derived_from=`["rubric:toy-fizzbuzz-rules"]`）→ rubric の鎖が **result 単体から辿れる**ことを確認済み |

**サマリ**: 6項目中、**完全達成6（AC1〜AC6 全て）**。（2026-06-13 に AC2/AC3/AC5/AC6 を実 run 実証で達成: AC2=`toy-impossible` で 3-attempt D22 系列、AC3=`TAIKAI_TAMPER_INJECT` 故障注入で E_TEST_TAMPER、AC5=`IdempotencyStore` で attempt resume、AC6=result provenance。Issue #3 の AC は全て充足。残る課題は AC の外＝D5 cost_tracker・回帰ガード passed_anchor_ids 実値化・S2/gemini 配線など §6/§5 の乖離項目。）

---

## 5. docs設計（D番号）と実装の対応・乖離

| D番号 | 設計 | 実装の現在地 | 乖離 |
|---|---|---|---|
| D2 JSON契約 | schemas/ に JSON Schema 実体＋検証必須 | `schemas/*.schema.json`(実10種: BenchResult/CodeAttempt/CodegenResult/LeaderboardEntry/PhaseArtifact/ProjectManifest/Provenance/ScoringRubric/Strategy/TournamentInfo)＋`schemas.ts`(ajv)＋`validate.ts`。selfcheck 緑 | **一致**。器も中身も実装済み（RunManifest/各Event/各Partial は未作成＝設計上の理想形） |
| D3 評価器 | S1 が SCORING_RUBRIC 導出、S6 は2モード(test/battle) | test型(`runner` parsePytestRatio)・battle型(`s6battle`) 両方動く。ただし SCORING_RUBRIC は**手書き**（S1 LLM 導出は未実装、doctor が存在検査するのみ） | **一部乖離**: rubric の S1 自動導出は未実装（MVP は手書き＝欠落4の主経路通り） |
| D4 CLI抽象 | Claude+Gemini を CLI subprocess、機械可読、ハードtimeout、フォールバック順 | runtimeRegistry＋claude/gemini runner 実装。timeout あり。**gemini は Windows spawn 修正で実発火可能になった（2026-06-13・認証段まで実機確認・`probe-gemini`）**。**フォールバック順/OutcomeTracker/AGENT_HEALTH.json は未実装** | **一部乖離**: gemini は配線・実発火可（認証はユーザ設定）だが、フェーズ別 model 切替の実運用とフォールバック順は未実装 |
| D5 コスト | デフォルト無制限、budget_usd 指定時のみ exit 64、cost_tracker 常時追跡 | **cost_tracker 未実装**。budget チェックも runner に無し | **乖離**: コスト追跡・上限ともに未実装（無制限のみ） |
| D7 S2クロール | 最大4回＋新規率<10%収束、サイドカー | `s2.ts`(収束判定/INDEX)＋`crawl.ts` 実装・テスト緑。だが**runner 未配線**＋サイドカー実 spawn 未検証 | **乖離**: 実装あるが未配線・未検証 |
| D9 状態モデル | partial=resume の唯一真実源、event は write-only | `resume.ts`(glob)＋`events.ts`(write-only) 実装・テスト緑・runner 配線済。S3 は inline `loadExistingS3()`、**S5 は `IdempotencyStore.loadFromRun`（内部で `scanCompleted` を使用）で attempt resume**（2026-06-13・実 run 実証） | **一致**（S2 クロールの resume だけは S2 未配線ゆえ未到達） |
| D10 冪等キー | hash(phase+worker+batch+親id+prompt_ver+model) | `idempotency.ts`＋`idempotencyStore.ts` 実装・テスト緑。**runner 配線済（2026-06-13）**: S5 ループが `IdempotencyStore.has/mark` で同一 attempt の二重実行を回避 | **一致**（外部送信・publish の冪等ガードは R3 ゲート側で別途） |
| D11 CB | 連続失敗5/総リトライ20/連続空3→exit65、recordSkip 区別 | `circuitBreaker.ts` 実装・テスト緑、runner 配線済（S5 ループ内）。ただし**「非空だが無進捗(stall)」検出は未実装**（decisions.md 自認の実装課題） | **一部乖離**: stall 検出未実装 |
| D17 再現性 | 手続き的再現＋複数trial分布報告 | provenance 型・hash 道具(`sha256`)はあるが、**run_manifest/trial分布レポートは未実装**。`sha256` は runner で `void` 予約のみ | **乖離**: 再現性レポート機構未実装 |
| D18 進化 | ①数値最適化(LLM不要) ②構造変異(LLM)、評価器確定まで起動しない | ①numericOptimizer/jankenEvolve 実装・テスト緑（未配線＝設計通り）。②S5 構造変異は単発生成のみで進化ループ無し | **設計通り**（①は意図的未配線）＋②進化ループ未実装 |
| D22 Reflexion | execute→evaluator→reflector→retry, maxAttempts=3, 失敗注入, 回帰ガード | runner S5 にループ実装。reflector LLM 既定。**失敗 input/expected/actual の「全文注入」はテスト出力 slice(1500) 止まり、回帰ガード(既通過再実行)は未実装**（CodeAttempt.passed_anchor_ids は ["all"] 固定） | **一部乖離**: 全文注入が部分・回帰ガード未実装・reflector 実発火未検証 |

---

## 6. 次に効く配線（優先度順・参考）

設計と実装の差を埋めるための具体配線ポイント（本書は棚卸しが目的なので提案のみ）:

1. ~~**AC5 を満たす**~~ → **完了（2026-06-13）**: S5 ループに `IdempotencyStore.loadFromRun(runDir,"S5")` を配線し、完了 attempt を冪等hit でスキップ（`cb.recordSkip("idempotent_hit")`）。実 run で attempt 1 skip→attempt 2 続行を実証。
2. ~~**D22 証跡の永続化**~~ → **完了（2026-06-13）**: S5 ループ後に `CodegenResult` を `S5R` partial に書く配線済（§3-6・AC2）。残るは失敗注入で multi-attempt の feedbackHistory を集める実 run。
3. **回帰ガード**: テストを ID 単位で扱い `passed_anchor_ids` を実値化（現状 `["all"]` 固定）。
4. ~~**result の provenance**~~ → **完了（2026-06-13）**: result.json に provenance を載せ AC6 を result 単体で達成（実 run で鎖を確認）。
5. **コミット**: untracked な evolveDemo / toy-hard を整理。

---
*関連: [decisions.md](./decisions.md)（D番号）/ [architecture.md](./architecture.md)（データ契約）/ [mvp-vertical-slice.md](./mvp-vertical-slice.md)（8欠落）/ Issue #3（AC）*
