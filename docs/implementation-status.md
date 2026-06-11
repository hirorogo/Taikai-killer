# 実装状況の棚卸し（正直版）

リポジトリを実際に Read/Grep して、コードがどこまで「動く」かを誇張せずに記録する。
判定語は4段階で厳密に区別する:

- **動く** = runner（縦串本体）に配線され、実 run で `result.json` / 成果物を生成した実績がある
- **テストのみ** = vitest 純ロジックテストは緑だが、実パイプライン（runner / spawn / LLM）には未配線、または実プロセスでの動作未実証
- **未配線** = 実装はあるが `orchestrator/runner.ts` から呼ばれていない（import されていない）
- **未検証** = LLM 発火・外部認証・実プロセスなど、ユニットテストでは確かめられない部分が未実証

検証時点: 2026-06-11。`npx vitest run` = **24 ファイル / 324 テスト 全 pass**。
設計の正は [`docs/`](./README.md)。本書は設計（D番号）に対する**実装の現在地**だけを述べる。

---

## 0. 一目でわかる結論

- **縦串MVP（Issue #3）は実通している。** test型（fizzbuzz）と対戦型（janken）の両方が `taikai run` で `result.json` を出した実績が `outputs/` に残る。
- ただし **runner に配線されているのは S3→S5→S6 の最小経路だけ**。S2 / resume / 冪等 / archiver / 進化 / Gemini / dashboard は「実装＋テスト緑」だが **runner からは呼ばれていない（未配線）**。
- **LLM 発火に依存する箇所（S3 戦略生成・S5 生成・S5 reflector）は実 run で動いた形跡があるが、ユニットテストでは検証不能**。本書では「動く（実 run 実績あり）」と「未検証（自動テスト外）」を分けて明記する。
- Gemini は `index.ts` に **register 済みだが、どのフェーズも `model:"claude"`** 固定で、**認証未設定なら error.code=41**（runner からは未使用＝実質未検証）。

---

## 1. 実装済みモジュール表

「runner配線」列: ✅=runner.ts が import して実行する / ❌=未配線（テスト or 他モジュールからのみ参照）。

### 1.1 オーケストレータ共有層（読むだけ＝担当外、現状把握用）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/index.ts` | CLI エントリ（probe/run/doctor）。claude+gemini を register | なし | — | 動く（probe/run/doctor 実行可） |
| `orchestrator/runner.ts` | 縦串本体 S3→S5→S6＋battle 分岐 | なし（実 run で実証） | ✅本体 | 動く |
| `orchestrator/config.ts` | PhaseConfig / CB しきい値 / MVP_PHASES | なし | ✅ | 動く |
| `orchestrator/types.ts` | フェーズ間データ契約（TS型） | （schemas で間接） | ✅ | 動く |
| `orchestrator/paths.ts` | outputs パス規約（D2） | （resume 等で間接） | ✅ | 動く |
| `orchestrator/runtimeRegistry.ts` | CLI runtime 統一層（D4） | なし | ✅ | 動く |
| `orchestrator/schemas.ts` | ajv JSON Schema 検証 | `schemas.test.ts`(19) | ✅(validate 経由) | 動く |

### 1.2 runner に配線済み（=動く）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/runtimes/claudeRunner.ts` | claude CLI subprocess driver | `geminiRunner.test.ts` は gemini側。claude純ロジックは未テスト | ✅ | 動く（実 run で S3/S5 生成実績）。spawn部は未テスト |
| `orchestrator/notify.ts` | best-effort 通知（欠落5） | `notify.test.ts`(8) | ✅ | 動く |
| `orchestrator/events.ts` | append-only イベントログ（D9 write-only） | `events.test.ts`(9) | ✅ | 動く |
| `orchestrator/circuitBreaker.ts` | CB 暴走停止（D11） | `circuitBreaker.test.ts`(9) | ✅ | 動く |
| `orchestrator/collector.ts` | S3 戦略 dedup（純ロジック） | `collector.test.ts`(18) | ✅ | 動く |
| `orchestrator/validate.ts` | 検証ラッパ（ajv 委譲） | `validate.test.ts`(14) | ✅ | 動く |
| `orchestrator/backup.ts` | 成果物バックアップ（欠落6） | `backup.test.ts`(13) | ✅ | 動く（`TAIKAI_BACKUP_DIR` 未設定なら no-op） |
| `orchestrator/battle.ts` | round-robin 純集計＋じゃんけん優劣表 | `battle.test.ts`(18) | ✅(battle分岐) | 動く |
| `orchestrator/battleRunner.ts` | 戦略プロセス同士の spawn 対戦 I/O | `battleRunner.test.ts`(18 純ロジックのみ) | ✅(battle分岐) | 動く（janken-run 実績）。spawn部はテスト外 |
| `orchestrator/s6battle.ts` | battle→BenchResult 変換＋rank | `s6battle.test.ts`(12) | ✅(battle分岐) | 動く |

### 1.3 実装＋テスト緑だが runner 未配線

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `orchestrator/s2.ts` | S2 外部知見クロール＋知見INDEX（D7） | `s2.test.ts`(41) | ❌ | テストのみ・未配線（runner は S2 を呼ばない＝MVP仕様通りスキップ） |
| `orchestrator/crawl.ts` | クロール（Python サイドカー呼び出し） | `crawl.test.ts`(15) | ❌(s2経由のみ) | テストのみ・未配線。サイドカー実 spawn は未検証 |
| `orchestrator/resume.ts` | partial glob スキャンで resume（D9） | `resume.test.ts`(9) | ❌ | テストのみ・**runner未配線**（重大: AC「resume」未達） |
| `orchestrator/idempotency.ts` | 冪等キー生成（D10） | `idempotency.test.ts`(11) | ❌ | テストのみ・未配線 |
| `orchestrator/idempotencyStore.ts` | 冪等マーカー集合（D10×D9） | `idempotencyStore.test.ts`(13) | ❌ | テストのみ・未配線（resume と組で AC「二重実行しない」未達） |
| `orchestrator/archiver.ts` | run アーカイブ（zstd tarball / steal E-6） | `archiver.test.ts`(9) | ❌ | テストのみ・未配線 |
| `orchestrator/runtimes/geminiRunner.ts` | gemini CLI driver（D4 2モデル目） | `geminiRunner.test.ts`(10 純ロジック) | register済/未使用 | テストのみ。**認証未設定（GEMINI_API_KEY 等）→ error.code=41。実発火未検証** |
| `orchestrator/runtimes/geminiMcp.ts` | gemini MCP 連携の知見 | `geminiMcp.test.ts`(11) | ❌ | テストのみ・未配線 |

### 1.4 進化トラック（D18①）— 実証デモ・本番未配線

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `evolution/numericOptimizer.ts` | ヒルクライム最適化（決定的・seed固定） | `numericOptimizer.test.ts`(12) | ❌ | テストのみ。LLM非依存・純ロジック |
| `evolution/jankenStrategy.ts` | じゃんけん数値パラメータ戦略 | （jankenEvolution 経由） | ❌ | テストのみ |
| `evolution/jankenEvolve.ts` | 数値戦略を勝率で進化（D18①実証） | `jankenEvolution.test.ts`(16) | ❌ | テストのみ・**本番進化ループ未配線**（評価器D3確定まで起動しない＝設計通り） |
| `evolution/evolveDemo.ts` | D18① end-to-end デモ薄ラッパ | `evolveDemo.test.ts`（未コミット） | ❌ | テストのみ・未配線・**未コミット（git untracked）** |

### 1.5 dashboard-lite（read-only ビューア）

| ファイル | 役割 | テスト | runner配線 | 状態 |
|---|---|---|---|---|
| `dashboard-lite/server.ts` | outputs/leaderboard を read-only 提供 | `dashboardLite.test.ts`(13) / `dashboardFull.test.ts`(17) / `dashboardSSE.test.ts`(8) | ❌(独立プロセス) | テストのみ。runner とは別プロセス、実起動は未検証 |
| `dashboard-lite/readers.ts` | outputs read-only リーダ | 同上 | — | テストのみ |
| `dashboard/` (frontend) | speca から vendor した React UI | — | — | vendor 物・本プロジェクト未統合 |

---

## 2. 実動する縦串（vertical slice）の状態

`outputs/` に残る実 run の成果物で「実際に通った」ことを確認した。

### 2.1 test型（fizzbuzz）— ✅実通

- `outputs/dev-run/result.json`: `eval_mode:"test"`, `strategy_id:"S3-001"`, `passed_test_ratio:1`, `rank:1`
- `outputs/fbp-run/result.json`: `toy-fizzbuzz-plus`, `passed_test_ratio:1`
- 経路: doctor → S3（Claude LLM で戦略生成）→ dedup → S5（D22 Reflexion ループ・テスト sha256 凍結）→ S6（テスト再ハッシュ検証＋pytest採点）→ result.json → leaderboard 追記 → 通知。
- partial 実物あり: `outputs/dev-run/partials/S3_PARTIAL_*.json`（3件）, `S5_PARTIAL_W0B1_*.json`(status:ok, provenance.derived_from=["S3-001"])。
- **動く（実 run 実績）**。ただし S3/S5/S5-reflector の LLM 発火は自動テスト範囲外（=「動いた形跡はあるが再現性は手続き的・未検証」）。

### 2.2 対戦型（janken）— ✅実通

- `outputs/janken-run/result.json`: `eval_mode:"battle"`, winner `beat-last`, `win_rate:0.475`, `battle.record{wins:19,losses:0,draws:21}`, opponents `[always-rock, cycle]`。
- 経路: rubric.eval_mode=="battle" 分岐 → `players/{id}/` を読み（3体）→ runBattleEval（spawn で総当たり 20 ラウンド）→ toBenchResults（rank 付与）→ result.json＋leaderboard（3体分）。
- プレイヤーは実 Python（`examples/toy-janken/players/{always-rock,beat-last,cycle}/player.py`）。
- **動く（実 run 実績）**。spawn 対戦 I/O はユニットテスト外だが、実 run で 40 マッチ完走している。

### 2.3 縦串に「入っていない」もの（MVP仕様通り）

mvp-vertical-slice.md の原則「無限ループ・S2大量クロール・S4独立・並列・進化・island・2モデル目は入れない」に沿って、runner は **1周だけ・S2/S4スキップ・単一戦略のみ S5 実装**。これは欠陥ではなく**スコープ通り**。ただし下記の AC 未達（resume）は MVP の DoD に含まれており、別問題（§4 参照）。

---

## 3. スタブ・未配線・未検証の明示リスト

レビューが疑う「動くと言いつつ動かない」を先回りで列挙する。

1. **S5 reflector の LLM 発火（D22 既定=LLM）**: `runner.ts:reflect()` は実装済みで実 run 経路にあるが、**ユニットテストは無い**。`TAIKAI_REFLECTOR=template` で LLM 省略にできる。fizzbuzz は 1 attempt で PASS したため、**reflector が実際に発火した証跡（複数 attempt の feedbackHistory）は `outputs/` に残っていない**＝reflector 実発火は**未検証**。
2. **geminiRunner 認証未設定**: `index.ts` で register 済みだが全フェーズ `model:"claude"`。`GEMINI_API_KEY`/`GOOGLE_GENAI_USE_GCA` 未設定だと error.code=41。`checkAvailable` は `--version` のみで認証を見ない。**実 LLM 応答は未検証**。
3. **S2 / resume / idempotency が runner 未配線**: 3者とも実装＋テスト緑だが `runner.ts` は import すらしない（§1.3）。resume は AC 項目なのに未配線（§4）。
4. **archiver / crawl サイドカー実 spawn**: archiver は未配線。crawl は s2 経由のみで、Python サイドカー（`crawl-py/crawl.py`）の実 spawn は自動テストでモック化されており**実プロセス未検証**。
5. **進化ループ（D18）本番未起動**: jankenEvolve/evolveDemo はデモ。decisions.md「評価器D3確定まで起動しない」に従い**意図的に未配線**（設計通りだが「動く進化」ではない）。
6. **CodegenResult が書かれていない**: `types.ts` に `CodegenResult{feedbackHistory}` 型はあるが、runner は `feedbackHistory` を**ローカル変数に持つだけで partial/result に永続化していない**。AC「reflector フィードバックを feedbackHistory に残す」は**メモリ上は満たすがファイル証跡は残らない**。
7. **dashboard-lite 実起動未検証**: HTTP サーバはテスト緑だが、runner と別プロセスで、実ブラウザ表示は未確認。
8. **未コミット成果物**: `evolution/evolveDemo.ts`, `tests/evolveDemo.test.ts`, `examples/toy-hard/` が git untracked（commit されていない）。
9. **claudeRunner の spawn 層が未テスト**: 純ロジック（extractText/buildArgs）すら named export されておらず、geminiRunner と非対称（gemini は純ロジックを export しテスト済み）。

---

## 4. Issue #3 Acceptance Criteria 達成状況

| # | AC | 判定 | 根拠 |
|---|---|---|---|
| AC1 | `python3`＋`claude` CLI 環境で `taikai run` 一発で `result.json` が出る | ✅達成 | `outputs/dev-run/result.json`・`fbp-run` が実在。経路は runner.runSlice |
| AC2 | わざと通らない仕様にすると D22 ループが3回試行し reflector feedback を feedbackHistory に残す | ⚠️部分 | maxAttempts=3 ループ・reflect()・feedbackHistory.push は実装済み。だが**失敗 run の証跡が outputs に無く実発火未検証**。さらに feedbackHistory は**ファイルに永続化されない**（§3-6）。CodegenResult 未出力 |
| AC3 | `tests/` を改変すると S6 が E_TEST_TAMPER で失格 | ✅実装あり/未実証 | `runner.ts` で `hashDir(projTests)` を S5開始時に凍結→S6で再ハッシュ比較→不一致で `E_TEST_TAMPER`+notify+exit 1。コードは正しいが**改変ケースの実 run 証跡は無く未検証** |
| AC4 | TOURNAMENT_INFO 必須欠落で S1 が exit 1＋通知 | ✅達成 | `doctor()` が必須6フィールド検査→欠落で `E_S1_INPUT` notify→exit 1 |
| AC5 | 途中で殺して再実行すると partial から resume（同 attempt を二重実行しない） | ❌**未達** | `resume.ts`/`idempotencyStore.ts` は実装＋テスト緑だが **runner.ts が一切 import しない**。runner は毎回 S3 から作り直す（partial を消費しない）。**AC の核心が未配線** |
| AC6 | result.json から provenance.derived_from で戦略→要件→ルールまで遡れる | ⚠️部分 | partial の provenance.derived_from は繋がる（S5→["S3-001"]、S3→["rubric:..."]）。ただし**最終 result.json 自体に provenance フィールドが無い**（`rubric_ref` 文字列参照のみ）。partial 経由では遡れるが result 単体からは辿れない |

**サマリ**: 6項目中、**完全達成2（AC1, AC4）**、**部分3（AC2, AC3, AC6）**、**未達1（AC5＝resume 未配線）**。
最重要の欠落は **AC5: resume/冪等が runner に未配線**。モジュールとテストは揃っているので「配線するだけ」だが、現状の runner では「殺して再実行」は最初からやり直しになる。

---

## 5. docs設計（D番号）と実装の対応・乖離

| D番号 | 設計 | 実装の現在地 | 乖離 |
|---|---|---|---|
| D2 JSON契約 | schemas/ に JSON Schema 実体＋検証必須 | `schemas/*.schema.json`(11種)＋`schemas.ts`(ajv)＋`validate.ts`。selfcheck 緑 | **一致**。器も中身も実装済み |
| D3 評価器 | S1 が SCORING_RUBRIC 導出、S6 は2モード(test/battle) | test型(`runner` parsePytestRatio)・battle型(`s6battle`) 両方動く。ただし SCORING_RUBRIC は**手書き**（S1 LLM 導出は未実装、doctor が存在検査するのみ） | **一部乖離**: rubric の S1 自動導出は未実装（MVP は手書き＝欠落4の主経路通り） |
| D4 CLI抽象 | Claude+Gemini を CLI subprocess、機械可読、ハードtimeout、フォールバック順 | runtimeRegistry＋claude/gemini runner 実装。timeout あり。**フォールバック順/OutcomeTracker/AGENT_HEALTH.json は未実装** | **乖離**: 2モデル目未使用、フォールバック未実装 |
| D5 コスト | デフォルト無制限、budget_usd 指定時のみ exit 64、cost_tracker 常時追跡 | **cost_tracker 未実装**。budget チェックも runner に無し | **乖離**: コスト追跡・上限ともに未実装（無制限のみ） |
| D7 S2クロール | 最大4回＋新規率<10%収束、サイドカー | `s2.ts`(収束判定/INDEX)＋`crawl.ts` 実装・テスト緑。だが**runner 未配線**＋サイドカー実 spawn 未検証 | **乖離**: 実装あるが未配線・未検証 |
| D9 状態モデル | partial=resume の唯一真実源、event は write-only | `resume.ts`(glob)＋`events.ts`(write-only) 実装・テスト緑。events は runner 配線済、**resume は未配線** | **乖離**: resume が runner 未配線（AC5） |
| D10 冪等キー | hash(phase+worker+batch+親id+prompt_ver+model) | `idempotency.ts`＋`idempotencyStore.ts` 実装・テスト緑。**runner 未配線** | **乖離**: 未配線 |
| D11 CB | 連続失敗5/総リトライ20/連続空3→exit65、recordSkip 区別 | `circuitBreaker.ts` 実装・テスト緑、runner 配線済（S5 ループ内）。ただし**「非空だが無進捗(stall)」検出は未実装**（decisions.md 自認の実装課題） | **一部乖離**: stall 検出未実装 |
| D17 再現性 | 手続き的再現＋複数trial分布報告 | provenance 型・hash 道具(`sha256`)はあるが、**run_manifest/trial分布レポートは未実装**。`sha256` は runner で `void` 予約のみ | **乖離**: 再現性レポート機構未実装 |
| D18 進化 | ①数値最適化(LLM不要) ②構造変異(LLM)、評価器確定まで起動しない | ①numericOptimizer/jankenEvolve 実装・テスト緑（未配線＝設計通り）。②S5 構造変異は単発生成のみで進化ループ無し | **設計通り**（①は意図的未配線）＋②進化ループ未実装 |
| D22 Reflexion | execute→evaluator→reflector→retry, maxAttempts=3, 失敗注入, 回帰ガード | runner S5 にループ実装。reflector LLM 既定。**失敗 input/expected/actual の「全文注入」はテスト出力 slice(1500) 止まり、回帰ガード(既通過再実行)は未実装**（CodeAttempt.passed_anchor_ids は ["all"] 固定） | **一部乖離**: 全文注入が部分・回帰ガード未実装・reflector 実発火未検証 |

---

## 6. 次に効く配線（優先度順・参考）

設計と実装の差を埋めるための具体配線ポイント（本書は棚卸しが目的なので提案のみ）:

1. **AC5 を満たす**: `runner.runSlice` 冒頭で `scanCompleted(runDir,"S5")` を呼び、完了 attempt をスキップ／`IdempotencyStore.loadFromRun` で二重実行回避（モジュールは完成済み・配線のみ）。
2. **D22 証跡の永続化**: S5 ループ後に `CodegenResult{strategy_id,passed,attempts,feedbackHistory}` を partial/result に書く（型は既存）。reflector 実発火の証跡が AC2 の実証に必要。
3. **回帰ガード**: テストを ID 単位で扱い `passed_anchor_ids` を実値化（現状 `["all"]` 固定）。
4. **result の provenance**: result.json に provenance を載せ AC6 を result 単体で満たす。
5. **コミット**: untracked な evolveDemo / toy-hard を整理。

---
*関連: [decisions.md](./decisions.md)（D番号）/ [architecture.md](./architecture.md)（データ契約）/ [mvp-vertical-slice.md](./mvp-vertical-slice.md)（8欠落）/ Issue #3（AC）*
