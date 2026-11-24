## Motivation（なぜやるか）

設計（[`docs/`](../tree/main/docs)）は固まったが、コードは0行。レビューも「**まず1大会で1result出す縦串1本に絞れ**」と指摘済み。
全部（無限ループ・並列・進化・dashboard）を一気に作ると、本当の難所（S5実行環境・テスト供給・D22ループ）が1000行書いた後に判明する。
そこで **トイ大会（1関数・テスト型）で最小の縦串を end-to-end に通す**ことを最初の実装ゴールにする。CLI駆動は [speca で実証済み（D4）](../blob/main/docs/decisions.md) なので研究リスクはない＝Python実装をTSへ移植する作業。

## Goal（このissueの完了条件）

**手書き `TOURNAMENT_INFO.json` を置いて1コマンド叩くと、トイ課題のコードが生成・テスト通過し `result.json` が出る**。具体的には:

```
S1(手書きJSON読込) → S3(戦略 数個生成) → S5(D22 Reflexion ループで実装→テスト) → S6(test型採点) → result.json → 通知1本
```

S2/S4 はMVPでは薄くスキップ（S2=知見なし、S4=S3に統合）。

## Proposed change（実装内容）

### 対象トイ大会（具体）
- `name`: `toy-fizzbuzz`（最初の1問。後で差し替え可能）
- `language`: `python`（`python3` は環境にある／pytest で最小）
- 課題: 仕様文（例「`fizzbuzz(n)` を実装。3の倍数=Fizz, 5=Buzz, 両方=FizzBuzz, それ以外=n の文字列」）
- `test_source`: `provided`（テストは人間が用意＝信頼アンカー、S5は改変不可）
- `eval_mode`: `test`

### スコープ内（作る）
- [ ] **scaffold**: `package.json` / `tsconfig.json` / `orchestrator/` 骨格（TS/Node, pnpm or npm）
- [ ] **schemas**: `PhaseArtifact` / `Provenance` / `TournamentInfo` / `ScoringRubric` / `Strategy` / `CodeAttempt` / `CodegenResult` / `BenchResult` の最小 JSON Schema＋TS型（[architecture.md データ契約](../blob/main/docs/architecture.md) 準拠）
- [ ] **runtimeRegistry + claudeRunner**: `dashboard/server/services/chat_runtime_cli.py` を **TS移植**。`claude` CLI を subprocess、`--output-format json`、ハードtimeout、stdout から JSON 抽出（D4）。**MVPは Claude 1モデルのみ**（Gemini は後）
- [ ] **runPhase / runner**: フェーズを1エントリで実行。partial を `outputs/{run}/partials/S{n}_PARTIAL_*.json` に書く（partial-first）
- [ ] **S1**: `outputs/{run}/TOURNAMENT_INFO.json`＋`SCORING_RUBRIC.json` を読む。必須欠落は `exit 1`（E_S1_INPUT）。クロールしない
- [ ] **S3**: Claude 1呼び出しで戦略 2〜3個（`origin=requirement/subject` のみ＝cold-start）。`projects/{strategy_id}/` を作る
- [ ] **S5（中核・D22）**: 1戦略について Reflexion ループ — `execute(CLI生成→projects/{id}/src/main.py)` → `evaluator(pytest実行→{passed,reason})` → `reflector(失敗理由→改善指示)` → retry、`maxAttempts=3`。テストは開始時に sha256 凍結。失敗 input/expected/actual を全文注入、修正後は既通過を再実行（回帰ガード）
- [ ] **S6（test型）**: テスト再ハッシュ検証（E_TEST_TAMPER）→ `pytest` 実行 → `passed_test_ratio` で採点 → `result.json`
- [ ] **leaderboard**: `outputs/leaderboard.json` に追記
- [ ] **notify**: `TAIKAI_NOTIFY_WEBHOOK` へ best-effort POST＋`logs/notify.jsonl`（無ければログだけ）
- [ ] **CLI**: `taikai run --run-dir outputs/{run}` で一気通貫

### スコープ外（作らない・後回し）
- 無限ループ（1周だけ走らせて止める）/ S2大量クロール / S4独立 / 並列ワーカー
- 進化(D18)・island・numericOptimizer / 対戦モード(battle) / Gemini 2モデル目
- dashboard server の TS化 / covenant監査 / 提出フロー（toyは提出しない）/ CB の全機能（最低限の timeout だけ）

## Acceptance Criteria（Definition of Done）

- [ ] `python3` と `claude` CLI がある環境で `taikai run` 一発で `result.json` が出る
- [ ] わざと通らない仕様にすると **D22 ループが3回試行して reflector フィードバックを `feedbackHistory` に残す**（失敗理由が記録される）
- [ ] `tests/` を改変すると **S6 が E_TEST_TAMPER で失格にする**
- [ ] `TOURNAMENT_INFO.json` の必須欠落で **S1 が exit 1＋通知**
- [ ] 途中で殺して再実行すると **partial から resume**（同じ attempt を二重実行しない）
- [ ] `result.json` から `provenance.derived_from` で戦略→要件→ルールまで遡れる

## Scope（パイプライン影響範囲）
New phase / pipeline stage ・ Orchestrator / harness ・ New evaluation harness（test型）

## Alternatives considered
- トイ大会＝じゃんけん（対戦型）: S6対戦モードと数値最適化を先に検証できるが、D22ループ（S5の中核）の検証には test型が素直。→ 対戦型は次のトイとして別issue。
- いきなり本番大会: R1(資格)/R3(提出)/テスト供給が絡み配管検証に集中できない。→ 却下。

## References
- [docs/mvp-vertical-slice.md](../blob/main/docs/mvp-vertical-slice.md)（8欠落の具体仕様）
- [docs/architecture.md](../blob/main/docs/architecture.md)（データ契約・エラー経路）
- [docs/decisions.md](../blob/main/docs/decisions.md)（D4 CLI実証 / D22 Reflexion / 受任リスク）
- [docs/integrations-issue1.md](../blob/main/docs/integrations-issue1.md)（D22・回帰ガードの出典）
- 移植元: `dashboard/server/services/chat_runtime_cli.py`（vendor済み speca）
