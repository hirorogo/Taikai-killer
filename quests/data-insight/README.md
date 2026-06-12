# data-insight — Data Quest（知見抽出＝特徴選択＋集計の質）評価器

Data Quest（ビッグデータからの知見抽出）を数値最適化トラック（D18 ①: LLM 不要）に落とした
**自己完結クエスト**（4 クエスト目）。`quests/xq-7narabe`（ゲーム AI）・`quests/ai-hyperopt`
（ML ハイパラ）・`quests/robo-control`（ロボ制御）と **全く同じ QuestAdapter 抽象**
（候補→評価→最適化→提出）で実装されており、これは **フレームワークの汎用性の証明 3**：
毛色の違う「データ分析」を、同一の最適化器（`evolution/numericOptimizer.ts`）・同一の実行
ループ（`orchestrator/quest/runQuest.ts`）で回せる。差分は「候補キー・評価サイドカー・提出物」だけ。

> **ai-hyperopt と被らない狙い**: ai-hyperopt が測るのは「**モデルのハイパラ調整の質**」（lr/reg/
> hidden 等）。本クエストが測るのは「**特徴選択＋集計の質**」＝多数の列から **効く少数の特徴を
> 見抜き、無関係/冗長な列を選ばない**こと。候補は各特徴の選択重み（`sel_0..sel_9`）＋選択閾値
> `sel_threshold` ＋回帰正則化 `ridge`、fitness は **held-out 予測 R^2**。効く列だけを選べば
> held-out R^2 が上がり、ノイズ列を入れると過適合して held-out で劣化する（特徴選択そのものが
> 探索対象＝「どの特徴を使い、どう当てはめるか」を決める課題）。

> **外部データ不要の自己完結**: `evaluate.py` が seed 固定で **合成テーブル**（数値特徴 10 列
> ＋既知の真の関係を持つターゲット）を生成するので、ダウンロードも前処理済みファイルも要らない。
> seed を固定すれば held-out R^2（score）は **bit 一致**で再現する。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `evaluate.py` | stdin で `{params, seed}` を受け、seed 固定で合成テーブル（数値特徴 10 列＋ターゲット）を生成し、`params`（`sel_0..sel_9`・`sel_threshold`・`ridge`）で **どの特徴を使うか** を決め、選んだ特徴だけで **numpy 自前実装のリッジ最小二乗回帰** を train に当てはめ、**held-out 予測 R^2** を `{"score":r2,...}` で stdout に返すサイドカー。`score` が TS 側の読む fitness（大きいほど良い）。`r2_train`/`selected`/`n_selected`/`n_val` は診断併記。 |
| `best_params.json` | 最良候補の提出先（TS 側 `buildSubmission` が書く）。 |

TS 側ブリッジは `orchestrator/quest/dataInsightAdapter.ts`。`paramKeys` / `initialCandidate` /
入出力 JSON 契約は本ディレクトリの実装と 1:1 で一致させている。純ロジック（payload 構築・
score parse・提出物整形）は named export して `tests/dataInsightAdapter.test.ts`（vitest 27 件）で固定。

## タスク（自己完結・外部データ不要）

- 合成テーブル: `_N_SAMPLES=200` 行 × `_N_FEATURES=10` 列の回帰。train は **40 行**（`_VAL_FRACTION=0.8`）と
  意図的に小さくし、無関係列を入れると **過適合で held-out R^2 が明確に落ちる**ようにする
  （サンプルが多いと無関係列が無害化し「全部選べば良い」になって選択課題が消えるため）。
- 列の内訳（既知の真の関係）:
  - **真に効く 4 列** `0,2,5,7`（係数 `3.0, -2.2, 1.5, 1.1`）。ターゲットの線形結合に寄与する。
  - **冗長な相関列**（デコイ）`1,4`: それぞれ列 0・列 2 の `0.9×` ＋ノイズの**冗長コピー**。
    独自情報は薄く、選ぶと多重共線性で held-out 精度を損ねる（単純な相関選択を罠にかける）。
  - **純ノイズ列** `3,6,8,9`: ターゲットと無相関。選ぶと過適合のみで held-out が悪化。
- ターゲット `y` = 真の特徴の線形結合 + 切片 + ガウスノイズ（`_TARGET_NOISE_SD=1.2`。Bayes 誤差で
  R^2 上限を 1 未満にし、無関係列の過適合が held-out で罰せられる余地を作る）。
- held-out 分割: 80% を検証に回し、**当てはめに一切使わない**（標準化統計も train のみで算出＝リーク防止）。

## モデル（特徴選択 → リッジ最小二乗・閉形式）

1. **特徴選択**: `sel_i > sel_threshold` を満たす特徴インデックスだけを採用（昇順・set 非依存）。
2. **当てはめ**: 選択列＋切片で `(X^T X + ridge·I) w = X^T y` を閉形式で解く（切片は非正則化）。
   1 列も選ばれなければ定数予測（ターゲット平均）→ R^2=0 にフォールバック（throw しない）。
3. **採点**: held-out で R^2 = `1 - SS_res/SS_tot` を測り `score` として返す。

## パラメータ（12 個）

`dataInsightAdapter.ts paramKeys` と同名・同順。`evaluate.py` は未指定/非有限キーを既定で補完し、
安全レンジにクランプする（最適化器が極端値を投げても破綻しない）。

| key | 既定 | 意味 | クランプ範囲 |
|---|---|---|---|
| `sel_0`..`sel_9` | 1.0 | 各特徴の選択重み（`> sel_threshold` で採用） | [-5, 5] |
| `sel_threshold` | 0.0 | 選択閾値（これより大きい `sel_i` の特徴だけ使う） | [-5, 5] |
| `ridge` | 0.1 | リッジ正則化（過適合・多重共線性の抑制） | [0, 1000] |

既定は「全 10 列を採用（`sel=1.0 > 閾値 0.0`）」の素朴な出発点＝ノイズ列込みで過適合する局所点で
**最適とは限らない**（むしろ悪い）。`numericOptimizer`（ヒルクライム＋ランダムリスタート）が
`sel` を下げて効かない列を剪定する前提（手動の「全部入れ」を自動探索で超える、の核）。

## 決定性

- `seed` 固定で `score`（held-out R^2）は **bit 一致**（プロセス間でも一致）。合成テーブル生成・
  train/val 分割を全て `np.random.default_rng(seed)` から決定的に作り、当てはめは閉形式（乱数なし）。
- 特徴選択は `sel_i` を **特徴インデックス昇順**で評価する（`set` 反復順・`hash()` 非依存）。

## 実行例 — params で score が変わる

入力は stdin に 1 行 JSON。`score` = held-out R^2（最適化器が読む fitness）。
下記は実測値（同一 seed=0・同一テーブル・160 行の held-out）:

```console
$ echo '{"params":{},"seed":0}' | python evaluate.py                        # 全 10 列（既定）
{"score": 0.8922, "r2_train": 0.9746, "n_selected": 10, "selected": [0,...,9], ...}

$ echo '{"params":{"sel_1":0,"sel_3":0,"sel_4":0,"sel_6":0,"sel_8":0,"sel_9":0,"sel_threshold":0.5},"seed":0}' | python evaluate.py  # 真の4列 0,2,5,7 のみ
{"score": 0.9081, "r2_train": 0.9675, "n_selected": 4, "selected": [0,2,5,7], ...}

$ echo '{"params":{"sel_0":0,"sel_1":0,"sel_2":0,"sel_4":0,"sel_5":0,"sel_7":0,"sel_threshold":0.5},"seed":0}' | python evaluate.py  # 純ノイズ列 3,6,8,9 のみ
{"score": -0.5054, "r2_train": 0.3032, "n_selected": 4, "selected": [3,6,8,9], ...}

$ echo '{"params":{"sel_0":0,"sel_2":0,"sel_5":0,"sel_7":0,"sel_3":0,"sel_6":0,"sel_8":0,"sel_9":0,"sel_threshold":0.5},"seed":0}' | python evaluate.py  # 冗長デコイ 1,4 のみ
{"score": 0.4863, "r2_train": 0.7110, "n_selected": 2, "selected": [1,4], ...}
```

| 選択 | score（held-out R^2） | train R^2 | 解釈 |
|---|---|---|---|
| 全 10 列（既定） | 0.892 | 0.975 | ノイズ列込みで train に過適合、held-out が劣化 |
| 真の 4 列 `0,2,5,7` | **0.908** | 0.968 | 効く列だけ＝最良。train/val のギャップも最小 |
| 冗長デコイ `1,4` のみ | 0.486 | 0.711 | 真の列のコピーで弱い信号は拾うが多重共線性で精度劣化 |
| 純ノイズ `3,6,8,9` のみ | -0.505 | 0.303 | train だけ当てはまり held-out で**負 R^2**＝純粋な過適合 |

→ 「**効く列だけを選ぶ**」と held-out R^2 が最大化し、無関係/冗長な列を選ぶと過適合して
held-out で罰せられる。最適化器はこの勾配（選択の質）を登る。

決定性の確認（同一入力を 3 回 → 同一 score）:

```console
$ for i in 1 2 3; do echo '{"params":{"ridge":1.0},"seed":3}' | python evaluate.py; done
{"score": ..., "r2_train": ..., ...}   # 3 行とも完全一致
```

## 最適化ループ（end-to-end）

`runQuest`（共有の実行ループ）に `dataInsightAdapter` を渡すと、`numericOptimizer`（ヒルクライム
＋ランダムリスタート・決定的）が初期点（全 10 列採用）からヒルクライムで held-out R^2 を上げる。
実測（seed=42, generations=40, stepScale=0.6, restartAfter=10）:

```text
initial score (全特徴採用): 0.8967
best score    (探索後)     : 0.9028   （42 回評価）
```

ai-hyperopt（ML ハイパラ）・robo-control（ロボ制御）・xqAdapter（7並べ）と **同一の最適化器・
runQuest** がそのまま特徴選択探索に効く（最適化器は fitness スカラしか見ないので評価器の中身に
非依存）＝横断ハーネスの汎用性の実証 3。

## テスト

```console
$ npx vitest run tests/dataInsightAdapter.test.ts
27 passed
```

TS 側純ロジック（payload 構築・結果パース・提出整形・アダプタ契約）は
`tests/dataInsightAdapter.test.ts`（vitest 27 件）で固める。spawn 自体は実プロセスなのでテスト対象外。

## 依存

標準ライブラリ + `numpy`（合成テーブル生成・行列演算・閉形式最小二乗）のみ。sklearn 不使用。
`evaluate.py` の自己完結で、外部データセット・前処理済みファイルに依存しない。
