# 標準化AIフレームワーク — シンギュラリティバトルクエスト横断ハーネス

シンギュラリティバトルクエスト（以下 SBQ）の **複数クエストを 1 つの標準ハーネスで横断して攻略する**ための設計ドキュメント。
正本は [architecture.md](./architecture.md)（S6 の2評価モード・データ契約）と [decisions.md](./decisions.md)（D8 対象大会・D18 進化2トラック）。
本書は「各クエストを共通の `候補→評価→最適化→提出` に落とす標準化（**QuestAdapter** 抽象）」を定義し、
**実装済み・実動（`orchestrator/quest/{adapter,runQuest,xqAdapter,aiHyperoptAdapter,roboControlAdapter,dataInsightAdapter}.ts` / `quests/{xq-7narabe,ai-hyperopt,robo-control,data-insight}/{engine,ai_param,evaluate,sim}.py 等` / `evolution/numericOptimizer.ts` / `orchestrator/battle.ts`）と、実装済み・未配線（`orchestrator/quest/populationGA.ts`＝個体群 GA／`quests/xq-7narabe/ai_mc.py`＝簡易 PIMC=決定化 MC プレイヤー＋`evaluate_mc.py`＝その評価サイドカー。いずれもコードは実在・単体実行可能だが orchestrator の数値トラックには繋いでいない）と、未実装（AI/Robo/X の LLM 構造変異ループ）を厳密に区別**する（実装済みを過小申告せず、未実装を誇張しない。判定語は [implementation-status.md](./implementation-status.md) に従う／§3 の判定語定義に「実装済み・未配線」を追加した）。

> **本書が反映する到達点**: **4 クエスト（X / AI / Robo / Data）が同一フレームワークで実動**している。
> いずれも `QuestAdapter<NumericCandidate>` という同一契約で書かれ、`runQuest`→`numericOptimizer`（ヒルクライム）を
> **無改変で共有**する。クエストごとに差し替えるのは「候補キー・評価サイドカー（Python）・提出物整形」だけ。
> `taikai quest --quest xq|ai|robo|data` で 4 クエストを同じコマンドから回せる（§3.1）。

---

## 1. SBQ のクエストと狙い

SBQ は 1 大会の中に毛色の違う複数クエストが並ぶ。本ハーネスが標準化対象にするのは次の 4 種。
**Cyber は CTF 形式（脆弱性探索・フラグ奪取）で評価ループの形が他4つと根本的に異なるため、本ハーネスの標準化対象から除外**する（候補→評価→最適化の自動ループに乗らない＝別設計）。

| クエスト | 課題の型 | 狙い（本ハーネスで何を自動化するか） | 標準化対象 |
|---|---|---|---|
| **X Quest** | ゲームAI（不完全情報・対戦） | 探索パラメータを自己対戦の順位点で大量チューニングし、手動調整の壁を超える（7並べで実装・実動） | 済 |
| **AI Quest** | 機械学習モデリング | ハイパーパラメータを held-out 検証精度で最適化（数値トラック実動。approach の LLM 構造変異は将来） | 済 |
| **Data Quest** | データ分析・予測 | 特徴選択・前処理パラメータを held-out メトリクス（R^2）で最適化（数値トラック実動。コード生成の LLM 変異は将来） | 済 |
| **Robo Quest** | ロボ制御（シミュレータ） | 制御ゲインをシミュ報酬で最適化（数値トラック実動。方策骨子の LLM 変異は将来） | 済 |
| **Cyber Quest** | CTF（攻撃・防御） | — | 除外（CTF は自動探索ループの形が別。本ハーネスの標準化外） |

> **本ハーネスの価値（後述 §6）**: 個々のクエストに最強ソルバを 1 本ずつ書くのではなく、
> **4クエストを横断して 1 つの標準ループで殴る**点にある。二番煎じのソルバ寄せ集めではない。
> 「評価関数を差すだけで任意ドメインを自律最適化」が AI/Robo/Data の 3 クエストで実達成済み（§6）。

---

## 2. 標準化 — `候補 → 評価(fitness) → 最適化 → 提出`

毛色の違う4クエストは、抽象化すると**全く同じ4段ループ**に落ちる。

```
候補(candidate)  ──▶  評価器(evaluate)  ──▶  最適化(optimize)  ──▶  提出(submit ※レビューゲート)
   ▲                      │ fitness(大きいほど良い)        │
   └──────────────────────┴──── best を次の候補母集団へ ────┘
```

- **候補(candidate)** = そのクエストで「探索する対象」。X はゲーム AI のパラメータベクタ、AI はハイパラ、Robo は制御ゲイン、Data は特徴選択＋正則化パラメータ。
- **評価器(evaluate)** = 候補を 1 つ受け取り **fitness（スカラ、大きいほど良い）** を返す関数。LLM 非依存・決定的が理想。
  - direction が `min` の指標（誤差・距離）は**呼び出し側が符号反転して渡す**（評価器は max 方向に中立）。これは実装済み `numericOptimizer.ts` 冒頭コメントの規約と一致。
- **最適化(optimize)** = 評価器を多数回叩いて best を見つける。数値トラックは LLM 不要のコードで回す（D18①）。実動の本線は `numericOptimizer.ts` のヒルクライム＋ランダムリスタート。個体群ベースの本格 GA（`orchestrator/quest/populationGA.ts`）も純ロジックで実装済み（交叉・突然変異・エリート保存・決定的）だが、各クエストアダプタは現状ヒルクライム経路で配線している。構造変異（approach/コードを LLM が書き換える D18②）は将来統合。
- **提出(submit)** = best を大会提出形にアセンブル。**自動提出はしない**。`E_SUBMIT_GATE` でヒューマンレビューゲートに出す（[architecture.md](./architecture.md) エラー経路・R3）。

### 2.1 QuestAdapter 抽象（実装済み）

各クエストの差分はこの数点だけに閉じる。共通部（最適化器・CB・resume・provenance・leaderboard）は**全クエストで共有**する。

> **実装状況**: `orchestrator/quest/adapter.ts` は**実装済み**（`QuestAdapter<Candidate>` を named export）。
> 実行ループ `orchestrator/quest/runQuest.ts`、4 つの実アダプタ（`xqAdapter.ts` / `aiHyperoptAdapter.ts` /
> `roboControlAdapter.ts` / `dataInsightAdapter.ts`）も実装済みで vitest 緑。
> 下記シグネチャは**実物 `adapter.ts` の再掲**（提案ではなく現物）。
> `Params` / `EvaluateFn` / `OptimizeResult` / `optimize()` は `evolution/numericOptimizer.ts` の**実 export**、
> `Participant` / `ParticipantResult` / `runRoundRobin()` は `orchestrator/battle.ts` の**実 export**。
> アダプタはこれらを再利用し、共有ファイルは編集しない（CLAUDE.md／合成は import のみ）。

実物 `adapter.ts` は **EvalInput / toEvaluable / seedCandidates / assembleSubmission / StructEvaluateFn を一切持たない**。
候補は数値 Record 直結（`NumericCandidate = Record<string, number>`）で、`runQuest` が `mutateNumeric` を見て
`numericOptimizer.optimize` にそのまま橋渡しする。コード最適化（code_ref ベースの構造トラック）は**将来拡張**であり、
現契約には含まれない（無理に EvaluateFn に押し込む二系統化は採っていない）。

```ts
// 既存実装の実シグネチャ（再掲・編集禁止の共有層）
//   evolution/numericOptimizer.ts:
//     type Params = Record<string, number>;
//     type EvaluateFn = (params: Params) => Promise<number>;   // fitness, max 方向
//     interface OptimizeResult { best: Params; bestScore: number; evaluations: number;
//                                history: {iteration:number;score:number}[]; restarts: number }
//     function optimize(params0: Params, evaluate: EvaluateFn, opts: OptimizeOptions): Promise<OptimizeResult>
//   orchestrator/battle.ts:
//     interface Participant<S,M> { id: string; play: PlayFn<S,M> }
//     function runRoundRobin<S,M>(ps: Participant<S,M>[], matchFn: MatchFn<S,M>, rounds?: number): RoundRobinResult
//     interface ParticipantResult { id:string; record:{wins;losses;draws}; win_rate:number; opponents:string[] }

// 実物の横断抽象（orchestrator/quest/adapter.ts。default 禁止＝named export、.ts 拡張子 import 前提）

/**
 * 数値パラメータ候補。numericOptimizer.Params と構造的に同一（import せず再宣言＝共有 .ts は読むだけ）。
 * Candidate がこの形のとき runQuest は numericOptimizer をそのまま使う。
 */
export type NumericCandidate = Record<string, number>;

/** 1 クエストを「候補→評価→最適化→提出」に落とす差分の束。共通部は共有層（runQuest/optimize）が持つ。 */
export interface QuestAdapter<Candidate> {
  /** クエスト識別子（来歴・提出物のラベルに使う）。 */
  questId: string;

  /**
   * 数値候補のキー集合（探索するパラメータ名）。Candidate が NumericCandidate の
   * とき runQuest が初期点のキーとして使う。非数値クエストでは省略可。
   * exactOptionalPropertyTypes: 値があるときだけ載せる（undefined を載せない）。
   */
  paramKeys?: string[];

  /** 進化の出発点となる初期候補を返す（破壊されない前提で都度生成する）。 */
  initialCandidate(): Candidate;

  /**
   * 候補を採点する（= S6 評価関数）。**高いほど良い = fitness**（例: 勝率 0..1 / 精度 / R^2）。
   * 非同期（プログラム実行・対戦シミュレーションを伴うため）。決定的であること。
   * 数値候補は構造的に EvaluateFn=(Params)=>Promise<number> と一致し、optimize にそのまま渡せる。
   */
  evaluate(c: Candidate): Promise<number>;

  /**
   * 候補が数値 Record（{k:number}）として最適化可能か。true のとき runQuest は
   * numericOptimizer をそのまま使う。未指定/false なら汎用ループ（初期1点評価）で回す。
   * exactOptionalPropertyTypes: 値があるときだけ載せる。
   */
  mutateNumeric?: boolean;

  /**
   * 最良候補から提出物を組み立てて dir に書く（同期・ファイル生成のみ＝不可逆 submit/publish はしない）。
   */
  buildSubmission(best: Candidate, dir: string): void;
}
```

- **共通の最適化器**は `optimize()`（数値・実装済み）と、より強い `populationGA`（個体群ベース・実装済み・配線は将来）、そして LLM 構造変異（S5・将来）。`QuestAdapter` はそれを**呼ぶだけ**で、最適化ロジックを再実装しない（`runQuest` が橋渡し）。
- **位置づけ（Optuna/DEAP との違い）**: 本ハーネスは Optuna/DEAP のような「数値ハイパラ探索専用ライブラリ」ではない。コアは **評価関数（fitness を返す関数）を差し替えるだけで任意ドメインを自律最適化する汎用候補最適化器**で、(1) 数値ベクタ最適化（`numericOptimizer` / `populationGA`）、(2) ゲーム AI の自己対戦（X の `evaluate.py` が N 人卓 self-play を回す）、(3) 将来の LLM 構造変異（approach・コードを LLM が書き換える D18②）を**同一の `候補→評価→最適化→提出` ループに統合**することを狙う。Optuna/DEAP は (1) に閉じるが、本ハーネスは (1)(2) を実装済みで束ね、(3) を同じインタフェースに将来差し込む立て付けである。
- **「差分は数点だけに閉じる」の限界**: 評価器のコスト特性はクエストで桁違いになる。Data/AI のハイパラ評価は比較的軽い純数値だが、**X（7並べ）も Robo も評価本体は Python サイドカー（§5）に委譲され、`crawl.ts` 型の spawn / stdin / ハード timeout / 失敗時 partial を内包する非同期 I/O** になる（実際 4 アダプタとも `evaluate.py` を spawn する）。`evaluate(c) → Promise<number>` の型シグネチャは共通化できても、**実装コストと内部構造は均せない**。共通抽象の旨味は「最適化器・runQuest・provenance を全クエストで共有できる」点にあり、評価器の中身までは均らない。
- 対戦型クエスト（X）の評価器は LLM 非依存の数値トラック評価器として使える（[architecture.md](./architecture.md)「②対戦型は LLM 非依存の評価関数＝数値最適化トラックの評価器にそのまま使える」）。**ただし「対戦型＝そのまま `runRoundRobin` の `win_rate`」は2人対戦に限った話**。`jankenEvolve.ts`（2人じゃんけん）は `battle.ts` を import のみで合成した先行実証だが、**3-4人卓の7並べのような多人数同卓ゲームは2人専用の `runRoundRobin` には乗らない**。そこで X Quest は `battle.ts` を使わず、**Python エンジン側の self-play（`evaluate.py` の座席ローテ self-play）で N人同卓を1局として回し、着順加重の順位点を fitness として返す**実装を採った（§4.1）。

---

## 3. クエスト × 候補 × 評価器 × 最適化 対応表

| クエスト | 候補(candidate) | 評価器(fitness) | 最適化 | 実装の現在地 |
|---|---|---|---|---|
| **X**（ゲームAI） | 7並べ AI の**8 探索パラメータ**（ベクタ＝`NumericCandidate`） | **3人 self-play の着順加重 順位点**（`evaluate.py`：座席ローテで席バイアス除去、N人同卓1局を Python エンジンで回す。1着=1.0/最下位=0.0 の連続値で勾配を増やす） | **ヒルクライム+リスタート**（数値・LLM不要／D18①） | **実装・実動**: `engine.py`（本家準拠ルール）/`ai_param.py`（8 param AI）/`evaluate.py`（席ローテ self-play）＋`xqAdapter.ts`→`runQuest.ts`→`numericOptimizer`。`battle.ts`（2人総当たり）は7並べには使わず Python エンジン側で N人卓を実装。GA は populationGA.ts に実装済みだがアダプタ配線はヒルクライム。LLM 構造変異は未実装。**簡易 PIMC（決定化 MC）プレイヤー `ai_mc.py`＋評価器 `evaluate_mc.py` は実装済みだが orchestrator の数値トラックには未配線**（`xqAdapter` はヒューリスティック `evaluate.py` を spawn）。MC の対ヒューリスティック勝ち越し（win_rate>0.5）は seed・budget 依存で未確立（§4.2） |
| **AI**（ML） | **5 ハイパーパラメータ**（lr/reg/hidden/epochs/init_scale＝`NumericCandidate`） | **held-out 検証精度**（`evaluate.py`：seed 固定の合成 XOR 風データを train/held-out 分割、精度を fitness） | **ヒルクライム+リスタート**（数値・LLM不要／D18①。numericOptimizer 直結） | **実装・実動**: `quests/ai-hyperopt/evaluate.py`＋`aiHyperoptAdapter.ts`→`runQuest.ts`→`numericOptimizer`。xqAdapter と同一 `QuestAdapter<NumericCandidate>` 契約・最適化器無改変共有。LLM approach 変異ループは未実装（数値トラックのみ） |
| **Data**（分析） | **特徴選択＋正則化の 12 パラメータ**（sel_0..sel_9 の特徴選択重み＋sel_threshold＋ridge＝`NumericCandidate`） | **held-out 予測 R^2**（`evaluate.py`：seed 固定の合成テーブルで「効く特徴を選び・紛らわしいノイズ列を選ばない」質を held-out R^2 で測る。リーク無し＝標準化は train 統計のみ） | **ヒルクライム+リスタート**（数値・LLM不要／D18①。numericOptimizer 直結） | **実装・実動**: `quests/data-insight/evaluate.py`＋`dataInsightAdapter.ts`→`runQuest.ts`→`numericOptimizer`。xqAdapter と同一契約・最適化器無改変共有。分析コードを LLM が生成する構造変異は未実装（数値＝特徴選択トラックのみ） |
| **Robo**（制御） | **5 制御ゲイン**（kp_lin/kp_ang/kd_ang/align_thresh/v_cruise＝`NumericCandidate`） | **シミュ報酬**（`sim.py`：決定的 2 輪到達シミュ、`evaluate.py` が多エピソード平均報酬を fitness） | **ヒルクライム+リスタート**（数値・LLM不要／D18①。numericOptimizer 直結） | **実装・実動**: `quests/robo-control/{sim.py,evaluate.py}`＋`roboControlAdapter.ts`→`runQuest.ts`→`numericOptimizer`。xqAdapter と同一契約・最適化器無改変共有。方策骨子の LLM 変異は未実装（数値トラックのみ） |

判定語（[implementation-status.md](./implementation-status.md) と同義）:
- **実装・実動** = `outputs/`・`best_params.json` に実 run 成果物がある or テスト緑で配線済み（orchestrator の数値トラックに配線済み）。
- **実装済み・未配線** = 該当コードは実在し単体で実行可能だが、orchestrator の本経路（`taikai quest`）には繋がっていない。例: `orchestrator/quest/populationGA.ts`（個体群 GA）、`quests/xq-7narabe/ai_mc.py`（簡易 PIMC=決定化 MC プレイヤー `make_mc_ai`）＋`evaluate_mc.py`（その評価サイドカー）。これらは存在するが `xqAdapter` は `ai_param` ヒューリスティックを spawn するため、数値トラックには未配線。
- **未実装** = 設計はあるが該当コードが無い（AI/Robo/Data の LLM 構造変異ループ）。
  - 注: **簡易 PIMC（決定化 MC）プレイヤーは「未実装」ではなく「実装済み・未配線」**である（後述 §4.1・§4.2）。orchestrator が spawn するのは依然ヒューリスティック評価器（`evaluate.py`）であり、MC 評価器（`evaluate_mc.py`）は本経路に繋がっていない。

> **実装済み・未配線 成果物の一覧**（taikai quest の実経路と区別して提示）:
>
> | 成果物 | 種別 | 単体実行 | orchestrator 配線 | 状態 |
> |---|---|---|---|---|
> | `orchestrator/quest/populationGA.ts` | 個体群 GA（交叉・突然変異・エリート保存） | テスト緑 | 未（アダプタはヒルクライム経路） | 実装済み・未配線 |
> | `quests/xq-7narabe/ai_mc.py`（`make_mc_ai`） | 簡易 PIMC=決定化 MC プレイヤー | デモ実行可（`python ai_mc.py`） | 未（`xqAdapter` は `ai_param` を spawn） | 実装済み・未配線。勝ち越しは seed 依存で未確立 |
> | `quests/xq-7narabe/evaluate_mc.py` | 上記の対ヒューリスティック評価サイドカー | 実行可（stdin JSON） | 未（数値トラックは `evaluate.py` のみ） | 実装済み・未配線 |
>
> **taikai quest の実経路**は `xqAdapter → evaluate.py`（パラメータ化ヒューリスティックの着順加重 順位点）のみ。上の 3 つはこの経路に乗っていない。

### 3.1 共通コマンド — `taikai quest --quest xq|ai|robo|data`

4 クエストは**同一コマンド**から回せる。`--quest` でアダプタを選ぶだけで、実行ループ（`runQuest`）・
最適化器（`numericOptimizer`）・提出物書き出しは共通。

```bash
npm run taikai -- quest --quest xq    [--seed N] [--generations N]   # X Quest（7並べ）
npm run taikai -- quest --quest ai    [--seed N] [--generations N]   # AI Quest（ハイパラ）
npm run taikai -- quest --quest robo  [--seed N] [--generations N]   # Robo Quest（制御ゲイン）
npm run taikai -- quest --quest data  [--seed N] [--generations N]   # Data Quest（特徴選択）
```

- `index.ts` の `quest` ケースが `--quest` を見て対応アダプタ（`xqAdapter`/`aiHyperoptAdapter`/
  `roboControlAdapter`/`dataInsightAdapter`）を動的 import し、`runQuest(adapter, {seed, generations, submissionDir})` を呼ぶ。
- 出力: 初期 fitness → 探索後 best fitness を標準出力に出し、best 候補を `quests/<id>/best_params.json` に書く（`buildSubmission`）。
- **LLM CLI は一切不要**（数値トラックは純ロジック・決定的）。seed 固定で best/score まで完全再現する。

### 3.2 各 `quests/<id>/evaluate.py` の役割

各クエストの評価本体は Python サイドカーに置く。TS アダプタは spawn して stdin に 1 行 JSON を渡し、stdout の
`score`（または X の `win_rate`）を fitness として読むだけ。**4 つとも外部データセット・外部物理エンジンに依存しない自己完結**（seed 固定で bit 一致）。

| サイドカー | 入力（stdin 1 行 JSON） | 出力 fitness | 中身 |
|---|---|---|---|
| `quests/xq-7narabe/evaluate.py` | `{params,games,seed,opponents}` | `win_rate`（着順加重 順位点） | 7並べエンジンで N 人同卓 self-play を `games` 局回し、座席ローテで席バイアスを均し、着順を [0,1] 加重して返す |
| `quests/ai-hyperopt/evaluate.py` | `{params,seed}` | `score`（held-out 精度） | seed 固定の合成 XOR 風 2 クラス分類を生成し、numpy 自前の線形/MLP 分類器を学習、held-out 検証精度を返す |
| `quests/data-insight/evaluate.py` | `{params,seed}` | `score`（held-out R^2） | seed 固定の合成テーブル（真に効く 4 列＋紛らわしいノイズ列）で特徴選択→リッジ回帰当てはめ、held-out 予測 R^2 を返す |
| `quests/robo-control/evaluate.py` | `{params,episodes,seed}` | `score`（平均報酬） | 自前 2 輪到達シミュ（`sim.py`）を `episodes` 回走らせ、到達速度で単調化した報酬の平均を返す |

> **正直な区別**: 横断的に再利用できる共有部品は —
> ① `numericOptimizer.optimize()`（ヒルクライム＋ランダムリスタート、決定的・seed 固定）、
> ② `orchestrator/quest/{adapter,runQuest}.ts`（QuestAdapter 契約＋実行ループ。アダプタを差し替えれば新クエストに対応）、
> ③ `battle.runRoundRobin()`（**2人ペア**総当たり集計）、
> ④ `orchestrator/quest/populationGA.ts`（個体群 GA＝交叉・突然変異・エリート保存・決定的。実装済み・配線は将来）。
> ③ `runRoundRobin` は **2人対戦専用**であり、**3-4人卓の多人数同卓ゲーム（7並べ等）の卓内1局には使えない**。
> そのため X Quest は ③ を使わず、Python エンジン側の self-play（`evaluate.py`）で N人卓を実装した（§4.1）。
> 横断的に**無改変で**効くのは ①② で、評価器の中身（4 クエストとも Python サイドカー）はクエストごとに書く。
> この「①② 無改変共有・評価器だけ差し替え」が実際に**4 クエスト（X=ゲーム AI・AI=ML ハイパラ・Robo=ロボ制御・Data=分析/特徴選択）で達成済み**であり、§6 が主張する「横断ハーネスの汎用性」は実証されている。
> 一方、AI/Robo/Data の「LLM approach／コード変異ループ」は**まだコードに無い**（未実装）。
> **X の簡易 PIMC（決定化 MC）探索プレイヤーは別**で、`quests/xq-7narabe/ai_mc.py`（`make_mc_ai`）＋`evaluate_mc.py`（評価サイドカー）として**実装済み・単体実行可能**だが、**orchestrator の数値トラックには未配線**（`xqAdapter` はヒューリスティック `evaluate.py` を spawn する）。対ヒューリスティック勝ち越し（win_rate>0.5）は seed・budget 依存で**未確立**（§4.2）。
> （`numericOptimizer` は**GA ではなくヒルクライム**である点に注意。本格 GA は `populationGA.ts` に別実装があるが、各アダプタはヒルクライム経路で配線している。`populationGA` も実装済み・未配線。）
> `jankenEvolve.ts` は①③を合成した先行実証（**2人**じゃんけん／D18① デモ・本番未配線。N人卓は別物）。

---

## 4. 最初の具体例 — X Quest（7並べ）

> **題材選定の出所**: **7並べ／X Quest は本書の提案であり、正本（[architecture.md](./architecture.md)・[decisions.md](./decisions.md)）には未記載**。
> 題材は D8（対象大会確定）後に差し替え可能で、本節は確定仕様ではなく設計のたたき台として読むこと。

X Quest の題材として**7並べ**（不完全情報・多人数）を最初の具体例に置く。狙いは「**事前実行＝対戦本番前にオフラインで好きなだけ回せる**」性質を最大限使うこと。

### 4.1 勝ち筋（事前実行 = 時間制約なし → 大シミュ budget）

- 7並べは **PIMC**（Perfect Information Monte Carlo：相手手札を多数サンプリングして各サンプルで完全情報探索し集約）系が強い。PIMC は **1 手あたりのシミュレーション本数（budget）と決定パラメータ**が強さを決める。
- **本番の手番には時間制約がある**が、**パラメータ探索は事前にオフラインで回せる**（提出するのは「探索済みパラメータを積んだプレイヤー」）。
  → ここで本ハーネスの標準ループが効く：**自己対戦の順位点(fitness)を評価器に、パラメータを数万回チューニング**して、人手で決めた固定パラメータを**自動で超える**。
> **評価器の構造（実装済み）**: **7並べは多人数（3 人卓）ゲームであり、`battle.ts` の2人専用 `MatchFn`（`(a, b, round) => MatchOutcome`、2 つの `play` しか取らない）には乗らない**。`runRoundRobin` は C(n,2) の**2人ペア総当たり**であって、1候補を相手と**同卓させる N 人ゲーム1局**ではない。したがって「`runRoundRobin` の `win_rate` をそのまま fitness にできる」は7並べでは**成立しない**。
>
> - この問題は `runRoundRobin` 経由ではなく **Python エンジン側の self-play で解決済み**: `evaluate.py` が N人同卓1局を回す（`battle.ts` は共有・編集禁止なので、卓ロジックは Python サイドカーに置いた）。
> - `evaluate.py` は **座席ローテで座席バイアスを均す**: 局 `g` で候補を席 `g % players_num` に座らせ、決着順を取って fitness を返す。配り seed は `seed+g`、相手 random も `(seed,g)` から決定的に派生（同 seed で fitness bit 一致）。
> - **着順加重の順位点を fitness にする**: 3 人戦で「最初の 1 人だけ勝ち」の二値勝率は上限が約 1/N（≈0.33）に張り付き候補の識別力が弱い。そこで全席の決着順（着順）を取り、着順を [0,1] に加重（1 着=1.0／最下位=0.0）した連続値を `win_rate` フィールドとして返し、最適化の勾配を増やしている。
> - `runRoundRobin` の役割は7並べでは使わない（卓内1局を担えない2人専用ツールなので不採用）。`jankenEvolve` の「1 vs N」は **N 個の独立した2人マッチの平均**であり、7並べが要求する **N人同卓1ゲーム**とは別物（流用せず Python 側で実装した）。

- 評価器（N人同卓1局→順位点）は `evaluate.py` に実装済み。最適化は数値トラック（`optimize()`、決定的・seed 固定で再現）を**そのまま流用**している（`optimize` は fitness スカラしか見ないので評価器の中身に非依存）。TS 側 `xqAdapter.evaluate` が `evaluate.py` を spawn し、`runQuest`→`numericOptimizer` がパラメータを進化させる。

- **簡易 PIMC（決定化 MC）実装の現況と限界（`ai_mc.py`／`evaluate_mc.py`）**: §4.2 で参照する PIMC 系プレイヤーの簡易版が `quests/xq-7narabe/ai_mc.py`（`make_mc_ai`）として**実装済み・単体実行可能**で、対ヒューリスティック評価サイドカー `evaluate_mc.py` も揃っている（決定的・seed 固定で bit 一致）。ただし **(a) orchestrator の数値トラックには未配線**（`xqAdapter` は `evaluate.py`＝ヒューリスティックを spawn し、MC は本経路に乗らない）、**(b) 対ヒューリスティック勝ち越しが未確立**（プレイアウト方策が相手と同一 params のため 1 手読みの利得が席運・分散に埋もれ、**既定 seed=0 では win_rate≈0.43 で 0.5 を割る**。seed・budget で 0.5 前後に揺れる）。よって本ハーネスが taikai quest で実際に回すのは**ヒューリスティック数値トラックのみ**であり、MC プレイヤーの優位は本書では主張しない（実装の存在と未確立性を併記する正直版）。

```
[事前実行 / オフライン]                                  [本番]
8 param 候補 ──▶ N人同卓1局を回す self-play(evaluate.py,       ──▶ 順位点(fitness)
   ▲             座席ローテで座席バイアスを均す/engine)             │
   │             ※ 2人専用 runRoundRobin は使わず Python エンジンで実装 │
   └─ optimize() が best を探索（時間制約なし。xqAdapter→runQuest 経由）─┘
                              │
                              ▼ buildSubmission（探索済みパラメータを best_params.json に焼き込み）
                     提出プレイヤー（本番は探索済み値で即指す）
```

### 4.2 参照: hirorogo/singyura 2025 優勝（PIMC + 手動 700）

- 先行事例 **hirorogo/singyura（2025 優勝）** は **PIMC + 手動チューニングのシミュ 700 本**で勝った。これは「PIMC の強さは本数とパラメータで決まる」ことの実証であり、**手動 700 という固定値が上限になっていた**ことも示す。
- 本ハーネスの主張は単純：**その 700（手動値）を、自己対戦の順位点を fitness にした自動探索で超える**。事前実行に時間制約が無い以上、探索 budget を上げ、パラメータ空間を `optimize()` で舐めれば、手動調整の局所解を脱出できる（`numericOptimizer` のランダムリスタートが多峰性対策に効く）。

> **実装状況**: 7並べの評価ハーネス配線は**実装・実動**。`engine.py`（本家準拠ルール）・`ai_param.py`（8 param ヒューリスティック AI）・`evaluate.py`（席ローテ self-play）が揃い、TS 側 `xqAdapter.ts`→`runQuest.ts`→`numericOptimizer` で配線済み。`evaluate.py` は同 seed で fitness bit 一致、パラメータ感度あり（既定 win_rate 0.632／全係数 0 で 0.547／手調整で 0.682）。
> 共有の `numericOptimizer.optimize` は**そのまま再利用**（パラメータ探索＝評価器の中身に非依存）。
>
> **簡易 PIMC（決定化 MC）プレイヤーの現況（正直版・三層）**:
> 1. **実装済み**: `quests/xq-7narabe/ai_mc.py` の `make_mc_ai(params, sim_count, seed)` が決定化 Monte-Carlo（相手手札を未知札からサンプリングして各サンプルを完全情報プレイアウト→着順スコア集約）方策を返し、単体実行できる（`python ai_mc.py` のデモ／`evaluate_mc.py` の対ヒューリスティック評価サイドカー）。決定的（seed 固定で bit 一致）。
> 2. **未配線**: orchestrator の数値トラック（`taikai quest --quest xq`）が spawn するのは依然 `evaluate.py`（パラメータ化ヒューリスティック）であり、`xqAdapter` は `evaluate_mc.py`／`ai_mc.py` を呼ばない。MC プレイヤーは本経路に乗っていない。
> 3. **勝ち越し未確立**: 「MC がヒューリスティックに win_rate>0.5 で明確に勝ち越す」は**確定的には成立しない**。プレイアウト方策が相手と同一 params の `make_ai` で、1 手読みの利得が席運・分散に埋もれるため、**seed・budget により 0.5 前後で揺れる**。実測（games=60・sim_count=30、`evaluate_mc.py` 既定設定）: seed=0 → 約 0.43（FAIL）、seed=1 → 約 0.43（FAIL）、seed=2 → 約 0.52（辛うじて）。**既定 seed=0 では 0.5 を割る**。`evaluate_mc.py` の docstring が掲げる「win_rate>0.5 なら明確に勝ち越し」という確定的物言いは過大であり、正しくは「**複数 seed 平均で評価し、games を増やし、sim_count（budget）依存で勝ち越しが安定するかを実測すべき。単一既定 seed では 0.5 前後で割れる**」。
>
> したがって §4.2 冒頭の「手動 700 を自動探索で超える」物語の **MC 側裏付けは現状未確立**（評価ハーネス・8 param 探索・席ローテ・本番配線というヒューリスティック側の数値トラックは動いているが、MC プレイヤーの優位は seed 依存で確立していない）。

### 4.3 勝ち筋の現状（実測値・再現コマンド・正直版）

本節は X Quest の「勝ち筋」が**現状どこまで本物か**を、誇張せず実測値と再現コマンドで記録する。正は本節の数値（第三者が同コマンドで bit 一致再現できる）とし、§4.1/§4.2 の物語はこの実測の範囲で読むこと。詳細表は `quests/xq-7narabe/README.md` を参照。実測は 2026-06-13 の現リポジトリ状態（`ai_param.py default_params` が手調整で強化済み・`ai_medium.py` 追加済み）に対するもの。

**(1) `taikai quest --quest xq` が出す params の位置づけ（対 2025 手動値）。**
`taikai quest --quest xq --seed 42 --generations 15` を実行すると、初期点（`xqAdapter.initialCandidate`：`w_blocking:0.5`・`w_suit_balance:0.2`…＝**2025 優勝の思想を引いた弱い手動既定値**）から `numericOptimizer`（ヒルクライム）が探索し、探索済み best を `quests/xq-7narabe/best_params.json` に焼き込む（games=100・3 人卓・対 random）。**数値の正は焼き込み済み `best_params.json` を同一サイドカーで再採点した値**とする（TS orchestrator 経路は本節の範囲外で run の seed/generations を本文では確定できないため、本文に書く数値は run ログでなく**現物 `best_params.json` の再採点値**で固定する）。現 `best_params.json` を `evaluate.py` で**games=100・seed=0・対 random**で再採点すると **win_rate 0.750**、同条件の初期点 `initialCandidate` は **0.635**（＝**initial 0.635 → 焼き込み best 0.750**、下の再現コマンド (1') で bit 一致）。「自動探索が弱い初期点を引き上げた」と言えるのはこの差分まで。
- 2025 優勝は「PIMC + 手動 SIMULATION_COUNT=700」という**別アーキ（探索本数を手で決め打つ）**。本ハーネスの数値トラックが探索しているのは **PIMC の本数ではなく `ai_param.py` の 8 個のヒューリスティック係数**で、同じ土俵ではない。正直に主張できるのは「**自己対戦の順位点 fitness を使った自動探索が、弱い手動初期点（対 random 0.635）を 0.750 へ自動で引き上げた**」（games=100・seed=0・現 `best_params.json` 再採点）までで、「PIMC 700 という本番強者を超えた」ではない（本番相手＝PIMC は §4.2 の通り未配線）。

**(2) 探索後 best の頑健性 ＋ 重要な不整合（GA が手調整 default を超えていない）。**
現 GA best（`quests/xq-7narabe/best_params.json` — `w_suit_balance:1.23`・`w_release_urgency:1.14` 等を焼き込んだ現物。下表はこの**コミット済み現物**を再採点したもの）と、`ai_param.py` の**手調整済み `default_params()`**（`w_suit_balance:2.5` 等・README が 0.752 と謳う新既定）を、対 random・games=300・seed 0..3 で直接採点した実測（2026-06-13 の現リポジトリ状態）:

| 採点 seed | GA-best（現 best_params.json） | 手調整 default（ai_param） | 勝敗 |
|---|---|---|---|
| 0 | 0.745 | 0.752 | default |
| 1 | 0.712 | 0.700 | GA |
| 2 | 0.745 | 0.745 | 同点 |
| 3 | 0.742 | 0.757 | default |
| **平均** | **0.736** | **0.738** | ほぼ拮抗 |

→ **現状、自動探索の best（平均 0.736）は手調整 default（平均 0.738）と平均でほぼ拮抗（差 0.002）し、seed 別では 2 勝（default seed0,3）/ 1 勝（GA seed1）/ 1 分（seed2）**。GA は default を**明確には超えていない**（拮抗どまりで、依然 default 優位の seed が残る）。原因は**配線のズレ**: `xqAdapter.ts` の `initialCandidate`（探索の出発点）が **2025 由来の古い弱い値のまま**（games=100・seed=0 で 0.635）で、`ai_param.py` 側で後から強化された `default_params()`（同条件 0.752）と**同期していない**。GA は弱い出発点から登るので、手で強化済みの default をまだ確実には抜けない。`xqAdapter.ts` は共有 .ts（本担当は読むだけ・編集不可）なので、ここでは**事実として正直に記録するに留める**（initialCandidate の同期修正は adapter 担当の領域）。「探索後 0.74」を**手調整 default を超えた証拠として誇張してはいけない**（実測は拮抗で、超過は未確立）。なお下表の数値は再現コマンド (2) で現 `best_params.json` を再採点すれば bit 一致する。表を更新するときは `best_params.json` も同時に commit して整合させること。

**(3) 事前実行＝時間制約なし → 勝率を上げる道筋。**
オフラインで好きなだけ回せる以上、伸ばす手は明確: ① `--generations` を上げる（ヒルクライムの近傍評価回数）、② `xqAdapter.evaluate` 既定 `games`（現 100）を増やして fitness 分散を下げる、③ `restartAfter` を効かせて多峰性を脱出、④ 実装済み・未配線の `populationGA.ts`（個体群 GA）に切替えて popSize を上げる、⑤ **何より初期点を手調整 default に合わせ直す**（(2) の不整合解消が最優先・最大効果）。⑤ を直すだけで GA は 0.738 起点で 0.74+ を狙え、その後 ①〜④ の budget 増が効く。**現状の上限要因は budget 不足ではなく (2) の出発点ズレと (4-1) の評価相手の弱さ**である。

**(4) 現状の限界（正直に三点）。**
1. **評価器の相手が弱い**: `evaluate.py` の既定対戦相手は `random_action_fn`（ランダム手）。対 random 0.74 は「ランダムに強い」だけで本番の強い相手 AI への強さを保証しない。より手応えのある相手として `ai_medium.py`（固定中級ヒューリスティック）が追加され `--vs medium` で測れるが、**現既定 params の対 medium win_rate は 0.48（1 着率 0.323 ≒ 1/3）で拮抗どまり**＝強い相手には勝ち越せていない。`taikai quest` の本経路は対 random 固定で、medium を fitness にした探索は未配線。
2. **MC（簡易 PIMC）が 3 人卓で 0.5 を確立的には超えない**: `evaluate_mc.py`（既定 params・対ヒューリスティック ×2 の 3 人卓・MC が最強候補のはず）の win_rate は **seed・sim_count に依存して概ね 0.35〜0.53 に揺れ、単調でも安定 > 0.5 でもない**（games=30・seed=0 の 2026-06-13 再測で sim_count=10/30/100/200 が 0.500/0.500/0.400/0.433 と非単調・高 budget でも 0.5 割れ／games=20・seed=0・sim=150 で 0.35 まで沈む点もある。1 点が分オーダーで再測コスト大。値は単一 seed の一例・分散大）。「手単位では MC がヒューリスティックを上回る」検証はあるが、3 人卓の literal 勝率では「最強候補だが > 0.5 を安定保証できない」。`ai_mc.py`／`evaluate_mc.py` の docstring・README が掲げる「sim_count を上げれば単調に伸び明確に勝ち越す」は**過大**で、実測は非単調・seed 依存（§4.2 と整合）。
3. **本番の相手 AI が未知**: 本番で同卓する相手の強さ・方策は未知。現評価器（対 random／対自己ヒューリスティック／対 medium）はそのプロキシに過ぎず、本番勝率は本節の数値からは保証されない。**勝ち筋として確立しているのは「自動探索ループが弱い初期点を対 random で 0.635→0.750 へ自動改善する」配線と再現性まで**（games=100・seed=0・現 `best_params.json` 再採点・(1') で bit 一致）。その先（手調整 default 超え・強い相手超え・本番強者超え）は (2)(4-1) の通り**未確立**（default とは平均で拮抗・超過は未達）。

再現コマンド（すべて決定的・bit 一致。数値の正は**現物 `best_params.json` の再採点値**）:
```bash
# (1) 探索 run 自体（TS orchestrator 経路。best_params.json を書き換える。run の数値は本節の正ではない）
npm run taikai -- quest --quest xq --seed 42 --generations 15
# (1') (1) の主張「initial 0.635 → 焼き込み best 0.750」を現物で再採点（games=100・seed=0・対 random・bit 一致）
#      初期点 initialCandidate（0.635）:
echo '{"params":{"w_edge_distance":1.0,"w_blocking":0.5,"w_rank_extreme":0.3,"w_hold_seven_adj":0.4,"w_suit_balance":0.2,"w_pass_reserve":0.1,"w_release_urgency":0.6,"w_random_jitter":0.05},"games":100,"seed":0,"opponents":2}' | python quests/xq-7narabe/evaluate.py
#      焼き込み best（現 best_params.json, 0.750）:
python -c "import json;print(json.dumps({'params':json.load(open('quests/xq-7narabe/best_params.json')),'games':100,'seed':0,'opponents':2}))" | python quests/xq-7narabe/evaluate.py
# (2) GA-best と手調整 default を直接採点（games=300・seed 0..3。§4.3(2) の表を再現＝平均 0.736 vs 0.738 で拮抗）
for s in 0 1 2 3; do
  python -c "import json;print(json.dumps({'params':json.load(open('quests/xq-7narabe/best_params.json')),'games':300,'seed':$s,'opponents':2}))" | python quests/xq-7narabe/evaluate.py
  echo "{\"params\":{},\"games\":300,\"seed\":$s,\"opponents\":2}" | python quests/xq-7narabe/evaluate.py
done
# (4-1) 強い相手（固定中級ヒューリスティック）相手の既定 params 勝率（拮抗 0.48）
echo '{"params":{},"games":300,"seed":0,"vs":"medium"}' | python quests/xq-7narabe/evaluate.py
# (4-2) MC の対ヒューリスティック勝率（seed・sim_count で 0.35〜0.57 に揺れる。games=30・sim=100 で分オーダー）
echo '{"params":{},"games":30,"seed":0,"sim_count":100}' | python quests/xq-7narabe/evaluate_mc.py
```

---

## 5. 評価器の規約（横断共通）

全クエストの評価器が守る規約（既存 `numericOptimizer.ts` / `battle.ts` のコメント規約と一致）:

- **fitness は大きいほど良い（max 方向）。** `min` 指標は呼び出し側が符号反転。
- **`win_rate` をそのまま fitness にしない場合がある。** `battle.ts` の `win_rate` は `wins/(wins+losses+draws)` で**引き分けを分母に算入＝draw を敗扱い**。`jankenEvolve.ts` は**意図的にこれを使わず**、record から **draw=0.5 換算の独自集計**を再算出している。X Quest（7並べ）も `battle.ts` の `win_rate` をそのまま使わず、**着順から順位点を再算出**して返す（着順加重で勾配を増やす）。**引き分けや着順を持つゲームでは、`win_rate` をそのまま使わず record／座席結果から目的の指標を再算出する**こと。
- **決定的（seed 固定で完全再現）。** `Date.now` / `Math.random` 非依存。TS 側乱数は `numericOptimizer.createRng`（mulberry32）に統一。Python サイドカーは `np.random.default_rng(seed)` / `random.Random((seed, ...))` から決定的に派生し、`set` 反復順・`hash()`（`PYTHONHASHSEED`）に依存しない（str キー安定ソート）。
- **評価器・テストの改ざん禁止。** S6 採点前にテスト sha256 再ハッシュ検証（不一致＝`E_TEST_TAMPER` で失格）。報酬ハッキング対策（CLAUDE.md）。
- **Python サイドカーが要るクエスト**（4 クエスト全部）は `orchestrator/crawl.ts` の **spawn / stdin / ハード timeout / 純ロジック JSON→型 変換を named export** パターンに合わせる（`crawl()` と同形）。失敗は throw せず低 fitness（既定 0）を返し、1 候補の評価失敗で最適化ループを止めない（partial-first / CLAUDE.md）。

---

## 6. 価値の主張 — 二番煎じでないこと

- 個々のクエストには既に強いソルバが存在する（X の PIMC、AI/Data の AutoML 的手法、Robo の RL）。**それらを 1 本ずつ書き直すなら二番煎じ**。
- 本ハーネスの価値は **「1 大会・4クエストを横断して勝つ標準ハーネス」** という点に閉じる。差分を `QuestAdapter`（§2.1 の4点）に押し込み、**最適化器・CB・resume・provenance・leaderboard・レビューゲートを全クエストで共有**することで、
  - 新クエストへの対応 = adapter 1 本（候補/評価/橋渡し/提出）の追加に縮む、
  - 「どの戦略がどの大会指標でどう勝ったか」を **provenance.derived_from で横断追跡**できる（[architecture.md](./architecture.md) 来歴チェーン）、
  - SBQ の**複数クエスト合計点で勝つ**という大会構造に、ハーネス側が直接最適化を合わせられる。
- これは「最強の単機能ソルバ」ではなく「**最強の横断ハーネス**」を作るという立て付けであり、既存ソルバの寄せ集めとは目的が違う。**評価関数を差すだけで任意ドメインを自律最適化する汎用候補最適化器**であり、Optuna/DEAP のような数値探索専用ライブラリとは射程が違う（numeric × 自己対戦を実装済みで束ね、LLM 構造変異を同一インタフェースに将来統合する）。

> **現実の到達点（再掲・正直版）**: 横断ハーネスの**骨格（候補→評価→最適化→提出の4段）は実動** —
> `QuestAdapter` 抽象（`orchestrator/quest/adapter.ts`）・実行ループ（`runQuest.ts`）・数値最適化（`optimize`）が配線済みで、
> **X Quest（7並べ）・AI Quest（ai-hyperopt）・Robo Quest（robo-control）・Data Quest（data-insight）の 4 クエストが end-to-end 実装・実動**:
> X=`engine.py`/`ai_param.py`/`evaluate.py`＋`xqAdapter`（8 param・着順加重 順位点）、
> AI=`ai-hyperopt/evaluate.py`（5 ハイパラ・held-out 精度）＋`aiHyperoptAdapter`、
> Robo=`robo-control/{sim.py,evaluate.py}`（5 制御ゲイン・シミュ報酬）＋`roboControlAdapter`、
> Data=`data-insight/evaluate.py`（特徴選択 12 param・held-out R^2）＋`dataInsightAdapter`。
> 4 アダプタとも **同一の `QuestAdapter<NumericCandidate>` 契約**で、`runQuest`→`numericOptimizer` を**無改変共有**する
> （＝本節が主張する「横断ハーネスの汎用性／評価関数を差すだけで自律最適化」が 4 クエストで実達成）。`taikai quest --quest xq|ai|robo|data` で同一コマンドから回せる。
> 実測（同一フレームワーク・seed 固定）— X: 初期点 0.635 → 焼き込み best 0.750（games=100・seed=0・対 random・現 `best_params.json` 再採点。§4.3(1') で bit 一致）、AI: 0.475 → 0.717、Robo: 0.813 → 0.922。
> Data は held-out R^2 に明確な勾配（既定 ≈ 0 ＝特徴未選択の定数予測 → 真に効く 4 列だけ選ぶと ≈ 0.97、全列だと 0.79 でノイズ列が過適合）があり、最適化器が特徴選択を進める余地がある（数値は `quests/data-insight/README` を正とする）。
> **再現性の但し書き**: 数値の正は **TS run のログではなく、焼き込み済み `quests/<id>/best_params.json` を各サイドカーで再採点した値**とする（run の seed/generations が本文に無くても、現物 `best_params.json` を固定 seed/games で再採点すれば第三者が bit 一致再現できる）。**X（7並べ）はこの方式で本文に固定済み**: 初期点 0.635／焼き込み best 0.750 はいずれも games=100・seed=0・対 random で現物再採点と bit 一致（§4.3 再現コマンド (1')）。GA-best vs default の比較表も games=300・seed 0..3 で現 `best_params.json` を再採点すれば §4.3(2) と一致する。**表や本文の探索後数値を更新するときは `best_params.json` も同時に commit し、再採点で一致する状態を保つこと**（数値だけ先に古くならないようにする）。AI/Robo/Data の探索後値も同様に各 `quests/<id>/README` の再採点コマンドを正とし、`best_params.json` と整合する seed を併記する。
> N人同卓は `runRoundRobin`（2人専用）ではなく Python エンジン側 self-play で実装した。
> 一方 **AI/Robo/Data の LLM approach／コード変異ループは未実装**（4 クエストとも数値トラックのみ。本格 GA は `populationGA.ts` に実装済みだがアダプタはヒルクライム配線＝実装済み・未配線）。
> **X の簡易 PIMC（決定化 MC）プレイヤー `ai_mc.py`／`evaluate_mc.py` は実装済みだが数値トラックに未配線**で、対ヒューリスティック勝ち越しは seed 依存で未確立（§4.2）＝「実装済み・未配線」カテゴリ。
> 本書は実装済み部分（QuestAdapter＋4 クエストの数値トラック）と実装済み・未配線部分（`populationGA`／簡易 PIMC `ai_mc`+`evaluate_mc`）と未実装部分（LLM 構造変異）を区別して書いており、
> **実装済みを未実装と過小申告しない／未実装を実装済みと誇張しない**双方向で誠実であることを宣言する。

---

## 7. コオエボリューション（self-play coevolution）— 固定 fitness のその先

> **本節の位置づけ（正直版）**: 本節は **設計と原理の記述**であり、`taikai coevolve` コマンドおよびコオエボリューション・ループの orchestrator 配線は**未実装**（別途配線予定）。
> ただし §7.4 が依拠する「相手＝`ai_param` ベースのヒューリスティックである」「`evaluate.py` は固定相手（random / 自己同 params / medium）に対する順位点を返す」という現状は実コード（`quests/xq-7narabe/{ai_param,evaluate,ai_medium}.py`）で確認済みの事実。
> 実装後に §7.5 の枠へ実測値を入れる前提で、現時点の数値主張は §4.3 の固定 fitness 実測（initial 0.635 → best 0.750・対 random）に閉じる。コオエボリューションの優位は**まだ実証していない**（誇張しない）。

### 7.1 プラトーの原因 — 固定の弱い相手は信号が足りない

§4.3 の実測は「自動探索が弱い初期点（対 random 0.635）を 0.750 へ引き上げた」までで止まり、**手調整 default（平均 0.738）を明確には超えられていない**（§4.3(2)）。この頭打ち（プラトー）の主因は budget 不足ではなく、**評価器の相手が固定で弱い**ことにある。

- **対 random（既定）**: ランダム手相手の勝率は「ランダムに強い」だけで、本番の強い相手 AI への強さを保証しない（§4.3(4-1)）。一定以上強くなると候補間の差が random 相手では出なくなり、fitness が飽和して勾配が消える。
- **対自己同 params（self-play）**: 候補も相手も同じ係数で動くため、相手が候補と一緒に強くなりも弱くなりもしない。1 手読みの利得が席運・分散に埋もれ、信号が弱い（MC が 0.5 を割る §4.2 と同じ構造）。
- **対 medium（固定中級）**: `ai_medium.py` は強い相手だが**固定**。一度それを上回る係数が見つかれば、その先は medium が伸びないので fitness が再び飽和する。

固定の相手は「ある強さの天井」を持ち、候補がそこに届くと**それ以上の差を生む信号が出なくなる**。これがプラトーの本質＝**信号不足**である。固定 fitness（§2 の `候補→評価→最適化→提出`）は、評価器が定数の地形を持つ前提で、その地形の最高点に登れば終わる。

### 7.2 それを破る原理 — self-play coevolution（軍拡競争）

コオエボリューションは**評価器の地形そのものを動かす**。固定の相手ではなく、**現チャンピオン（これまでの最強候補）を相手にして、それに勝てる挑戦者だけを次のチャンピオンに昇格させる**。

```
[固定 fitness]                          [coevolution（軍拡競争）]
候補 ──▶ 固定の相手で採点 ──▶ best       候補 ──▶ 現チャンピオンと対戦 ──▶ 勝てたら昇格
         （地形は不変）                          （勝つたびに相手＝地形が強くなる）
         登り切ったら終わり（飽和）                相手も強くなり続ける＝飽和しない
```

- **昇格条件**: 挑戦者が現チャンピオンに対して明確に勝ち越す（例 win_rate > 0.5 + マージン）ときだけ、挑戦者を新チャンピオンにする。勝てなければチャンピオンは据え置き。
- **軍拡競争（arms race）**: 昇格が起きると次の挑戦者は**より強い相手**と戦うことになる。相手が強くなるので、それを超えるにはさらに強い係数が要る。これが繰り返されると、固定相手では出なかった「強い候補同士でしか出ない差」が信号として供給され続け、プラトーを破る余地が生まれる。
- **なぜ信号が枯れないか**: 相手が固定なら「もう倒した」で勾配が消えるが、相手が**自分の進歩に追従して強くなる**ので、常に「あと一歩で勝てる/負ける」境界に評価が置かれ、勾配が残りやすい。これが self-play coevolution の核心。

> **注意（過信しない）**: 軍拡競争は**自動的に強くなることを保証しない**。よく知られた失敗モード — (a) **循環（intransitivity）**: A が B に勝ち B が C に勝つが C が A に勝つ三すくみで、強さが堂々巡りして進歩しない、(b) **忘却（forgetting）**: 新チャンピオンが旧チャンピオンへの強さを失い、過去の相手に負け越す退行、(c) **共謀的退化**: 双方が「戦わない/楽な手」へ縮退して見かけ上の勝率だけ動く — がある。緩和には**チャンピオンのアーカイブ（過去世代を相手プールに残す）／複数チャンピオン保持／勝率にマージンと最小対戦数を課す**等が要る。これらは実装で初めて効くか検証する（§7.5 の枠）。

### 7.3 使い方 — `taikai coevolve --quest xq`（未実装・配線予定）

> **未実装**: 下記コマンドは**まだ存在しない**（`index.ts` の switch は現在 `probe/run/doctor/status/evolve/experiment/quest/loop` の 8 コマンドで `coevolve` は無い）。本節は配線後の使い方の**契約案**であり、配線は別担当が行う。

固定 fitness の `taikai quest`（§3.1）と対になる、軍拡競争トラックの想定コマンド:

```bash
# 固定 fitness（既存・実動）: 固定の相手（random）に対して順位点を最大化
npm run taikai -- quest    --quest xq [--seed N] [--generations N]
# coevolution（未実装・配線予定）: 現チャンピオンを相手に、勝てる挑戦者だけ昇格
npm run taikai -- coevolve --quest xq [--seed N] [--generations N] [--promote-margin 0.05] [--archive-size 8]
```

- `--quest xq`: コオエボリューション対象のクエスト（当面 X=7並べのみ。AI/Robo/Data は固定 fitness が自然で、自己対戦の相手概念が無いため対象外）。
- `--promote-margin`（想定）: 挑戦者が現チャンピオンを「明確に」上回ったと見なす勝率マージン（席運・分散ノイズで誤昇格しないため）。
- `--archive-size`（想定）: 相手プールに残す過去チャンピオン数（忘却＝退行の緩和。0 なら最新チャンピオンのみ＝忘却に弱い）。
- 出力（想定）: チャンピオン系列（昇格ログ）と最終チャンピオンの `best_params.json`。固定 fitness と同じく `buildSubmission` でファイル生成のみ（不可逆 submit はしない＝CLAUDE.md レビューゲート）。
- 評価本体は既存の Python サイドカー（`evaluate.py`）を**相手にチャンピオン params を差して**回す形を想定。現 `evaluate.py` は相手が `random`／自己同 params／`medium` 固定なので、**「任意 params の相手を立てる」入力契約の拡張が配線時に要る**（現状の `vs` は種別スイッチのみで、任意の係数ベクタを相手に据える口は無い）。

### 7.4 これが FunSearch / AlphaEvolve の核 — 進化する相手/評価器に対して最適化

固定 fitness の quest（§2）と coevolution の本質的な違いは、**最適化が向き合う対象が定数か、進化する関数か**にある。

- **固定 fitness（§2・実動）**: 評価器 `evaluate(c) → fitness` は**定数の地形**。最適化はその地形の最高点を探すだけ。Optuna/DEAP の数値探索と同じ射程で、本ハーネスの 4 クエスト（X/AI/Robo/Data）はここで実動している（§6）。
- **coevolution（本節・未実装）**: 評価器が**自分の進歩に応じて変化する**。`evaluate(c) → fitness` の中の「相手」が、過去の自分（チャンピオン）になる。これは FunSearch / AlphaEvolve が体現する「**進化する評価器/相手に対して最適化する**」パラダイムの最小形である。
  - FunSearch / AlphaEvolve は LLM が候補プログラムを変異させ、評価器が選別する進化ループ。本ハーネスの D18② LLM 構造変異（未実装・§2）はこの系譜にある。
  - coevolution はそれと**直交する**もう一軸 ——「相手/評価器そのものを進化させる」—— を、LLM を使わず数値トラックだけで先に踏める点（self-play なら相手は過去の自分なので外部の強い相手を用意しなくてよい）。
- **違いの要点**: 固定 fitness は「定義済みの良さ」を最大化する。coevolution は「良さの基準（相手）」を進化と一緒に押し上げる。後者は本ハーネスが「Optuna/DEAP のような数値探索専用ライブラリではない」（§2.1）と主張する射程の、もう一つの裏付けになる**想定**である（実証は §7.5 待ち）。

### 7.5 現状の限界（正直に）と実測の枠

コオエボリューションは原理として有望だが、**現時点で本ハーネスでは未実証**である。誇張せず限界を明記する。

1. **相手が `ai_param` ベースで本番の未知 AI ではない**: self-play coevolution のチャンピオンは結局 `ai_param.py` の 8 係数ヒューリスティック方策である（`make_ai` の係数を変えるだけで、方策の表現力自体は固定）。**本番で同卓する相手の強さ・方策は未知**（§4.3(4-3)）で、`ai_param` 空間内で軍拡競争して強くなっても、その強さが**表現力の天井（8 係数ヒューリスティックで表せる範囲）**を超えることはない。PIMC（§4.2）のような探索ベース方策を相手/候補にできれば天井は上がるが、`ai_mc.py` は未配線で勝ち越し未確立（§4.2）。
2. **計算量が大きい**: 固定 fitness は 1 候補あたり games 局（既定 100）で済むが、coevolution は **昇格判定のたびに「挑戦者 × チャンピオン（＋アーカイブ）」の対戦**が要り、世代×個体×アーカイブ数ぶん対戦数が乗算で増える。§4.3(4-2) の通り 7並べ 1 局の採点は分オーダーになりうるので、対戦数の爆発は実時間で効く。事前実行＝時間制約なし（§4.1）とはいえ、固定 fitness より桁で重い。
3. **退行・循環のリスク**（§7.2 注）: 軍拡競争は自動で単調改善しない。忘却・循環・共謀的退化を緩和する仕組み（アーカイブ／マージン／最小対戦数）が効くかは実装して初めて分かる。
4. **未配線**: §7.3 のコマンド・ループは未実装。現状 `taikai` で実際に回せるのは固定 fitness の `quest` のみ。

**実測の枠（実装後に埋める。現時点は空欄＝未測定）**:

| 指標 | 固定 fitness（実測・§4.3） | coevolution（未測定・実装後に記入） |
|---|---|---|
| 対 random win_rate（games=100・seed=0・現物再採点） | initial 0.635 → best 0.750 | （未測定） |
| 対 medium win_rate（games=300・seed=0） | 既定 params 0.48（拮抗どまり・§4.3(4-1)） | （未測定） |
| 最終チャンピオンの対 medium 勝率 | —（coevolution 専用指標） | （未測定） |
| 昇格回数 / 総世代 | — | （未測定） |
| 退行（旧チャンピオンへの負け越し）有無 | — | （未測定） |
| 1 run あたり総対戦局数（計算量） | games×評価回数 | （未測定・固定 fitness より桁で多い見込み） |

> 実装後、§4.3 と同じ流儀で **現物 `best_params.json`（または champion 系列）を固定 seed/games で再採点した値**を正とし、第三者が bit 一致再現できる再現コマンドを併記する。**「coevolution が固定 fitness を超えた」は、この表が埋まり対 medium 等の独立指標で上回りが確認できるまで主張しない。**

---

## 関連
- [architecture.md](./architecture.md) — S6 の2評価モード（test/battle）・データ契約・来歴・エラー経路
- [decisions.md](./decisions.md) — D8 対象大会（SBQ＋ハッカソン）・D18 進化2トラック・R3 提出ゲート
- [implementation-status.md](./implementation-status.md) — 実装/テストのみ/未配線/未検証の正直な棚卸し（判定語の正本）
- 実コード（横断ハーネス）: `orchestrator/quest/adapter.ts`（`QuestAdapter<Candidate>`/`NumericCandidate`）, `orchestrator/quest/runQuest.ts`（実行ループ・数値は numericOptimizer 直結）, `orchestrator/quest/populationGA.ts`（個体群 GA・実装済み）
- 実コード（4 アダプタ）: `orchestrator/quest/{xqAdapter,aiHyperoptAdapter,roboControlAdapter,dataInsightAdapter}.ts`（いずれも Python サイドカー spawn・`QuestAdapter<NumericCandidate>` 契約）
- 実コード（X Quest=7並べ）: `quests/xq-7narabe/engine.py`（本家準拠ルール）, `ai_param.py`（8 param ヒューリスティック AI）, `evaluate.py`（席ローテ self-play 評価器）, `test_engine.py`（pytest）
- 実コード（AI/Robo/Data サイドカー）: `quests/ai-hyperopt/evaluate.py`（合成分類・held-out 精度）, `quests/robo-control/{sim.py,evaluate.py}`（2 輪到達シミュ・平均報酬）, `quests/data-insight/evaluate.py`（特徴選択・held-out R^2）
- 実コード（共有層）: `evolution/numericOptimizer.ts`（`optimize`/`EvaluateFn`/`Params`）, `orchestrator/battle.ts`（`runRoundRobin`/`Participant`／2人専用）, `evolution/jankenEvolve.ts`（①③合成の2人デモ）, `orchestrator/crawl.ts`（Python サイドカー spawn パターン）
