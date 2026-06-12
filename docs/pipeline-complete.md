# パイプライン完成形（正直版）— 4実行モードと S1..S6 の対応

実装済みの「完全な姿」を誇張せずまとめる。設計の正は [`docs/`](./README.md)
（[architecture.md](./architecture.md) の S1..S6、[decisions.md](./decisions.md) D18）。
本書はその設計が **実コード（`orchestrator/index.ts` の CLI・`runner.ts` の `runSlice`/`runExperiment`/`runLoop`、
`quest/`、`evolution/`）でどう実体化しているか** だけを述べる。判定語は
[implementation-status.md](./implementation-status.md) と同じ（動く / テストのみ / 未配線 / 未検証）。

検証時点: 2026-06-13。CLI は **8コマンド**（`index.ts` の switch 実体）:
`probe` / `run` / `doctor` / `status` / `evolve` / `experiment` / `quest` / `loop`。

---

## 0. 一目でわかる結論

- パイプラインは「縦一本 1 周」だけでなく **ぐるぐる回る（結果再投入・世代交代・収束停止）** が `loop` で実体化している。
- 「ぐるぐる」の本体は `runLoop`（`runner.ts`）。S1 を一度通し、`S3 戦略生成 → S5 実装 → S6 採点 → 勝者再投入` を
  改善が止まる（patience）か満点（ratio>=1.0）まで回す。**毎 round 現最強を `result.json` に出し続ける**。
- 「いいとこ取り」は `generateStrategies(spec, rubric, priorWinners)` の `priorWinners` 経路で実装済み
  （上位 approach を次 round の種に注入し、丸写し禁止で改良・組合せさせる）。
- ただし **無限ではなく収束停止**、**S2（知見）/ S4（要件精緻化）は loop に「差せる」設計だが現状は任意 hook（未配線）**、
  **battle 型は loop/experiment 未対応で `run` のみ** ── ここは正直に未実装/簡略として下に明記する。

---

## 1. 4実行モードと S1..S6 の対応（1枚）

`docs/architecture.md` の S1(要件定義) / S2(外部知見) / S3(戦略生成) / S4(要件精緻化) / S5(コード生成) / S6(ベンチマーク)
に対し、各 CLI モードがどこを実際に通すか。`-` = そのモードでは通さない、`hook` = 差せる設計だが現状は任意（未配線）。

| モード | コマンド | S1 | S2 | S3 | S4 | S5 | S6 | 回り方 | 実体 |
|---|---|---|---|---|---|---|---|---|---|
| 縦一本（1周） | `taikai run` | doctor | - | 戦略生成 | - | D22 実装 | test採点 **or** battle | S1→S3→S5→S6 を **1 周**（再投入なし） | `runSlice` |
| 多戦略実験 | `taikai experiment` | doctor | - | 多戦略生成 | - | 各戦略 D22 実装 | test採点 | **固定 round** 数だけ複数戦略を試し閾値実験 | `runExperiment` |
| ぐるぐる | `taikai loop` | doctor(一度) | hook | 戦略生成(勝者再投入=いいとこ取り) | hook | D22 実装 | test採点 | **収束まで** S3→S5→S6→再投入を反復 | `runLoop` |
| 数値クエスト | `taikai quest` | - | - | - | - | - | 数値評価関数(=S6の評価器) | GA で **世代** 反復（LLM不要） | `quest/runQuest` |
| （補助）数値進化 | `taikai evolve` | - | - | - | - | - | janken 勝率(=評価関数) | ヒルクライム反復 | `evolution/evolveDemo` |
| （未実装）コオエボ | `taikai coevolve` | - | - | - | - | - | 現チャンピオン対戦勝率(=進化する評価器) | 軍拡競争で **世代** 反復（勝てた挑戦者だけ昇格） | 未配線（`index.ts` switch に無し） |

補足:

- **S1=doctor**: 4 モードのうち run/experiment/loop は冒頭で `doctor(runDir)` を呼び、
  `TOURNAMENT_INFO.json` 必須欠落と `SCORING_RUBRIC.json` 不在で **exit 1**（欠落4）。loop ではこれが「S1 を一度だけ」に当たる。
- **S6=test採点 or battle**: `run` だけが `rubric.eval_mode==="battle"` を見て `runBattle`（戦略プログラム同士を総当たり）に分岐する。
  `experiment` / `loop` は冒頭で `eval_mode!=="test"` を弾く（`exit 2`）＝ battle 型は現状 `run` 専用。
- **evolve / quest = 数値最適化（D18①）**: LLM 非依存。S6 の評価関数（じゃんけん勝率・クエスト fitness）を
  GA／ヒルクライムで数千〜数万回呼ぶ「閾値・パラメータ最適化トラック」。S1..S5 の LLM フェーズは通らない。
- **quest の 4 種（X/AI/Robo/Data）**: `--quest xq|ai|robo|data` で `QuestAdapter` を差し替え（`quest/*Adapter.ts`）。
  どれも `initialCandidate()`→`evaluate()` の数値クエストで、`runQuest` 共通エンジン（`populationGA.ts`）が回す。
- **coevolve（未実装・配線予定）= 固定 fitness の対**: `taikai quest` の評価器は**固定の相手**（X なら random/medium・他は held-out 指標）で
  地形が定数だが、`taikai coevolve` は評価器の「相手」を**現チャンピオン**にして、勝てた挑戦者だけを昇格させる軍拡競争トラック。
  進化する評価器に対して最適化する点が固定 fitness との本質差（FunSearch/AlphaEvolve の核）。設計・原理は
  [quests.md §7](./quests.md)。**現状 `index.ts` の switch には無く未実装**で、相手に任意 params を据える `evaluate.py` 入力契約の
  拡張も含めて配線は別担当。実測値は実装後に quests.md §7.5 の枠へ入れる（現時点で固定 fitness 超えは未実証＝主張しない）。

---

## 2. 現状の実体（loop を中心に）

### 2.1 loop（`runLoop`）が通す範囲

`runner.ts` の `runLoop(runDir, { maxRounds=50, topK=2, patience=4 })` の実体:

1. **S1 = doctor を一度**（`ensureDirs`→`doctor`）。`eval_mode!=="test"` は `exit 2`。
2. round ループ（1..maxRounds）:
   - **S3 = `generateStrategies(spec, rubric, priorTop)`**。`priorTop` はこれまでの上位2 approach（ratio 降順）。
     これが「いいとこ取り＝勝者再投入」の実体。id は `r{round}-...` で round ごとに一意化。
   - **S5 = `implementStrategyTest(...)`**（topK 戦略ぶん）。D22 Reflexion ループ（最大 `MVP_PHASES.S5.maxAttempts`、
     失敗時 reflector で改善指示注入、テスト改変検知 `E_TEST_TAMPER`）。
   - **S6 = test 採点**（`parsePytestRatio`）。各戦略を `leaderboard.json` に append。
   - **現最強を `result.json` に毎 round 上書き**（`BenchResult`、`result_id=${runId}-r${round}`）。
3. 収束停止 → `loop_summary.json`（`progression` 履歴つき）＋ `archive_manifest.json` を書き、`notify(loop_complete)`。

### 2.2 S2 / S4 を「差す」設計（現状は任意 hook・未配線）

表の `hook` は **将来 loop の round 内に差し込む口** であり、現状 `runLoop` からは呼ばれていない。

- **S2（外部知見）= `s2.ts` の `runS2` / `buildKnowledgeIndex`**。実装＋テスト緑（`s2.test.ts`）だが runner 未配線
  （[implementation-status.md](./implementation-status.md) §1.3）。設計上は loop の S3 直前に
  「知見収集フェーズ（gatherKnowledge 相当）」として round 先頭に差せる。任意：知見が不要な課題ではスキップしても loop は回る。
- **S4（要件精緻化）= 戦略ごとの要件詰め（refineRequirements 相当）**。S3 と S5 の間に差せる任意フェーズ。
  現状 `runLoop` は S3 の `approach` を直接 S5 に渡す（S4 を挟まない）。
- どちらも **任意 hook** であって、loop の最小経路（S3→S5→S6→再投入）の成立条件ではない。

### 2.3 evolve / quest = 数値最適化（D18①）

- `evolve`: `evolution/evolveDemo.ts` の `evolveJankenDemo`。じゃんけんパラメータをヒルクライムで進化、`win_rate` の改善を返す。
- `quest`: `quest/runQuest.ts` ＋ `populationGA.ts`。`QuestAdapter`（xq/ai/robo/data）の `evaluate` を fitness に GA で世代反復、
  `best_params.json` を出力。**LLM を一切起動しない**（決定的・無料・高速）。S6 対戦評価器をそのまま数値最適化に流用する D18① の体現。

---

## 3. 「縦一本でなくぐるぐる回る」がどう実現されているか

`docs/architecture.md` の `S6 -->|result.json を再投入| S2` の無限ループを、loop は **test 型で次の4機構** として実装する。

1. **結果再投入（いいとこ取り）**: `generateStrategies` の第3引数 `priorWinners`。
   上位 approach を `## これまでの高得点戦略（いいとこ取りして改良・組合せ…丸写し禁止）` として次 round のプロンプトに注入。
   `Strategy.origin` の `result` 経路（前 result を種にする）の test 型実体。
2. **世代交代**: round ごとに新戦略を生成し id を `r{round}-...` で更新。`outcomes[]` に全戦略を蓄積、
   毎 round の上位を次の種にする（プールが世代を跨いで成長）。
3. **収束停止**: `best.ratio>=1.0`（満点）で break、または `patience` round 連続で改善なし（`noImprove>=patience`）で break。
   `S2_*` の収束（新規率<閾値）と同じ「同じものが出たら止める」思想を、loop では改善停滞で判定。
4. **現最強の継続出力**: 毎 round 末に **現最強を `result.json` に上書き** ＋ `leaderboard.json`（`outputs/` 横断）に全戦略 append。
   `loop_summary.json` の `progression[]` に round ごとの `best_ratio`/`strongest` を残す。
   → 途中で止めても「その時点の最強」が常にディスク上にある（best-so-far first-class）。

`leaderboard.json` は **run 横断**で `score` 降順ソート（`appendLeaderboard`）。同一 `rubric_ref` 内での最強選抜に使える（欠落8）。

---

## 4. 未実装 / 簡略（正直に）

| 項目 | 設計（docs） | 現状の実体 | 区分 |
|---|---|---|---|
| ループの停止条件 | rate-limit 枯渇まで「無限」 | **無限ではなく収束停止**（patience＝改善停滞、または満点 ratio>=1.0、または maxRounds）。budget/rate での停止は未配線 | 簡略 |
| S2（外部知見） | loop の round 内で知見収集 | `runS2` 実装＋テスト緑だが **loop 未配線の任意 hook**（gatherKnowledge 相当の差込口のみ） | 任意 hook |
| S4（要件精緻化） | 戦略ごとに要件を詰める | **loop 未配線の任意 hook**（refineRequirements 相当）。S3 approach を直接 S5 に渡す | 任意 hook |
| battle 型 | S6 の2モードの片方 | **loop / experiment は未対応**（`eval_mode!=="test"` を `exit 2`）。battle 型は `run`（`runBattle`）のみ | 未対応 |
| 並列ワーカー | フェーズ内並列（architecture 図） | loop/experiment は **topK 戦略を直列**実装（並列ワーカー化は未配線） | 簡略 |
| Gemini | フェーズ×モデル手動指定 | register 済みだが全フェーズ `model:"claude"` 固定（loop も claude のみ） | 未検証 |
| budget/rate 停止 | コスト上限・rate 枯渇で停止 | loop は patience/maxRounds 停止のみ。`budget_usd`・`E_RATELIMIT` 待機は loop 経路に未配線 | 未配線 |

> 思想は維持: **単一戦略の失敗で loop を止めない**（`implementStrategyTest` は非致命で 0 点を返すだけ）、
> **スキップ時も `result.json`/`leaderboard` は必ず書く**（best-so-far first-class）、
> **テスト改変は失格**（`E_TEST_TAMPER`）。停止は収束（patience/満点/maxRounds）に限定し、誇張しない。

---

## 関連

- S1..S6 の正本: [architecture.md](./architecture.md)（「無限ループ: rate-limit 枯渇まで (S2..S6)」図、S6 2評価モード）
- 進化2トラック: [decisions.md](./decisions.md) D18（①数値最適化＝LLM不要 / ②構造変異＝LLM）
- 実装の現在地（runner 配線・テスト数の正）: [implementation-status.md](./implementation-status.md)
