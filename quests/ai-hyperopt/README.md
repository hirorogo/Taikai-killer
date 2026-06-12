# ai-hyperopt — AI Quest（ML ハイパーパラメータ最適化）評価器

AI Quest（機械学習モデリング）を数値最適化トラック（D18 ①: LLM 不要）に落とした
**自己完結クエスト**。`quests/xq-7narabe`（ゲーム AI）と **全く同じ QuestAdapter 抽象**
（候補→評価→最適化→提出）で実装されており、これは **フレームワークの汎用性の証明**：
毛色の違う「ゲーム AI のパラメータ調整」と「ML のハイパラ調整」を、同一の最適化器
（`evolution/numericOptimizer.ts`）・同一の実行ループ（`orchestrator/quest/runQuest.ts`）で
回せる。差分は「候補キー（ハイパラ）・評価サイドカー・提出物」だけ。

> **外部データセット不要の自己完結**: `evaluate.py` が seed 固定で **合成データ**（XOR 風の
> 非線形 2 クラス分類）を生成するので、ダウンロードも前処理済みファイルも要らない。
> seed を固定すれば held-out 検証精度（score）は **bit 一致**で再現する。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `evaluate.py` | stdin で `{params, seed}` を受け、seed 固定で合成データ（2 クラス分類）を生成し、`params`（学習率 lr・正則化 reg・隠れ次元 hidden・epochs・init_scale）で **numpy 自前実装の分類器**（hidden=0 → 線形ロジスティック回帰 / hidden>0 → 1 隠れ層 MLP）を学習し、**held-out 検証精度** を `{"score":acc,...}` で stdout に返すサイドカー。`score` が TS 側の読む fitness（大きいほど良い）。`train_acc`/`val_acc`/`n_val` は診断併記。 |
| `best_params.json` | 最良候補の提出先（TS 側 `buildSubmission` が書く）。 |

TS 側ブリッジは `orchestrator/quest/aiHyperoptAdapter.ts`。`paramKeys` / `initialCandidate` /
入出力 JSON 契約は本ディレクトリの実装と 1:1 で一致させている。純ロジック（payload 構築・
score parse・提出物整形）は named export して `tests/aiHyperoptAdapter.test.ts`（vitest）で固定。

## 学習タスク（自己完結・外部データ不要）

- 合成データ: `_N_SAMPLES=600` × `_N_FEATURES=6` の 2 クラス分類。先頭 2 軸の **符号積**で
  クラスを決める **XOR 風の非線形構造**（線形分離不可）＋ 8% のラベルノイズ ＋ 観測ノイズ。
- 分類器（sklearn 不使用・numpy 自前実装）:
  - `hidden=0` → 線形ロジスティック回帰（全バッチ勾配降下 + L2）。XOR 構造を捉えきれず精度が低い。
  - `hidden>0` → 1 隠れ層 MLP（tanh 隠れ層 + シグモイド出力、全バッチ勾配降下 + L2）。非線形を表現できる。
- held-out 分割: 20% を検証に回し、**学習に一切使わない**（標準化統計も train のみで算出＝リーク防止）。
- ハイパラの良し悪しが val 精度に直結する: hidden で表現力、lr/epochs で収束、reg で過学習抑制、
  init_scale で初期化。ここに最適化の勾配がある。

## ハイパーパラメータ（5 個）

`aiHyperoptAdapter.ts paramKeys` と同名・同順。`evaluate.py` は未指定/非有限キーを既定で補完し、
安全レンジにクランプする（最適化器が極端値を投げても破綻しない）。

| key | 既定 | 意味 | クランプ範囲 |
|---|---|---|---|
| `lr` | 0.05 | 学習率（大きすぎると発散、小さすぎると未収束） | [1e-5, 50] |
| `reg` | 0.001 | L2 正則化係数（過学習抑制） | [0, 10] |
| `hidden` | 8 | 隠れ層ユニット数（0=線形 / >0=MLP） | [0, 64]（整数） |
| `epochs` | 200 | 全バッチ勾配降下の反復回数 | [1, 2000]（整数） |
| `init_scale` | 0.1 | 重み初期化スケール | [1e-4, 5] |

## 決定性

- `seed` 固定で `score`（held-out 精度）は **bit 一致**（プロセス間でも一致）。合成データ生成・
  train/val 分割・重み初期化を全て `np.random.default_rng(seed 派生)` から決定的に作る。
- 全バッチ勾配降下（ミニバッチのシャッフル乱数を使わない）なので追加の乱数源が無く再現的。
- Python の組み込み `hash` / `set` 反復順には依存しない（`PYTHONHASHSEED` 非依存）。

## 実行例 — params で score が変わる

入力は stdin に 1 行 JSON。`score` = held-out 検証精度（最適化器が読む fitness）。
下記は実測値（同一 seed=0・同一データ）:

```console
$ echo '{"params":{"hidden":0,"epochs":400,"lr":0.1},"seed":0}' | python evaluate.py
{"score": 0.475, "train_acc": 0.54375, "val_acc": 0.475, "n_val": 120}

$ echo '{"params":{"hidden":8,"epochs":400,"lr":0.1},"seed":0}' | python evaluate.py
{"score": 0.5166666666666667, "train_acc": 0.5541666666666667, "val_acc": 0.5166666666666667, "n_val": 120}

$ echo '{"params":{"hidden":16,"epochs":1200,"lr":0.2,"reg":0.0005},"seed":0}' | python evaluate.py
{"score": 0.6583333333333333, "train_acc": 0.75625, "val_acc": 0.6583333333333333, "n_val": 120}

$ echo '{"params":{"hidden":32,"epochs":2000,"lr":0.3,"reg":0.0001,"init_scale":0.5},"seed":0}' | python evaluate.py
{"score": 0.6833333333333333, "train_acc": 0.9104166666666667, "val_acc": 0.6833333333333333, "n_val": 120}
```

学習率が極端だと精度が落ちる（現実のハイパラ感度を残している）:

```console
$ echo '{"params":{"lr":40,"hidden":8,"epochs":400},"seed":0}' | python evaluate.py   # 発散ぎみ
{"score": 0.44166666666666665, ...}

$ echo '{"params":{"lr":0.0001,"hidden":8,"epochs":50},"seed":0}' | python evaluate.py # 未収束
{"score": 0.45, ...}
```

決定性の確認（同一入力を 3 回 → 同一 score）:

```console
$ for i in 1 2 3; do echo '{"params":{"lr":0.15,"hidden":16,"epochs":600},"seed":3}' | python evaluate.py; done
{"score": 0.6166666666666667, "train_acc": 0.6458333333333334, ...}
{"score": 0.6166666666666667, "train_acc": 0.6458333333333334, ...}
{"score": 0.6166666666666667, "train_acc": 0.6458333333333334, ...}
```

| 設定 | score（val 精度） | 解釈 |
|---|---|---|
| 線形 `hidden=0` | 0.475 | XOR 非線形を捉えきれず低い |
| MLP `hidden=8` | 0.517 | 非線形表現が入り改善 |
| MLP `hidden=16` + 多 epochs | 0.658 | 収束が進みさらに改善 |
| MLP `hidden=32` 大容量 | 0.683 | train 0.91 / val 0.68 ＝ 過学習も見える（reg が効く余地） |

## 最適化ループ（end-to-end）

`runQuest`（共有の実行ループ）に `aiHyperoptAdapter` を渡すと、`numericOptimizer`（ヒルクライム
＋ランダムリスタート・決定的）が初期点（既定ハイパラ）からヒルクライムで held-out 精度を上げる。
実測（seed=42, generations=30, stepScale=0.5, restartAfter=8）:

```text
initial score (既定ハイパラ): 0.4750
best score    (探索後)       : 0.7250   （32 回評価）
```

xqAdapter（7並べ）と **同一の最適化器・runQuest** がそのまま ML ハイパラ探索に効く
（最適化器は fitness スカラしか見ないので評価器の中身に非依存）＝横断ハーネスの汎用性の実証。

## 依存

標準ライブラリ + `numpy`（合成データ生成・行列演算）のみ。sklearn 不使用。
