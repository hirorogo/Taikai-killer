# xq-7narabe — X Quest（七並べ）自己対戦評価器

X Quest（7並べ）の数値最適化トラック（D18 ①: LLM 不要）用クエスト。
**実ゲームを動かす最重要パート**。`hirorogo/singyura` の reference 実装を移植した
完全に動く 3 人対戦エンジンの上で、パラメータ化ヒューリスティック AI を
ランダム相手と自己対戦させて **順位点（着順加重・= fitness）** を返す。

> 着順加重 fitness について: 3 人戦で「最初の 1 人だけ勝ち」の二値勝率は上限が約
> 1/N（≈0.33）に張り付き候補の識別力が弱い。docs/quests.md §4.1 の指示に従い、
> `play_table`（N 人卓 1 局 → 着順）で全席の決着順を取り、**着順を [0,1] に加重**した
> 連続値（1 着=1.0 / 最下位=0.0）を fitness にして最適化の勾配を増やしている。

## 勝ち筋の現状（正直版・実測値と再現コマンド）

docs/quests.md §4.3 と同内容を本クエスト側に再掲する。**誇張せず実測**で記録する（2026-06-13 時点）。

1. **自動探索は動く・再現する**: `npm run taikai -- quest --quest xq --seed 42 --generations 15` で
   **initial fitness 0.635 → best fitness 0.740（evals=16）**。`numericOptimizer`（ヒルクライム）が
   弱い手動初期点から対 random 0.74 まで自動で引き上げ、`best_params.json` に焼き込む。決定的・bit 一致。
2. **ただし GA best は手調整 default に負けている**（要記録の不整合）: GA-best（`best_params.json`）を
   対 random・games=300・seed 0..3 で採点すると平均 **0.720**、一方 `ai_param.py` の手調整済み
   `default_params()` は平均 **0.738**（4 seed 中 3 seed で default が上）。原因は `xqAdapter.ts` の
   `initialCandidate`（探索の出発点）が **2025 由来の古い弱い値（対 random 0.635）のまま**で、後から
   強化された `ai_param.py default_params`（0.752）と**同期していない**こと。`xqAdapter.ts` は共有 .ts
   （本担当は読むだけ）なので、ここでは事実として記録するに留める（修正は adapter 担当の領域）。
   「探索後 0.74」を**手調整 default 超えと誇張してはいけない**。
3. **budget を上げる道筋**: 事前実行＝時間制約なしなので `--generations` 増・`evaluate` の `games` 増・
   `restartAfter`・`populationGA`（実装済み未配線）への切替で伸ばせる。だが**最優先は (2) の出発点ズレ
   解消**（これが最大効果。budget 不足が上限ではない）。
4. **限界（三点）**: (4-1) 評価器の相手が弱い — 既定相手は `random`。`--vs medium`（固定中級
   ヒューリスティック）だと**現既定 params の win_rate は 0.48 で拮抗どまり**＝強い相手には勝ち越せて
   いない。(4-2) MC（簡易 PIMC）は 3 人卓 literal 勝率で **seed・sim_count 依存に 0.35〜0.57 で揺れ、
   単調でも安定 > 0.5 でもない**（下「決定化 Monte-Carlo」節の実測）。(4-3) 本番の相手 AI は未知で、
   現評価器（対 random／自己ヒューリスティック／medium）はプロキシに過ぎず本番勝率を保証しない。
   **確立しているのは「自動探索が弱い初期点を対 random で 0.635→0.740 へ改善する配線と再現性」まで**。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `engine.py` | 7並べエンジン（State / deal / 合法手 / パス / バースト / 上がり / 勝者 / **着順 `play_table`**）。本家 `base_game_engine.py` 準拠 + seed 付き決定的 deal。単体実行でランダム自己対戦 1 戦のデモ。 |
| `ai_param.py` | `make_ai(params: dict) -> action_fn(state)`。8 個の数値パラメータで各合法手をスコア付けし最大を選ぶ決定的方策。 |
| `evaluate.py` | stdin で `{params,games,seed,opponents,vs}` を受け、`make_ai(params)` を**対戦相手**（`vs`：`random` 既定 / `medium`）と `games` 局自己対戦させ `{"win_rate":x,"first_place_rate":y,"avg_rank":z,"games":N,"vs":"..."}` を stdout に返すサイドカー。`win_rate` は**着順加重の順位点 fitness**（TS 側が読む値）、`first_place_rate` は literal な 1 着率、`avg_rank` は平均着順（診断）。相手種別は payload `vs` か CLI `--vs random\|medium` で切替（CLI 優先）。 |
| `ai_medium.py` | `make_medium() -> action_fn(state)`。**固定**の中級ヒューリスティック（長いスートから捌く + 端寄り優先 + 相手への開放を減点）。`PARAM_KEYS` に依存しないベンチマーク相手で、`--vs medium` で使う。random より明確に強い（対 2 random で win_rate ≈0.76）。 |
| `best_params.json` | 最良候補の提出先（TS 側 `buildSubmission` が書く）。 |

TS 側ブリッジは `orchestrator/quest/xqAdapter.ts`（読むだけ）。`paramKeys` /
`initialCandidate` / 入出力 JSON 契約は本ディレクトリの実装と 1:1 で一致させている。

## ルール（本家準拠）

- 52 枚を N 人に配る（`np.array_split`。3 人なら 18/17/17）。
- 各スートの 7 は配った瞬間に自動で場へ。♢7 保持者が先手。
- 合法手 = 各スートで 7 から連続して伸びる外側 1 枚 + A/K 端 + **トンネルルール**
  （A が出たら反対端 K が出せる／K が出たら A）。
- パス 4 回目（`pass_count > 3`）で**バースト** = 手札を全部場に放出して失格。
- 手札 0 枚で**上がり**。`play_game` は最初に上がった人を勝者として返す。
  `play_table` は全席の**着順**（上がった順 → バースト失格は最下位群）を返す。
  引き分けは稀だが、`play_table` の規約として「上がり順 → 安全弁未決着は手札少ない順 →
  失格順」で席を一意に並べる（決定的・同点は席 index 昇順で安定）。

## パラメータ（8 個）

`xqAdapter.ts paramKeys` と同名・同順。`make_ai` は未指定キーを `default_params()` で補完。

| key | 既定 | 意味 |
|---|---|---|
| `w_edge_distance` | 1.0 | 7 から遠い札（端寄り）を優先 |
| `w_blocking` | 1.5 | 出すと相手の道を開く手を減点（境界札の温存） |
| `w_rank_extreme` | 0.3 | A/K 寄りの端ランクを早めに出す |
| `w_hold_seven_adj` | 0.4 | 7 隣接（6/8）の保持（出すのを抑制） |
| `w_suit_balance` | 2.5 | 手札が多いスートを優先して捌く（**対 random で最も効く主係数**） |
| `w_pass_reserve` | 1.0 | 出し惜しみ。そのスートで自分の最後の出せる札（出すと連鎖が切れ手番を渡す手）を温存。`w_blocking` とは独立特徴（二重減点を解消） |
| `w_release_urgency` | 1.2 | 終盤（手札少）ほど出し切りを急ぐ + **手札内連鎖**（出すと同スートの次札も自分が出せる札）を優先するテンポ項（連続放出で手番を保ったまま一気に減らす） |
| `w_random_jitter` | 0.05 | 盤面指紋＋カードから決定的に派生する微小な探索ノイズ（同一局面で再現・別盤面では別ノイズ） |

既定値は **all-zero / 旧既定を着実に上回るよう実測スイープで手調整した出発点**（対 random・
games=400・seed 0..3 平均で win_rate 0.643→0.742 を確認）。最適とは限らず、numericOptimizer/GA が
ここから符号・大きさを更に詰める前提（下の「対戦相手別 勝率」「GA チューニング余地」を参照）。
特に `w_suit_balance`（長いスートから崩す）と `w_release_urgency` の連鎖テンポ項が効く。

## 決定性

- `seed` 固定で `win_rate` は **bit 一致**（プロセス間でも一致）。
  配り seed = `seed + g`、相手 random は `(seed, g)` から決定的に派生。
- `legal_actions()` は `set` の反復順（PYTHONHASHSEED 依存）を避け、str キーで
  安定ソートして返す。`PYTHONHASHSEED` を設定しなくても再現する。
- 席順バイアス除去のため、局 `g` で候補を席 `g % players` に座らせ、勝者がその席なら勝ち。

## 実行例

### エンジン単体（ランダム自己対戦デモ）

```console
$ python engine.py
seed=12345 winner=P2      # ← stderr に詳細、stdout に勝者 index
2
```

### evaluate.py（順位点評価）

入力は stdin に 1 行 JSON。`opponents` は候補以外の人数（既定 2 = 3 人戦）。
`win_rate` は**着順加重の順位点 fitness**（最適化器が読む値）、`first_place_rate` は
literal な 1 着率、`avg_rank` は平均着順（1=最良）。下記は実測値（修正後・再取得）。

```console
$ echo '{"params":{},"games":300,"seed":0,"opponents":2}' | python evaluate.py
{"win_rate": 0.7516666666666667, "first_place_rate": 0.6466666666666666, "avg_rank": 1.4966666666666666, "games": 300, "vs": "random"}
```

パラメータで fitness が変わる（同一 seed・同一局数で比較。主係数を 0 に潰すと既定より下がる）:

```console
$ echo '{"params":{"w_random_jitter":5.0,"w_edge_distance":0.0,"w_suit_balance":0.0},"games":300,"seed":0,"opponents":2}' | python evaluate.py
{"win_rate": 0.635, "first_place_rate": 0.48333333333333334, "avg_rank": 1.73, "games": 300, "vs": "random"}
```

決定性の確認（同一入力を 3 回 → 同一 fitness）:

```console
$ for i in 1 2 3; do echo '{"params":{"w_edge_distance":2.0},"games":150,"seed":7,"opponents":2}' | python evaluate.py; done
{"win_rate": 0.7, "first_place_rate": 0.5733333333333334, "avg_rank": 1.6, "games": 150, "vs": "random"}
{"win_rate": 0.7, "first_place_rate": 0.5733333333333334, "avg_rank": 1.6, "games": 150, "vs": "random"}
{"win_rate": 0.7, "first_place_rate": 0.5733333333333334, "avg_rank": 1.6, "games": 150, "vs": "random"}
```

### evaluate.py（固定中級ヒューリスティック相手）

`--vs medium`（または payload `"vs":"medium"`）で**固定の中級ヒューリスティック相手**と戦う。
random より明確に強い相手なので、候補が中級相手に勝ち越せるかの難しいベンチマークになる。

```console
$ echo '{"params":{},"games":300,"seed":0,"vs":"medium"}' | python evaluate.py
{"win_rate": 0.48, "first_place_rate": 0.3233333333333333, "avg_rank": 2.04, "games": 300, "vs": "medium"}

$ echo '{"params":{},"games":300,"seed":0}' | python evaluate.py --vs medium   # CLI でも可（CLI 優先）
{"win_rate": 0.48, "first_place_rate": 0.3233333333333333, "avg_rank": 2.04, "games": 300, "vs": "medium"}
```

## デフォルト param の実測勝率（対 random / 対 medium）

同一 seed=0・300 局での実測比較（`win_rate` = 順位点 fitness、`first_place` = literal な 1 着率）。
**3 人戦の「全員同等」基準は順位点 0.5 / 1 着率 1/3≒0.333**。

### 対 random

| param 集合 | win_rate | first_place | avg_rank |
|---|---|---|---|
| all-zero（全係数 0・ほぼランダム） | 0.547 | 0.393 | 1.91 |
| 旧既定（2025 手調整） | 0.630 | 0.500 | 1.74 |
| **新既定（本実装）** | **0.752** | **0.647** | **1.50** |
| 手調整さらに上（GA 探索の到達点の目安） | 0.763 | 0.670 | 1.47 |

新既定は all-zero（順位点 0.547）・旧既定（0.630）を大きく上回り、対 random で win_rate 0.75 /
1 着率 0.65。`w_suit_balance`（長いスートから崩す）と連鎖テンポ項（`w_release_urgency`）の強化が主因。

### 対 medium（固定中級ヒューリスティック）

| param 集合 | win_rate | first_place | avg_rank |
|---|---|---|---|
| 旧既定 | 0.420 | 0.243 | 2.16 |
| **新既定（本実装）** | **0.480** | **0.323** | **2.04** |

medium は新既定の候補とほぼ同等の強さ（medium 単体で対 2 random win_rate ≈0.757）なので、
3 人戦でほぼ拮抗（候補の 1 着率 0.323 ≈ 1/3 の同等ライン）。旧既定（1 着率 0.243）よりは明確に改善。

## GA / numericOptimizer チューニングで上がる余地

8 個の `PARAM_KEYS` は維持しているので numericOptimizer（ヒルクライム）/ populationGA がそのまま
摂動できる。既定はあくまで**実測で選んだ出発点**であり、最適ではない:

- 既定から `w_suit_balance` を上げる / `w_blocking`・`w_pass_reserve` を強めるだけで対 random の
  win_rate が 0.752 → 0.763 まで伸びる手調整点が見つかっている（上表「GA 探索の到達点の目安」）。
- 着順加重 fitness（連続値）にしているので候補間の勾配がはっきり出る（二値勝率より探索が締まる）。
- `vs:"medium"` を fitness にすれば「強い相手に勝ち越す」方向へ最適化できる（より厳しいバー）。

つまり本既定は **all-zero / 旧既定を実測で上回る出発点**を提供しつつ、GA で**さらに伸ばせる形**
（PARAM_KEYS の数値スコアリング・seed 固定の決定性）を保っている。

> Windows コンソール（cp932）で ♠♣♡♢ を表示するデバッグ時は `PYTHONIOENCODING=utf-8`
> を設定する（評価本体は記号を stdout に出さないので通常は不要）。

## 決定化 Monte-Carlo（簡易 PIMC）AI — `ai_mc.py` / `evaluate_mc.py`

docs/quests.md §4.1 の「7並べは PIMC（相手手札を多数サンプリングして各サンプルで完全情報
プレイアウトし集約）系が強い／事前実行＝時間制約なしを活かし budget（sim_count）を上げるほど
強くなる」を、上記ヒューリスティック `make_ai` の**上に被せる**形で実装したもの。`engine.py` /
`ai_param.py` は読むだけ（非破壊）。

| ファイル | 役割 |
|---|---|
| `ai_mc.py` | `make_mc_ai(params, sim_count, seed) -> action_fn(state)`。現手番の各合法手について、相手の見えない手札を seed 付き RNG で**決定化**（全 52 枚 − 場札 − 自分の手札 を相手の既知手札枚数ぶん配り直す）し、`sim_count` 回プレイアウトして**期待着順スコア**を推定、最大の手を選ぶ。プレイアウト方策は全席 `make_ai(params)`（決定的）。 |
| `evaluate_mc.py` | stdin `{params,games,seed,sim_count}` を受け、MC 候補を**対ヒューリスティック `make_ai`×2** の 3 人卓で `games` 局戦わせ、MC の literal な 1 着率を `{"win_rate":x,...}` で返すサイドカー。`evaluate.py`（順位点 fitness）とは別物で、こちらの `win_rate` は**そのまま 1 着率**。 |

### 何を狙った修正か（採点を着順スコアに変更）

- **採点を二値勝率→着順スコアに変更（`ai_mc.py` の修正）。** 3 人卓で全席が同一プレイアウト
  方策（ヒューリスティック）だと、root の 1 着率は手 `a` に依らず ≈1/3 に張り付き、手の良し悪しの
  信号が決定化ノイズに埋もれる。そこでプレイアウトを `play_table` 同等の**着順**まで回し、root の
  順位を `1 着=1.0 / 2 着=0.5 / 3 着=0.0` に線形按分した連続スコアで採点する（`_rank_score` /
  `_playout_order`）。狙いは「悪い手は平均着順が悪化するので手の差がはっきり出て、`sim_count` を
  増やすほど推定が締まる」こと。本番の literal な勝率（1 着率）は `evaluate_mc.py` が別途集計する
  ので出力契約は不変。
- **既定 `sim_count` を 30→100 に引き上げ（`evaluate_mc.py`）。** 事前実行＝時間制約なしを活かして
  既定 budget を高めに置く。

検証（ground truth・手単位）: 各決定点で MC の選んだ手とヒューリスティックの選んだ手の**真の着順
スコア**（多サンプル）を突き合わせると、MC の手は多くの局面でヒューリスティックの手より高スコア
（=より良い手）を選ぶ。**手単位では MC はヒューリスティックを上回る**。ただし 3 人卓の literal 勝率
（次節）では別の壁がある。

### 実測（正直版・`sim_count` を上げても単調でも安定 > 0.5 でもない）

> **重要・誇張訂正**: 旧版 README はこの節で「`sim_count` を上げるほど win_rate が**単調に伸び**、
> 0.58 で**明確に勝ち越す**」と書いていたが、**現リポジトリ状態での再測では再現しない**。実測は
> 非単調で、最高 budget でむしろ 0.5 を割る。`ai_mc.py`／`evaluate_mc.py` の docstring が掲げる
> 「単調に強くなる／明確に勝ち越す」も同様に**過大**である。以下は誇張のない実測。

`sim_count` スイープ（対ヒューリスティック ×2 の 3 人卓・既定 params・games=30・seed=0・決定的）:

```text
sim_count=10   win_rate=0.500
sim_count=30   win_rate=0.500
sim_count=100  win_rate=0.567
sim_count=200  win_rate=0.433   ← 最高 budget で 0.5 を割る（非単調）
```

→ **単調に伸びない**（100 で 0.567 まで上がっても 200 で 0.433 へ下がる）。3 人卓・games=30 の
標準誤差は約 0.09 と大きく、各点が席運・決定化ノイズで揺れるため、この games・seed では
`sim_count` の増加が安定した勝率向上に**つながっていない**。

seed を変えても 0.5 前後で割れる（games=30・sim_count=100・複数 seed・別途実測）: 0.33〜0.57 の幅で
揺れ、単一 seed で > 0.5 を保証できない。games を減らすとさらに振れる（games=20・seed=0・
sim_count=150 で 0.35 まで沈む点もある）。

```console
$ echo '{"params":{},"games":30,"seed":0,"sim_count":200}' | python evaluate_mc.py
{"win_rate": 0.43333333333333335, "games": 30, "sim_count": 200}
```

**正直なまとめ**: MC（簡易 PIMC）は (a) 実装済み・単体実行可能、(b) **手単位ではヒューリスティックを
上回る**、(c) しかし 3 人卓の literal 勝率では **seed・budget 依存で 0.5 前後に揺れ、`sim_count` を
上げても単調には伸びず、最高 budget で 0.5 を割る点もある**。3 人卓で「win_rate > 0.5」は相手 2 体
合計を 1 体で上回る高いバー（全員同等なら 1/3≒0.333）であり、現状の同一プレイアウト方策・
games 規模ではそれを**安定して越えられていない**。MC は orchestrator の数値トラックにも未配線
（`xqAdapter` は `evaluate.py`＝ヒューリスティックを spawn）。詳細は docs/quests.md §4.2・§4.3。

```console
$ python ai_mc.py                 # デモ: MC を席 0、ヒューリスティックを席 1,2 で 1 戦
seed=123 winner=P0                # ← stderr に詳細、stdout に勝者 index
0
```

## 依存

標準ライブラリ + `numpy`（`engine.py` の盤面 `field_cards` と `deal` の `array_split` のみ）。
テストは不要（自己検証）。エンジンが正しく 7並べを回すことが最優先。
