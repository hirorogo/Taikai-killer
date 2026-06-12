#!/usr/bin/env python3
"""AI Quest「ハイパーパラメータ最適化（ai-hyperopt）」評価サイドカー（自己完結・外部データ不要）。

役割（TS 側 orchestrator/quest/aiHyperoptAdapter.ts の evaluate と 1:1 の契約）:
  stdin で 1 行 JSON {params, seed} を受け取り、seed 固定で **合成データセット**（2 クラス
  分類）を生成し、params（学習率 lr・正則化 reg・隠れ次元 hidden・epochs 等の数値ハイパラ）
  で **小さな分類器（numpy 自前実装の 1 隠れ層 MLP / hidden=0 なら線形ロジスティック回帰）**
  を学習し、**held-out 検証精度** を 1 行 JSON {"score": acc} で stdout に返す。診断は stderr。

設計の正: docs/quests.md（AI = ハイパラ + 検証精度 / held-out / fitness は大きいほど良い）。
sklearn は使わず numpy + 標準ライブラリのみ（CLAUDE.md「Python は標準ライブラリ優先・numpy 可」）。

入力 (stdin, 1 行 JSON):
  {
    "params": {
      "lr":       0.05,   # 学習率（>0。大きすぎると発散、小さすぎると未収束）
      "reg":      0.001,  # L2 正則化係数（>=0。過学習抑制）
      "hidden":   8,      # 隠れ層ユニット数（0 = 線形ロジスティック回帰、>0 = 1 隠れ層 MLP）
      "epochs":   200,    # 全バッチ勾配降下の反復回数（>=1）
      "init_scale": 0.1   # 重み初期化スケール（>0）
    },
    "seed": 0             # 乱数 seed（決定性の要・合成データ生成と重み初期化を固定）
  }
  ※ params は部分指定可。欠落キーは _DEFAULT_PARAMS で補完。非有限値も既定で補完。

出力 (stdout, 1 行 JSON):
  {"score": 0.87, "train_acc": 0.91, "val_acc": 0.87, "n_val": 120}
  ※ TS 側 parseEvalResult は `score` のみ読み [0,1] にクランプして fitness にする。
    `score` = held-out 検証精度（大きいほど良い = fitness）。train_acc / val_acc は診断併記。

決定性（CLAUDE.md「決定的・seed 固定・set 反復順依存を避ける」）:
  - seed 固定で score は bit 一致。合成データ（特徴・ラベル）と train/val 分割と重み初期化を
    すべて np.random.default_rng(seed 派生) から決定的に作る。Python 組み込み hash / set
    反復順には依存しない。
  - 全バッチ勾配降下（ミニバッチのシャッフル乱数を使わない）なので追加の乱数源が無く再現的。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。
  - 数値発散（NaN/Inf）は学習を打ち切り、その時点の重みで検証精度を測る（throw しない）。

標準ライブラリ + numpy のみ。
"""
from __future__ import annotations

import json
import sys

import numpy as np

# ハイパラの既定値（部分指定/欠落時に補完）。TS 側 initialCandidate と 1:1・同値。
_DEFAULT_PARAMS = {
    "lr": 0.05,
    "reg": 0.001,
    "hidden": 8.0,
    "epochs": 200.0,
    "init_scale": 0.1,
}

# 探索対象キー（TS 側 paramKeys と同名・同順）。
PARAM_KEYS = ("lr", "reg", "hidden", "epochs", "init_scale")

# 合成データセットの固定形状（外部データ不要・自己完結の核）。
_N_SAMPLES = 600   # 総サンプル数。
_N_FEATURES = 6    # 特徴次元。
_VAL_FRACTION = 0.2  # held-out 検証に回す割合（リーク無し: 学習に一切使わない）。

# 数値ハイパラの安全レンジ（最適化器が極端値を投げても破綻しないようクランプ）。
# lr 上限は意図的に大きめ（>2 で発散しうる）にして「学習率が大きすぎると精度が落ちる」
# という現実のハイパラ感度を残す（クランプで全部丸めると score がハイパラに鈍感になる）。
_LR_MIN, _LR_MAX = 1e-5, 50.0
_REG_MIN, _REG_MAX = 0.0, 10.0
_HIDDEN_MAX = 64       # 隠れ次元の上限（0 = 線形）。
_EPOCHS_MIN, _EPOCHS_MAX = 1, 2000
_INIT_MIN, _INIT_MAX = 1e-4, 5.0


def _sigmoid(z: np.ndarray) -> np.ndarray:
    """数値安定なシグモイド（オーバーフロー回避のため clip）。"""
    return 1.0 / (1.0 + np.exp(-np.clip(z, -60.0, 60.0)))


def _coerce_params(raw: dict) -> dict:
    """raw params を既定で補完し、各ハイパラを安全レンジにクランプ（決定性・破綻防止）。

    - 非有限値（NaN/Inf）や欠落は既定値に置換。
    - hidden / epochs は整数化。lr / reg / init_scale はレンジクランプ。
    """
    p = dict(_DEFAULT_PARAMS)
    if isinstance(raw, dict):
        for k in PARAM_KEYS:
            if k in raw:
                v = raw[k]
                if isinstance(v, (int, float)) and np.isfinite(v):
                    p[k] = float(v)

    lr = float(np.clip(p["lr"], _LR_MIN, _LR_MAX))
    reg = float(np.clip(p["reg"], _REG_MIN, _REG_MAX))
    hidden = int(np.clip(round(p["hidden"]), 0, _HIDDEN_MAX))
    epochs = int(np.clip(round(p["epochs"]), _EPOCHS_MIN, _EPOCHS_MAX))
    init_scale = float(np.clip(p["init_scale"], _INIT_MIN, _INIT_MAX))
    return {"lr": lr, "reg": reg, "hidden": hidden, "epochs": epochs, "init_scale": init_scale}


def _make_dataset(seed: int) -> tuple:
    """seed 固定で **非自明な** 2 クラス分類の合成データを生成し train/val 分割（リーク無し）。

    決定境界を **XOR 風の非線形**（2 つの主軸の符号積でクラスが決まる）にし、さらに
    クラスを重ねる（中心を近づける）+ ラベルノイズを混ぜることで、ハイパラ（hidden で
    非線形表現力 / lr・epochs で収束 / reg で過学習抑制）の良し悪しが val 精度に効くようにする。
    線形ロジスティック回帰（hidden=0）では XOR 構造を捉えきれず MLP（hidden>0）が有利になる
    ので、最適化器が hidden を上げると score が伸びる勾配が生まれる（外部データ不要・自己完結）。

    決定的（np.random.default_rng(seed) のみ）。val は学習に一切使わない held-out。
    """
    rng = np.random.default_rng(seed)
    n = _N_SAMPLES
    d = _N_FEATURES

    # ガウス特徴。先頭 2 軸の符号積で XOR ラベルを決め、残り軸はノイズ（無関係特徴）。
    x = rng.normal(0.0, 1.0, size=(n, d))
    margin = x[:, 0] * x[:, 1]                       # XOR 風: 同符号=正 / 異符号=負。
    y = (margin > 0.0).astype(float)

    # 境界近傍をあいまいにする（重なり）+ ラベルノイズで Bayes 誤り率を非ゼロにする。
    flip = rng.random(n) < 0.08                      # 8% ラベルノイズ。
    y[flip] = 1.0 - y[flip]
    x = x + rng.normal(0.0, 0.25, size=(n, d))       # 観測ノイズ（境界をぼかす）。

    perm = rng.permutation(n)
    x = x[perm]
    y = y[perm]

    n_val = int(round(n * _VAL_FRACTION))
    x_val, y_val = x[:n_val], y[:n_val]
    x_tr, y_tr = x[n_val:], y[n_val:]

    # 標準化は **train 統計のみ**で行い val に適用（held-out リーク防止）。
    mu = x_tr.mean(axis=0)
    sd = x_tr.std(axis=0) + 1e-8
    x_tr = (x_tr - mu) / sd
    x_val = (x_val - mu) / sd
    return x_tr, y_tr, x_val, y_val


def _train_logreg(x: np.ndarray, y: np.ndarray, p: dict, seed: int) -> tuple:
    """線形ロジスティック回帰（hidden=0）。全バッチ勾配降下・L2 正則化。決定的。

    返り値: (w, b)。発散したら学習を打ち切りその時点の重みを返す。
    """
    rng = np.random.default_rng(seed + 101)
    n, d = x.shape
    w = rng.normal(0.0, p["init_scale"], size=d)
    b = 0.0
    lr, reg = p["lr"], p["reg"]
    for _ in range(p["epochs"]):
        z = x @ w + b
        pred = _sigmoid(z)
        err = pred - y
        grad_w = x.T @ err / n + reg * w
        grad_b = float(err.mean())
        w = w - lr * grad_w
        b = b - lr * grad_b
        if not np.all(np.isfinite(w)) or not np.isfinite(b):
            break  # 発散打ち切り（throw しない）。
    return w, b


def _train_mlp(x: np.ndarray, y: np.ndarray, p: dict, seed: int) -> tuple:
    """1 隠れ層 MLP（hidden>0）。tanh 隠れ層 + シグモイド出力。全バッチ勾配降下・L2。決定的。

    返り値: (w1, b1, w2, b2)。発散したら学習を打ち切る。
    """
    rng = np.random.default_rng(seed + 202)
    n, d = x.shape
    h = p["hidden"]
    s = p["init_scale"]
    w1 = rng.normal(0.0, s, size=(d, h))
    b1 = np.zeros(h)
    w2 = rng.normal(0.0, s, size=h)
    b2 = 0.0
    lr, reg = p["lr"], p["reg"]
    for _ in range(p["epochs"]):
        z1 = x @ w1 + b1
        a1 = np.tanh(z1)
        z2 = a1 @ w2 + b2
        pred = _sigmoid(z2)
        err = pred - y                      # dL/dz2
        grad_w2 = a1.T @ err / n + reg * w2
        grad_b2 = float(err.mean())
        d_a1 = np.outer(err, w2)            # (n,h)
        d_z1 = d_a1 * (1.0 - a1 ** 2)       # tanh'
        grad_w1 = x.T @ d_z1 / n + reg * w1
        grad_b1 = d_z1.mean(axis=0)
        w1 = w1 - lr * grad_w1
        b1 = b1 - lr * grad_b1
        w2 = w2 - lr * grad_w2
        b2 = b2 - lr * grad_b2
        if not (np.all(np.isfinite(w1)) and np.all(np.isfinite(w2))):
            break  # 発散打ち切り。
    return w1, b1, w2, b2


def _predict_logreg(x: np.ndarray, model: tuple) -> np.ndarray:
    w, b = model
    return (_sigmoid(x @ w + b) >= 0.5).astype(float)


def _predict_mlp(x: np.ndarray, model: tuple) -> np.ndarray:
    w1, b1, w2, b2 = model
    a1 = np.tanh(x @ w1 + b1)
    return (_sigmoid(a1 @ w2 + b2) >= 0.5).astype(float)


def evaluate(params: dict, seed: int) -> dict:
    """合成データで分類器を学習し held-out 検証精度を返す。決定的（seed 固定で bit 一致）。

    hidden=0 → 線形ロジスティック回帰、hidden>0 → 1 隠れ層 MLP。
    score = 検証精度（fitness, 大きいほど良い）。train/val acc を診断併記。
    """
    p = _coerce_params(params)
    x_tr, y_tr, x_val, y_val = _make_dataset(int(seed))

    if p["hidden"] <= 0:
        model = _train_logreg(x_tr, y_tr, p, int(seed))
        pred_tr = _predict_logreg(x_tr, model)
        pred_val = _predict_logreg(x_val, model)
    else:
        model = _train_mlp(x_tr, y_tr, p, int(seed))
        pred_tr = _predict_mlp(x_tr, model)
        pred_val = _predict_mlp(x_val, model)

    train_acc = float((pred_tr == y_tr).mean())
    val_acc = float((pred_val == y_val).mean())
    return {
        "score": val_acc,        # held-out 検証精度 = fitness（TS が読む値）。
        "train_acc": train_acc,  # 診断（過学習の検知用）。
        "val_acc": val_acc,
        "n_val": int(len(y_val)),
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stderr.write(f"evaluate.py: bad stdin JSON: {e}\n")
        return 2

    if not isinstance(req, dict):
        sys.stderr.write("evaluate.py: stdin must be a JSON object\n")
        return 2

    params = req.get("params") or {}
    if not isinstance(params, dict):
        sys.stderr.write("evaluate.py: params must be an object\n")
        return 2

    seed = req.get("seed", 0)

    try:
        result = evaluate(params, int(seed))
    except Exception as e:  # noqa: BLE001 — 致命時は非 0 終了（TS 側が低 fitness 化）
        sys.stderr.write(f"evaluate.py: evaluation failed: {type(e).__name__}: {e}\n")
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
