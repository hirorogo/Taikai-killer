#!/usr/bin/env python3
"""Data Quest「知見抽出（data-insight）」評価サイドカー（自己完結・外部データ不要）。

役割（TS 側 orchestrator/quest/dataInsightAdapter.ts の evaluate と 1:1 の契約）:
  stdin で 1 行 JSON {params, seed} を受け取り、seed 固定で **合成テーブル**（数値特徴 10 列
  ＋無関係なノイズ列＋既知の真の関係を持つターゲット）を生成し、params（各特徴の選択重み
  sel_0..sel_9・選択閾値 sel_threshold・回帰の正則化 ridge）で **どの特徴を使うか** を決め、
  選んだ特徴だけで最小二乗回帰モデルを **train で当てはめ**、**held-out で予測 R^2** を測り
  1 行 JSON {"score": r2} で stdout に返す。診断は stderr。

  これは ai-hyperopt（モデルのハイパラ最適化）とは**狙いが違う**: ここで測るのは
  「**特徴選択＋集計の質**」。真に効く少数の特徴を選び、無関係なノイズ列を**選ばない**ほど
  held-out R^2 が上がる（ノイズ列を入れると過適合して held-out で劣化する）。最適化器は
  選択重みを動かして「効く列だけを残す」方向に進む（特徴選択そのものが探索対象）。

設計の正: docs/quests.md（Data = 分析/特徴量 + held-out メトリクス / リーク無し / fitness は
大きいほど良い）。sklearn は使わず numpy + 標準ライブラリのみ（CLAUDE.md「numpy 可」）。

入力 (stdin, 1 行 JSON):
  {
    "params": {
      "sel_0": 1.0, ..., "sel_9": 1.0,   # 各特徴の選択重み（sel_threshold 超で採用）
      "sel_threshold": 0.5,              # 選択閾値（これより大きい sel_i の特徴だけ使う）
      "ridge": 0.1                       # 最小二乗のリッジ正則化（>=0。過適合・多重共線性の抑制）
    },
    "seed": 0                            # 乱数 seed（合成テーブル生成を固定 = 決定性の要）
  }
  ※ params は部分指定可。欠落キーは _DEFAULT_PARAMS で補完。非有限値も既定で補完。

出力 (stdout, 1 行 JSON):
  {"score": 0.78, "r2_train": 0.82, "r2_val": 0.78, "n_selected": 4,
   "selected": [0,2,5,7], "n_val": 120}
  ※ TS 側 parseEvalResult は `score` のみ読み fitness にする（R^2 は上限 1、下限なしだが
    TS 側で下限 0 にクランプ）。`score` = held-out 予測 R^2（大きいほど良い = fitness）。

決定性（CLAUDE.md「決定的・seed 固定・set 反復順依存を避ける」）:
  - seed 固定で score は bit 一致。合成テーブル（特徴・ターゲット・ノイズ）と train/val 分割を
    すべて np.random.default_rng(seed) から決定的に作る。最小二乗は閉形式（乱数なし）。
  - 特徴選択は sel_i を **特徴インデックス昇順**で評価する（set 反復順・hash に非依存）。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。
  - 1 列も選ばれない場合は定数予測（ターゲット平均）にフォールバック → R^2=0（throw しない）。

標準ライブラリ + numpy のみ。
"""
from __future__ import annotations

import json
import sys

import numpy as np

# 合成テーブルの固定形状（外部データ不要・自己完結の核）。
# train を小さめ（120 行 = 600 * 0.2）にして、ノイズ列を入れると **過適合で held-out R^2 が
# 明確に落ちる**ようにする（特徴選択の質が score に効く。サンプルが多すぎると無関係列が無害化し
# 「全部選べば良い」になって選択課題が消える）。
# train を意図的に小さく（40 行）し、無関係列を入れると **過適合で held-out R^2 が明確に
# 落ちる**ようにする。サンプルが多いと無関係列が無害化し「全部選べば良い」になって選択課題が
# 消えるため、少サンプル × 強ノイズで「効く列だけ選ぶ質」を score に効かせる（選択課題の核）。
_N_SAMPLES = 200     # 総行数。
_N_FEATURES = 10     # 数値特徴の列数（探索する選択重みの数と一致）。
_VAL_FRACTION = 0.8  # held-out 検証に回す割合（train=40 行と小さく過適合を顕在化）。

# 真に効く特徴のインデックスと係数（既知の真の関係）。残り 6 列は無関係なノイズ列。
# 最適化器の目標は「この 4 列を選び、6 つのノイズ列を選ばない」を sel 重みで再発見すること。
_TRUE_FEATURES = (0, 2, 5, 7)
_TRUE_COEFS = (3.0, -2.2, 1.5, 1.1)
_TARGET_NOISE_SD = 1.2  # ターゲットの観測ノイズ（Bayes 誤差を大きめにして R^2 上限を下げ、
# 無関係列の過適合が held-out で罰せられる余地を作る）。

# 探索対象キー（TS 側 paramKeys と同名・同順）。sel_0..sel_9 + sel_threshold + ridge。
PARAM_KEYS = tuple(f"sel_{i}" for i in range(_N_FEATURES)) + ("sel_threshold", "ridge")

# ハイパラ既定値（部分指定/欠落時に補完）。TS 側 initialCandidate と 1:1・同値。
# 既定は「全特徴を採用（sel=1.0 > 閾値 0.0）」の素朴な出発点 = ノイズ列込みで過適合する局所点。
# 最適とは限らない（むしろ悪い）＝最適化器が sel を下げて効かない列を剪定する勾配がある。
_DEFAULT_PARAMS = {f"sel_{i}": 1.0 for i in range(_N_FEATURES)}
_DEFAULT_PARAMS["sel_threshold"] = 0.0
_DEFAULT_PARAMS["ridge"] = 0.1

# 安全レンジ（最適化器が極端値を投げても破綻しないようクランプ）。
_SEL_MIN, _SEL_MAX = -5.0, 5.0
_THRESH_MIN, _THRESH_MAX = -5.0, 5.0
_RIDGE_MIN, _RIDGE_MAX = 0.0, 1000.0


def _coerce_params(raw: dict) -> dict:
    """raw params を既定で補完し、各値を安全レンジにクランプ（決定性・破綻防止）。

    - 非有限値（NaN/Inf）や欠落は既定値に置換。
    - sel_i / sel_threshold / ridge をそれぞれレンジクランプ。
    """
    p = dict(_DEFAULT_PARAMS)
    if isinstance(raw, dict):
        for k in PARAM_KEYS:
            if k in raw:
                v = raw[k]
                if isinstance(v, (int, float)) and np.isfinite(v):
                    p[k] = float(v)

    out = {}
    for i in range(_N_FEATURES):
        out[f"sel_{i}"] = float(np.clip(p[f"sel_{i}"], _SEL_MIN, _SEL_MAX))
    out["sel_threshold"] = float(np.clip(p["sel_threshold"], _THRESH_MIN, _THRESH_MAX))
    out["ridge"] = float(np.clip(p["ridge"], _RIDGE_MIN, _RIDGE_MAX))
    return out


def _make_table(seed: int) -> tuple:
    """seed 固定で **既知の真の関係を持つ** 合成テーブルを生成し train/val 分割（リーク無し）。

    - 数値特徴 10 列。うち _TRUE_FEATURES（0,2,5,7）だけが _TRUE_COEFS でターゲットに効く。
    - ノイズ列（残り 6 列）は **ターゲットと無相関**だが、いくつかは真の特徴と相関を持たせて
      「無関係だが紛らわしい列」にする（=単純な相関選択を罠にかける）。具体的には
      列 1 は列 0 に相関（冗長）、列 4 は列 2 に相関（冗長）、列 3/6/8/9 は純ノイズ。
      これらを選ぶと held-out で過適合して R^2 が落ちる → 選択の質が問われる。
    - ターゲット y は真の特徴の線形結合 + ガウスノイズ（R^2 上限を 1 未満にする Bayes 誤差）。

    決定的（np.random.default_rng(seed) のみ）。val は当てはめに一切使わない held-out。
    """
    rng = np.random.default_rng(seed)
    n = _N_SAMPLES
    d = _N_FEATURES

    x = rng.normal(0.0, 1.0, size=(n, d))
    # 冗長な相関列（紛らわしいノイズ）: 真の列に強相関だが独自情報は薄い。
    x[:, 1] = 0.9 * x[:, 0] + 0.4 * rng.normal(0.0, 1.0, size=n)  # 列0 の冗長コピー。
    x[:, 4] = 0.9 * x[:, 2] + 0.4 * rng.normal(0.0, 1.0, size=n)  # 列2 の冗長コピー。

    # ターゲット = 真の特徴の線形結合 + 観測ノイズ。切片も足す。
    y = np.full(n, 0.3)
    for idx, coef in zip(_TRUE_FEATURES, _TRUE_COEFS):
        y = y + coef * x[:, idx]
    y = y + rng.normal(0.0, _TARGET_NOISE_SD, size=n)

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


def _select_features(p: dict) -> list:
    """sel_i > sel_threshold を満たす特徴インデックスを **昇順**で返す（決定的・set 非依存）。"""
    thresh = p["sel_threshold"]
    return [i for i in range(_N_FEATURES) if p[f"sel_{i}"] > thresh]


def _fit_ridge(x: np.ndarray, y: np.ndarray, ridge: float) -> np.ndarray:
    """選択済み特徴行列 x（切片列付き）にリッジ回帰を閉形式で当てはめ係数を返す。決定的。

    (X^T X + ridge*I) w = X^T y を解く。切片列（先頭）は正則化しない。
    """
    d = x.shape[1]
    reg = ridge * np.eye(d)
    reg[0, 0] = 0.0  # 切片は正則化しない。
    a = x.T @ x + reg
    b = x.T @ y
    # 特異・悪条件でも落ちないよう lstsq でフォールバック（throw しない）。
    try:
        w = np.linalg.solve(a, b)
    except np.linalg.LinAlgError:
        w, *_ = np.linalg.lstsq(a, b, rcond=None)
    return w


def _r2(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """決定係数 R^2 = 1 - SS_res/SS_tot。定数予測で 0、完全予測で 1。"""
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - y_true.mean()) ** 2))
    if ss_tot <= 0.0:
        return 0.0
    return 1.0 - ss_res / ss_tot


def _design(x: np.ndarray, cols: list) -> np.ndarray:
    """選択列 + 切片列（先頭）の設計行列を作る。cols 空なら切片のみ（=定数予測）。"""
    n = x.shape[0]
    intercept = np.ones((n, 1))
    if not cols:
        return intercept
    return np.hstack([intercept, x[:, cols]])


def evaluate(params: dict, seed: int) -> dict:
    """合成テーブルで特徴選択 → リッジ回帰当てはめ → held-out R^2 を返す。決定的（bit 一致）。

    score = held-out 予測 R^2（fitness, 大きいほど良い）。選んだ列・train R^2 を診断併記。
    1 列も選ばれなければ定数予測（ターゲット平均）→ R^2=0 にフォールバック。
    """
    p = _coerce_params(params)
    x_tr, y_tr, x_val, y_val = _make_table(int(seed))
    cols = _select_features(p)

    xd_tr = _design(x_tr, cols)
    xd_val = _design(x_val, cols)
    w = _fit_ridge(xd_tr, y_tr, p["ridge"])

    pred_tr = xd_tr @ w
    pred_val = xd_val @ w
    r2_train = _r2(y_tr, pred_tr)
    r2_val = _r2(y_val, pred_val)

    return {
        "score": r2_val,        # held-out 予測 R^2 = fitness（TS が読む値）。
        "r2_train": r2_train,   # 診断（過適合の検知用）。
        "r2_val": r2_val,
        "n_selected": int(len(cols)),
        "selected": cols,       # 選ばれた特徴インデックス（昇順）。
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
