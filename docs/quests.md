# 標準化AIフレームワーク — シンギュラリティバトルクエスト横断ハーネス

シンギュラリティバトルクエスト（以下 SBQ）の **5クエストを 1 つの標準ハーネスで横断して攻略する**ための設計ドキュメント。
正本は [architecture.md](./architecture.md)（S6 の2評価モード・データ契約）と [decisions.md](./decisions.md)（D8 対象大会・D18 進化2トラック）。
本書は「各クエストを共通の `候補→評価→最適化→提出` に落とす標準化（**QuestAdapter** 抽象）」を定義し、
**実装済み（`orchestrator/quest/{adapter,runQuest,xqAdapter,aiHyperoptAdapter,roboControlAdapter}.ts` / `quests/{xq-7narabe,ai-hyperopt,robo-control}/*` / `evolution/numericOptimizer.ts` / `orchestrator/battle.ts`）と未実装（Data の評価器、AI/Robo の GA・LLM 変異）を厳密に区別**する（実装済みを過小申告せず、未実装を誇張しない。判定語は [implementation-status.md](./implementation-status.md) に従う）。

---

## 1. SBQ の5クエストと狙い

SBQ は 1 大会の中に毛色の違う複数クエストが並ぶ。本ハーネスが対象にするのは次の 5 種。
**Cyber は CTF 形式（脆弱性探索・フラグ奪取）で評価ループの形が他4つと根本的に異なるため、本ハーネスの標準化対象から除外**する（候補→評価→最適化の自動ループに乗らない＝別設計）。

| クエスト | 課題の型 | 狙い（本ハーネスで何を自動化するか） | 標準化対象 |
|---|---|---|---|
| **X Quest** | ゲームAI（不完全情報・対戦） | 探索パラメータを自己対戦勝率で大量チューニングし、手動調整の壁を超える（7並べで実装・実動） | 済 |
| **AI Quest** | 機械学習モデリング | ハイパーパラメータ＋前処理を検証精度で最適化、approach は LLM が構造変異 | 済 |
| **Data Quest** | データ分析・予測 | 分析/特徴量コードを LLM が大量生成し、held-out メトリクスで選抜 | 済 |
| **Robo Quest** | ロボ制御（シミュレータ） | 制御方策をシミュ報酬で評価、LLM が方策骨子・数値最適化がゲイン | 済 |
| **Cyber Quest** | CTF（攻撃・防御） | — | 除外（CTF は自動探索ループの形が別。本ハーネスの標準化外） |

> **本ハーネスの価値（後述 §6）**: 個々のクエストに最強ソルバを 1 本ずつ書くのではなく、
> **4クエストを横断して 1 つの標準ループで殴る**点にある。二番煎じのソルバ寄せ集めではない。

---

## 2. 標準化 — `候補 → 評価(fitness) → 最適化 → 提出`

毛色の違う4クエストは、抽象化すると**全く同じ4段ループ**に落ちる。

```
候補(candidate)  ──▶  評価器(evaluate)  ──▶  最適化(optimize)  ──▶  提出(submit ※レビューゲート)
   ▲                      │ fitness(大きいほど良い)        │
   └──────────────────────┴──── best を次の候補母集団へ ────┘
```

- **候補(candidate)** = そのクエストで「探索する対象」。X はパラメータベクタ、AI はハイパラ、Data は分析コード、Robo は制御方策。
- **評価器(evaluate)** = 候補を 1 つ受け取り **fitness（スカラ、大きいほど良い）** を返す関数。LLM 非依存・決定的が理想。
  - direction が `min` の指標（誤差・距離）は**呼び出し側が符号反転して渡す**（評価器は max 方向に中立）。これは実装済み `numericOptimizer.ts` 冒頭コメントの規約と一致。
- **最適化(optimize)** = 評価器を多数回叩いて best を見つける。数値=ヒルクライム/GA（LLM不要・D18①）、構造=LLM 変異（D18②）。
- **提出(submit)** = best を大会提出形にアセンブル。**自動提出はしない**。`E_SUBMIT_GATE` でヒューマンレビューゲートに出す（[architecture.md](./architecture.md) エラー経路・R3）。

### 2.1 QuestAdapter 抽象（実装済み）

各クエストの差分はこの数点だけに閉じる。共通部（最適化器・CB・resume・provenance・leaderboard）は**全クエストで共有**する。

> **実装状況**: `orchestrator/quest/adapter.ts` は**実装済み**（`QuestAdapter<Candidate>` を named export）。
> 実行ループ `orchestrator/quest/runQuest.ts`、X Quest の実アダプタ `orchestrator/quest/xqAdapter.ts` も実装済みで vitest 緑。
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
   * 候補を採点する（= S6 評価関数）。**高いほど良い = fitness**（例: 勝率 0..1 / 精度）。
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

- **共通の最適化器**は `optimize()`（数値・実装済み）と LLM 構造変異（S5）。`QuestAdapter` はそれを**呼ぶだけ**で、最適化ロジックを再実装しない（`runQuest` が橋渡し）。
- **「差分は数点だけに閉じる」の限界**: 評価器のコスト特性はクエストで桁違いになる。AI のハイパラ評価は同期的な純ロジックに近いが、**X（7並べ）も Robo も評価本体は Python サイドカー（§5）に委譲され、`crawl.ts` 型の spawn / stdin / ハード timeout / 失敗時 partial を内包する非同期 I/O** になる（実際 `xqAdapter.evaluate` は `evaluate.py` を spawn する）。`evaluate(c) → Promise<number>` の型シグネチャは共通化できても、**実装コストと内部構造は均せない**（X/Robo は内部でサイドカー spawn を抱える）。共通抽象の旨味は「最適化器・runQuest・provenance を全クエストで共有できる」点にあり、評価器の中身までは均らない。
- 対戦型クエスト（X）の評価器は LLM 非依存の数値トラック評価器として使える（[architecture.md](./architecture.md)「②対戦型は LLM 非依存の評価関数＝数値最適化トラックの評価器にそのまま使える」）。**ただし「対戦型＝そのまま `runRoundRobin` の `win_rate`」は2人対戦に限った話**。`jankenEvolve.ts`（2人じゃんけん）は `battle.ts` を import のみで合成した先行実証だが、**3-4人卓の7並べのような多人数同卓ゲームは2人専用の `runRoundRobin` には乗らない**。そこで X Quest は `battle.ts` を使わず、**Python エンジン側の self-play（`evaluate.py` の座席ローテ self-play）で N人同卓を1局として回し、勝率を fitness として返す**実装を採った（§4.1）。さらに `jankenEvolve` も `win_rate` を**そのままは使っていない**点に注意（draw=0.5 換算の独自集計／後述 §5）。

---

## 3. クエスト × 候補 × 評価器 × 最適化 対応表

| クエスト | 候補(candidate) | 評価器(fitness) | 最適化 | 実装の現在地 |
|---|---|---|---|---|
| **X**（ゲームAI） | 7並べ AI の**8 探索パラメータ**（ベクタ＝`NumericCandidate`） | **3人 self-play の勝率**（`evaluate.py`：座席ローテで席バイアス除去、N人同卓1局を Python エンジンで回す） | **ヒルクライム+リスタート**（数値・LLM不要／D18①） | **実装・実動**: `engine.py`（本家準拠ルール）/`ai_param.py`（8 param AI）/`evaluate.py`（席ローテ self-play）＋`xqAdapter.ts`→`runQuest.ts`→`numericOptimizer`。pytest 22 件（`test_engine.py`+`test_ai_param.py`）・quest 横断ハーネス vitest 87 件緑、同 seed で win_rate bit 一致。`battle.ts`（2人総当たり）は7並べには使わず Python エンジン側で N人卓を実装。GA（交叉/個体群）は未実装 |
| **AI**（ML） | **5 ハイパーパラメータ**（lr/reg/hidden/epochs/init_scale＝`NumericCandidate`） | **held-out 検証精度**（`evaluate.py`：seed 固定の合成データを train/held-out 分割、精度を fitness） | **ヒルクライム+リスタート**（数値・LLM不要／D18①。numericOptimizer 直結） | **実装・実動**: `quests/ai-hyperopt/evaluate.py`＋`aiHyperoptAdapter.ts`→`runQuest.ts`→`numericOptimizer`。xqAdapter と同一 `QuestAdapter<NumericCandidate>` 契約・最適化器無改変共有。GA・LLM approach 変異ループは未実装（数値トラックのみ） |
| **Data**（分析） | **分析コード**（特徴量・前処理・モデル） | **held-out メトリクス**（リーク無し検証） | **LLM**（S5 コード生成＝構造変異／D18②） | S5 コード生成ループは縦串で実動（fizzbuzz/roman）。**Data 固有の held-out 評価器は未実装** |
| **Robo**（制御） | **5 制御ゲイン**（kp_lin/kp_ang/kd_ang/align_thresh/v_cruise＝`NumericCandidate`） | **シミュ報酬**（`sim.py`：決定的 2 輪到達シミュ、`evaluate.py` が多エピソード平均報酬を fitness） | **ヒルクライム+リスタート**（数値・LLM不要／D18①。numericOptimizer 直結） | **実装・実動**: `quests/robo-control/{sim.py,evaluate.py}`＋`roboControlAdapter.ts`→`runQuest.ts`→`numericOptimizer`。xqAdapter と同一契約・最適化器無改変共有。方策骨子の LLM 変異・GA は未実装（数値トラックのみ） |

判定語（[implementation-status.md](./implementation-status.md) と同義）:
- **実装・実動** = `outputs/` に実 run 成果物がある or テスト緑で配線済み。
- **未実装** = 設計はあるが該当コードが無い（評価器・最適化器の中身）。

> **正直な区別**: 横断的に再利用できる共有部品は —
> ① `numericOptimizer.optimize()`（ヒルクライム＋ランダムリスタート、決定的・seed 固定）、
> ② `orchestrator/quest/{adapter,runQuest}.ts`（QuestAdapter 契約＋実行ループ。アダプタを差し替えれば新クエストに対応）、
> ③ `battle.runRoundRobin()`（**2人ペア**総当たり集計＋じゃんけん優劣表）。
> ③ `runRoundRobin` は **2人対戦専用**であり、**3-4人卓の多人数同卓ゲーム（7並べ等）の卓内1局には使えない**。
> そのため X Quest は ③ を使わず、Python エンジン側の self-play（`evaluate.py`）で N人卓を実装した（§4.1）。
> 横断的に**無改変で**効くのは ①② で、評価器の中身（X/AI/Robo はそれぞれ Python サイドカー、Data は各メトリクス）はクエストごとに書く。
> この「①② 無改変共有・評価器だけ差し替え」が実際に**3 クエスト（X=ゲーム AI・AI=ML ハイパラ・Robo=ロボ制御）で達成済み**であり、§6 が主張する「横断ハーネスの汎用性」は AI/Robo で実証されている。
> X/AI/Robo の 3 クエストは**実装・実動**（X=`engine.py`/`ai_param.py`/`evaluate.py`＋`xqAdapter`、AI=`ai-hyperopt/evaluate.py`＋`aiHyperoptAdapter`、Robo=`robo-control/{sim.py,evaluate.py}`＋`roboControlAdapter`、いずれも→`runQuest`→`numericOptimizer`。xq pytest 22／quest 横断ハーネス vitest 87 緑）。
> 一方、**Data Quest の held-out 評価器**、および AI/Robo の「LLM approach 変異ループ」「GA」は**まだコードに無い**（`numericOptimizer` は**GA ではなくヒルクライム**である点に注意。AI/Robo は数値トラックのみ実装）。`jankenEvolve.ts` は①③を合成した先行実証（**2人**じゃんけん／D18① デモ・本番未配線。N人卓は別物）。

---

## 4. 最初の具体例 — X Quest（7並べ）

> **題材選定の出所**: **7並べ／PIMC／X Quest は本書の提案であり、正本（[architecture.md](./architecture.md)・[decisions.md](./decisions.md)）には未記載**。
> 題材は D8（対象大会確定）後に差し替え可能で、本節は確定仕様ではなく設計のたたき台として読むこと。

X Quest の題材として**7並べ**（不完全情報・多人数）を最初の具体例に置く。狙いは「**事前実行＝対戦本番前にオフラインで好きなだけ回せる**」性質を最大限使うこと。

### 4.1 勝ち筋（事前実行 = 時間制約なし → 大シミュ budget）

- 7並べは **PIMC**（Perfect Information Monte Carlo：相手手札を多数サンプリングして各サンプルで完全情報探索し集約）系が強い。PIMC は **1 手あたりのシミュレーション本数（budget）と決定パラメータ**が強さを決める。
- **本番の手番には時間制約がある**が、**パラメータ探索は事前にオフラインで回せる**（提出するのは「探索済みパラメータを積んだプレイヤー」）。
  → ここで本ハーネスの標準ループが効く：**自己対戦勝率(fitness)を評価器に、パラメータを数万回チューニング**して、人手で決めた固定パラメータを**自動で超える**。
> **評価器の構造（実装済み）**: **7並べは多人数（3 人卓）ゲームであり、`battle.ts` の2人専用 `MatchFn`（`(a, b, round) => MatchOutcome`、2 つの `play` しか取らない）には乗らない**。`runRoundRobin` は C(n,2) の**2人ペア総当たり**であって、1候補を相手と**同卓させる N 人ゲーム1局**ではない。したがって「`runRoundRobin` の `win_rate` をそのまま fitness にできる」は7並べでは**成立しない**。
>
> - この問題は `runRoundRobin` 経由ではなく **Python エンジン側の self-play で解決済み**: `evaluate.py` が `engine.play_game(fns, seed, players_num)` で N人同卓1局を回す（`battle.ts` は共有・編集禁止なので、卓ロジックは Python サイドカーに置いた）。
> - `evaluate.py` は **座席ローテで座席バイアスを均す**: 局 `g` で候補を席 `g % players_num` に座らせ（L57-72）、`winner == seat` を勝ちと数えて勝率を返す。配り seed は `seed+g`、相手 random も `(seed,g)` から決定的に派生（同 seed で win_rate bit 一致）。
> - `runRoundRobin` の役割は7並べでは使わない（卓内1局を担えない2人専用ツールなので不採用）。`jankenEvolve` の `overallWinRate` が示す「1 vs N」は **N 個の独立した2人マッチの平均**であり、7並べが要求する **N人同卓1ゲーム**とは別物（先行実証が解いた問題とはずれているため、流用せず Python 側で実装した）。

- 評価器（N人同卓1局→勝率）は `evaluate.py` に実装済み。最適化は数値トラック（`optimize()`、決定的・seed 固定で再現）を**そのまま流用**している（`optimize` は fitness スカラしか見ないので評価器の中身に非依存）。TS 側 `xqAdapter.evaluate` が `evaluate.py` を spawn し、`runQuest`→`numericOptimizer` がパラメータを進化させる。

```
[事前実行 / オフライン]                                  [本番]
8 param 候補 ──▶ N人同卓1局を回す self-play(evaluate.py,       ──▶ 勝率(fitness)
   ▲             座席ローテで座席バイアスを均す/engine.play_game)     │
   │             ※ 2人専用 runRoundRobin は使わず Python エンジンで実装 │
   └─ optimize() が best を探索（時間制約なし。xqAdapter→runQuest 経由）─┘
                              │
                              ▼ buildSubmission（探索済みパラメータを best_params.json に焼き込み）
                     提出プレイヤー（本番は探索済み値で即指す）
```

### 4.2 参照: hirorogo/singyura 2025 優勝（PIMC + 手動 700）

- 先行事例 **hirorogo/singyura（2025 優勝）** は **PIMC + 手動チューニングのシミュ 700 本**で勝った。これは「PIMC の強さは本数とパラメータで決まる」ことの実証であり、**手動 700 という固定値が上限になっていた**ことも示す。
- 本ハーネスの主張は単純：**その 700（手動値）を、自己対戦勝率を fitness にした自動探索で超える**。事前実行に時間制約が無い以上、探索 budget を上げ、パラメータ空間を `optimize()` で舐めれば、手動調整の局所解を脱出できる（`numericOptimizer` のランダムリスタートが多峰性対策に効く）。

> **実装状況**: 7並べの評価ハーネス配線は**実装・実動**。`engine.py`（本家準拠ルール）・`ai_param.py`（8 param ヒューリスティック AI）・`evaluate.py`（席ローテ self-play）が揃い、TS 側 `xqAdapter.ts`→`runQuest.ts`→`numericOptimizer` で配線済み。検証: pytest 7 件緑、vitest 33 件緑、`python engine.py` デモが決定的に winner を出力、`evaluate.py` は同 seed で win_rate bit 一致、パラメータ感度あり（極端値 sweep で win_rate 0.275〜0.395）。
> 共有の `numericOptimizer.optimize` は**そのまま再利用**（パラメータ探索＝評価器の中身に非依存）。
> `battle.runRoundRobin`（2人ペア総当たり集計）は **N人卓の卓内対局には使えない**ため、7並べでは使わず、
> N人同卓1局は **Python エンジン側（`engine.play_game` ＋ `evaluate.py` の座席ローテ）で実装**した（§4.1）。
> `jankenEvolve.ts`（じゃんけん／本番未配線のデモ）は `optimize`＋`runRoundRobin` 合成の先行実証だが、
> その「1 vs N」は **N 個の2人マッチ平均**であり 7並べの N人同卓1ゲームとは別物（だから流用せず Python 側で実装）。
> なお **PIMC 探索プレイヤーそのものは未実装**（現 AI はパラメータ化ヒューリスティック）。PIMC への置換は将来拡張で、
> 評価ハーネス・8 param 探索・席ローテ・本番配線は既に動いている。

---

## 5. 評価器の規約（横断共通）

全クエストの評価器が守る規約（既存 `numericOptimizer.ts` / `battle.ts` のコメント規約と一致）:

- **fitness は大きいほど良い（max 方向）。** `min` 指標は呼び出し側が符号反転。
- **`win_rate` をそのまま fitness にしない場合がある。** `battle.ts` の `win_rate` は `wins/(wins+losses+draws)` で**引き分けを分母に算入＝draw を敗扱い**（`battle.ts` L77-80）。本書が唯一の実証と呼ぶ `jankenEvolve.ts` は**意図的にこれを使わず**、record から **draw=0.5 換算の独自集計**を再算出している（`jankenEvolve.ts` L24-27, L108-110 の `matchWinRate`）。つまり「`runRoundRobin` の `win_rate` をそのまま使える」という主張は、引用元の実証が実際には「そのまま使わなかった」事実と食い違う。**引き分けや着順（7並べの平均着順など）を持つゲームでは、`win_rate` をそのまま使わず record／座席結果から目的の指標を再算出する**こと（7並べは引き分けが稀なので実害は小さいが、規約として明記）。
- **決定的（seed 固定で完全再現）。** `Date.now` / `Math.random` 非依存。乱数は `numericOptimizer.createRng`（mulberry32）に統一し、play クロージャに閉じ込める（`jankenEvolve.matchWinRate` の実パターン）。
- **評価器・テストの改ざん禁止。** S6 採点前にテスト sha256 再ハッシュ検証（不一致＝`E_TEST_TAMPER` で失格）。報酬ハッキング対策（CLAUDE.md）。
- **Python サイドカーが要るクエスト**（Robo シミュレータ等）は `orchestrator/crawl.ts` の **spawn / stdin / ハード timeout / 純ロジック JSON→型 変換を named export** パターンに合わせる（`crawl()` と同形）。失敗は throw せず partial-first で 0 件/空を返す。

---

## 6. 価値の主張 — 二番煎じでないこと

- 個々のクエストには既に強いソルバが存在する（X の PIMC、AI/Data の AutoML 的手法、Robo の RL）。**それらを 1 本ずつ書き直すなら二番煎じ**。
- 本ハーネスの価値は **「1 大会・4クエストを横断して勝つ標準ハーネス」** という点に閉じる。差分を `QuestAdapter`（§2.1 の4点）に押し込み、**最適化器・CB・resume・provenance・leaderboard・レビューゲートを全クエストで共有**することで、
  - 新クエストへの対応 = adapter 1 本（候補/評価/橋渡し/提出）の追加に縮む、
  - 「どの戦略がどの大会指標でどう勝ったか」を **provenance.derived_from で横断追跡**できる（[architecture.md](./architecture.md) 来歴チェーン）、
  - SBQ の**複数クエスト合計点で勝つ**という大会構造に、ハーネス側が直接最適化を合わせられる。
- これは「最強の単機能ソルバ」ではなく「**最強の横断ハーネス**」を作るという立て付けであり、既存ソルバの寄せ集めとは目的が違う。

> **現実の到達点（再掲・正直版）**: 横断ハーネスの**骨格（候補→評価→最適化→提出の4段）は実動** —
> `QuestAdapter` 抽象（`orchestrator/quest/adapter.ts`）・実行ループ（`runQuest.ts`）・数値最適化（`optimize`）が配線済みで、
> **X Quest（7並べ）・AI Quest（ai-hyperopt）・Robo Quest（robo-control）の 3 クエストが end-to-end 実装・実動**:
> X=`engine.py`/`ai_param.py`/`evaluate.py`＋`xqAdapter`、AI=`ai-hyperopt/evaluate.py`（5 ハイパラ・held-out 精度）＋`aiHyperoptAdapter`、
> Robo=`robo-control/{sim.py,evaluate.py}`（5 制御ゲイン・シミュ報酬）＋`roboControlAdapter`。
> 3 アダプタとも `xqAdapter` と**同一の `QuestAdapter<NumericCandidate>` 契約**で、`runQuest`→`numericOptimizer` を**無改変共有**する
> （＝本節が主張する「横断ハーネスの汎用性」が AI/Robo で実達成）。xq pytest 22・quest 横断ハーネス vitest 87 緑、いずれも seed 固定で決定的。
> N人同卓は `runRoundRobin`（2人専用）ではなく Python エンジン側 self-play で実装した。
> 一方 **Data Quest の held-out 評価器、および AI/Robo の GA・LLM approach 変異ループ・X の PIMC 探索プレイヤーは未実装**（AI/Robo は数値トラックのみ）。
> 本書は実装済み部分（QuestAdapter＋X/AI/Robo の数値トラック）と未実装部分（Data 評価器・GA・LLM 変異）を区別して書いており、
> **実装済みを未実装と過小申告しない／未実装を実装済みと誇張しない**双方向で誠実であることを宣言する。

---

## 関連
- [architecture.md](./architecture.md) — S6 の2評価モード（test/battle）・データ契約・来歴・エラー経路
- [decisions.md](./decisions.md) — D8 対象大会（SBQ＋ハッカソン）・D18 進化2トラック・R3 提出ゲート
- [implementation-status.md](./implementation-status.md) — 実装/テストのみ/未配線/未検証の正直な棚卸し（判定語の正本）
- 実コード（横断ハーネス）: `orchestrator/quest/adapter.ts`（`QuestAdapter<Candidate>`/`NumericCandidate`）, `orchestrator/quest/runQuest.ts`（実行ループ・数値は numericOptimizer 直結）, `orchestrator/quest/xqAdapter.ts`（X Quest の実アダプタ・Python サイドカー spawn）
- 実コード（X Quest=7並べ）: `quests/xq-7narabe/engine.py`（本家準拠ルール）, `ai_param.py`（8 param ヒューリスティック AI）, `evaluate.py`（席ローテ self-play 評価器）, `test_engine.py`（pytest）
- 実コード（共有層）: `evolution/numericOptimizer.ts`（`optimize`/`EvaluateFn`/`Params`）, `orchestrator/battle.ts`（`runRoundRobin`/`Participant`／2人専用）, `evolution/jankenEvolve.ts`（①③合成の2人デモ）, `orchestrator/crawl.ts`（Python サイドカー spawn パターン）
