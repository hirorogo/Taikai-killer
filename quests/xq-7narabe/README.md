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

## 依存

標準ライブラリ + `numpy`（`engine.py` の盤面 `field_cards` と `deal` の `array_split` のみ）。
テストは不要（自己検証）。エンジンが正しく 7並べを回すことが最優先。
