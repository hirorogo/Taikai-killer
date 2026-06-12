#!/usr/bin/env python3
"""Robo Quest「2輪到達タスク（robo-control）」評価サイドカー（自己完結シミュ）。

役割（TS 側 orchestrator/quest/roboControlAdapter.ts の evaluate と 1:1 の契約）:
  stdin で 1 行 JSON {params, episodes, seed} を受け取り、sim.evaluate(params) で
  制御則を episodes エピソード走らせ、平均報酬 fitness を 1 行 JSON で stdout に返す。
  診断は stderr。

入力 (stdin, 1 行 JSON):
  {
    "params":   {"kp_lin": 0.8, ...},  # 制御ゲイン（部分指定可・未指定は default で補完）
    "episodes": 100,                    # 評価エピソード数（>=1、既定 100）
    "seed":     0                       # 乱数 seed（決定性の要、既定 0）
  }

出力 (stdout, 1 行 JSON):
  {"score": 0.62, "reach_rate": 0.71, "episodes": 100}
  ※ TS 側 parseEvalResult は `score` のみ読み fitness にする（大きいほど良い）。
    score = 全エピソードの報酬平均（到達=速いほど高、未到達=詰めた割合で低く分離）。
    reach_rate は到達率（診断用）。

決定性（CLAUDE.md「Python は標準ライブラリ優先・決定的を重視」）:
  - seed 固定で score は bit 一致。各エピソードの初期姿勢・目標は (seed, ep) から派生。
  - set 反復順・hash() に依存しない（生成はすべて random.Random をローカルに閉じ込め）。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。

標準ライブラリのみ（sim.py 経由、numpy 不要）。
"""
from __future__ import annotations

import json
import sys

from sim import default_params, evaluate, PARAM_KEYS

_EPISODES_DEFAULT = 100
_SEED_DEFAULT = 0


def _merge_params(raw: dict) -> dict:
    """部分指定 params を default_params で補完し、既知キーのみ float 化する。決定的。"""
    full = default_params()
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in PARAM_KEYS:
                try:
                    fv = float(v)
                except (TypeError, ValueError):
                    continue
                # 非有限（NaN/Inf）は既定に委ねる（TS 側 buildEvalPayload と同方針）。
                if fv == fv and fv not in (float("inf"), float("-inf")):
                    full[k] = fv
    return full


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

    raw_params = req.get("params") or {}
    if not isinstance(raw_params, dict):
        sys.stderr.write("evaluate.py: params must be an object\n")
        return 2

    params = _merge_params(raw_params)
    episodes = req.get("episodes", _EPISODES_DEFAULT)
    seed = req.get("seed", _SEED_DEFAULT)

    try:
        result = evaluate(params, int(episodes), int(seed))
    except Exception as e:  # noqa: BLE001 — 致命時は非 0 終了（TS 側が低 fitness 化）
        sys.stderr.write(f"evaluate.py: evaluation failed: {type(e).__name__}: {e}\n")
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
