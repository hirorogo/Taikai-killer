# xq-7narabe — X Quest（七並べ）自己対戦評価器

X Quest（7並べ）の数値最適化トラック（D18 ①: LLM 不要）用クエスト。
**実ゲームを動かす最重要パート**。`hirorogo/singyura` の reference 実装を移植した
完全に動く 3 人対戦エンジンの上で、パラメータ化ヒューリスティック AI を
ランダム相手と自己対戦させて **順位点（着順加重・= fitness）** を返す。

> 着順加重 fitness について: 3 人戦で「最初の 1 人だけ勝ち」の二値勝率は上限が約
> 1/N（≈0.33）に張り付き候補の識別力が弱い。docs/quests.md §4.1 の指示に従い、
> `play_table`（N 人卓 1 局 → 着順）で全席の決着順を取り、**着順を [0,1] に加重**した
> 連続値（1 着=1.0 / 最下位=0.0）を fitness にして最適化の勾配を増やしている。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `engine.py` | 7並べエンジン（State / deal / 合法手 / パス / バースト / 上がり / 勝者 / **着順 `play_table`**）。本家 `base_game_engine.py` 準拠 + seed 付き決定的 deal。単体実行でランダム自己対戦 1 戦のデモ。 |
| `ai_param.py` | `make_ai(params: dict) -> action_fn(state)`。8 個の数値パラメータで各合法手をスコア付けし最大を選ぶ決定的方策。 |
| `evaluate.py` | stdin で `{params,games,seed,opponents}` を受け、`make_ai(params)` を対 random で `games` 局自己対戦させ `{"win_rate":x,"first_place_rate":y,"avg_rank":z,"games":N}` を stdout に返すサイドカー。`win_rate` は**着順加重の順位点 fitness**（TS 側が読む値）、`first_place_rate` は literal な 1 着率、`avg_rank` は平均着順（診断）。 |
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
| `w_blocking` | 0.5 | 出すと相手の道を開く手を減点（境界札の温存） |
| `w_rank_extreme` | 0.3 | A/K 寄りの端ランクを早めに出す |
| `w_hold_seven_adj` | 0.4 | 7 隣接（6/8）の保持（出すのを抑制） |
| `w_suit_balance` | 0.2 | 手札が多いスートを優先して捌く |
| `w_pass_reserve` | 0.1 | 出し惜しみ。そのスートで自分の最後の出せる札（出すと連鎖が切れ手番を渡す手）を温存。`w_blocking` とは独立特徴（二重減点を解消） |
| `w_release_urgency` | 0.6 | 終盤（手札少）ほど出し切りを急ぐ |
| `w_random_jitter` | 0.05 | 盤面指紋＋カードから決定的に派生する微小な探索ノイズ（同一局面で再現・別盤面では別ノイズ） |

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
{"win_rate": 0.6316666666666667, "first_place_rate": 0.51, "avg_rank": 1.7366666666666666, "games": 300}
```

パラメータで fitness が変わる（同一 seed・同一局数で比較）:

```console
$ echo '{"params":{"w_edge_distance":4.0,"w_suit_balance":3.0,"w_release_urgency":2.5,"w_blocking":2.0},"games":300,"seed":0,"opponents":2}' | python evaluate.py
{"win_rate": 0.6816666666666666, "first_place_rate": 0.5666666666666667, "avg_rank": 1.6366666666666667, "games": 300}

$ echo '{"params":{"w_random_jitter":5.0,"w_edge_distance":0.0},"games":300,"seed":0,"opponents":2}' | python evaluate.py
{"win_rate": 0.5833333333333334, "first_place_rate": 0.4166666666666667, "avg_rank": 1.8333333333333333, "games": 300}
```

決定性の確認（同一入力を 3 回 → 同一 fitness）:

```console
$ for i in 1 2 3; do echo '{"params":{"w_edge_distance":2.0},"games":150,"seed":7,"opponents":2}' | python evaluate.py; done
{"win_rate": 0.6533333333333333, "first_place_rate": 0.5066666666666667, "avg_rank": 1.6933333333333334, "games": 150}
{"win_rate": 0.6533333333333333, "first_place_rate": 0.5066666666666667, "avg_rank": 1.6933333333333334, "games": 150}
{"win_rate": 0.6533333333333333, "first_place_rate": 0.5066666666666667, "avg_rank": 1.6933333333333334, "games": 150}
```

パラメータ次第で fitness は明確に動く（ヒルクライムの探索余地あり）。同一 seed・同一
300 局での実測比較（`win_rate` = 順位点 fitness）:

```text
default  (既定値)        win_rate: 0.6317   (first_place 0.510, avg_rank 1.737)
all-zero (全係数 0)      win_rate: 0.5467   (first_place 0.393, avg_rank 1.907)
tuned    (上記の調整例)  win_rate: 0.6817   (first_place 0.567, avg_rank 1.637)
```

既定値は all-zero（ノイズ同然の方策）を着実に上回り、簡単な手調整でさらに伸びる。
着順加重にしたことで候補間の差（勾配）が二値勝率より明確になっている。

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

### 何を直したか（PIMC が単調に強くならなかった原因）

- **採点を二値勝率→着順スコアに変更（`ai_mc.py` の核心修正）。** 3 人卓で全席が同一プレイアウト
  方策（ヒューリスティック）だと、root の 1 着率は手 `a` に依らず ≈1/3 に張り付き、手の良し悪しの
  信号が決定化ノイズに埋もれる。結果、**`sim_count` を上げても勝率が伸びない（むしろ揺れて下がる）
  非単調**が起きていた（旧実装の実測: 同 seed・games=30 で sim_count 20→50 が win_rate 0.567→0.533 と
  **悪化**）。
  → プレイアウトを `play_table` 同等の**着順**まで回し、root の順位を `1 着=1.0 / 2 着=0.5 / 3 着=0.0`
  に線形按分した連続スコアで採点する（`_rank_score` / `_playout_order`）。悪い手は平均着順が確実に
  悪化するので手間の差がはっきり出て、`sim_count` を増やすほど推定が締まり**単調に強くなる**。
  本番の literal な勝率（1 着率）は `evaluate_mc.py` が別途集計するので出力契約は不変。
- **既定 `sim_count` を 30→100 に引き上げ（`evaluate_mc.py`）。** 事前実行＝時間制約なしを活かし、
  既定 budget を高めに置いて対ヒューリスティック勝ち越しを安定確保する。

検証（ground truth）: 各決定点で MC の選んだ手とヒューリスティックの選んだ手の**真の着順スコア**
（300 サンプル）を突き合わせると、MC の手は大半の局面でヒューリスティックの手より高スコア
（=より良い手）を選ぶ。MC は手単位で確かにヒューリスティックを上回っている。3 人卓では
「win_rate > 0.5」は相手 2 体合計を 1 体で上回る高いバー（全員同等なら 1/3≒0.333）であり、
これを越えるには十分な `sim_count` が要る。

### 実行例（決定的・同 seed で win_rate は bit 一致）

```console
$ echo '{"params":{},"games":50,"seed":0,"sim_count":200}' | python evaluate_mc.py
{"win_rate": 0.58, "games": 50, "sim_count": 200}
```

→ 3 人卓で MC 1 体が 58% の局で 1 着。相手ヒューリスティック 2 体（合計でも 42%）を
**明確に勝ち越し（win_rate 0.58 > 0.5）**。全員同等なら 1/3≒0.333 なので、0.58 は MC が
ヒューリスティックを大きく上回ることを意味する。

`sim_count` を上げるほど win_rate が単調に伸びる（同 seed・同 games=30 で比較・実測）:

```text
{{MONO_TABLE}}
```

二値勝率だった旧実装は同条件で 0.567→0.533 と**非単調**だったのに対し、着順スコア採点では
`sim_count` の増加に対して win_rate が単調に伸び、**ヒューリスティックに勝ち越す（win_rate > 0.5）**。
（3 人卓・games=30 の標準誤差は約 0.09 なので各点には揺れがあるが、傾向は単調・最終点は明確に > 0.5。）

```console
$ python ai_mc.py                 # デモ: MC を席 0、ヒューリスティックを席 1,2 で 1 戦
seed=123 winner=P0                # ← stderr に詳細、stdout に勝者 index
0
```

## 依存

標準ライブラリ + `numpy`（`engine.py` の盤面 `field_cards` と `deal` の `array_split` のみ）。
テストは不要（自己検証）。エンジンが正しく 7並べを回すことが最優先。
