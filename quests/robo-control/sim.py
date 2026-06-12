#!/usr/bin/env python3
"""Robo Quest「2輪到達タスク（robo-control）」の自己完結シミュレータ（物理は自前）。

役割:
  2 輪差動駆動ロボットを平面上のランダムな目標点へ PD 制御で走らせる軽量シミュ。
  外部物理エンジン非依存（標準ライブラリ math のみ）。決定的（seed 固定で bit 一致）。

物理モデル（離散時間・前進オイラー積分）:
  状態 = (x, y, theta)。theta は機体の向き（rad）。
  制御則（params のゲインで決まる PD 方策）:
    - 目標までの距離 dist、目標方向と機体向きの角度差 ang_err（[-pi,pi] に正規化）。
    - 角速度指令 omega = Kp_ang * ang_err - Kd_ang * (ang_err - prev_ang_err)/dt
      （ang_err の符号で旋回方向、微分項で振動を抑える）。
    - 前進速度指令 v = Kp_lin * dist、ただし |ang_err| が align_thresh を超える間は
      旋回優先で前進を絞る（v *= max(0, 1 - |ang_err|/align_thresh)）。
      align_thresh が小さいほど「正確に向いてから進む」保守的方策、大きいほど「曲がりながら
      突っ込む」攻めの方策。最適な閾値は最適化器が探す（params の一要素）。
  速度・角速度はそれぞれ v_max / omega_max でクランプ（飽和）。
  到達判定: dist < goal_radius で成功（その step で停止）。

報酬（大きいほど良い = fitness、[0,1] 付近）:
  1 エピソードの報酬 = 到達なら base_success - time_penalty*(steps/max_steps)
                       未到達なら progress（初期距離に対する詰めた割合）を 0..base_success 未満に圧縮。
  これにより「速く到達 > 遅く到達 > 近づいたが未到達 > 全く近づかない」の順に単調。

決定性:
  - 目標点と初期姿勢はエピソード index と seed から決定的に生成（random.Random((seed,ep)) 派生）。
  - 制御則は params から決定的。浮動小数の集計は固定順（ep 昇順）で安定。
  - set 反復順・hash() に依存しない。

標準ライブラリ（math, random）のみ。
"""
from __future__ import annotations

import math
import random
from typing import Dict, List

# シミュレーション定数（物理スケール。params とは別の固定値）。
DT = 0.1            # 積分ステップ（s）。
MAX_STEPS = 200     # 1 エピソードの最大 step（時間切れ）。
V_MAX = 1.5         # 前進速度の飽和（m/s）。
OMEGA_MAX = 3.0     # 角速度の飽和（rad/s）。
GOAL_RADIUS = 0.25  # 到達半径（m）。
FIELD = 5.0         # 目標生成範囲（±FIELD m の正方形）。
BASE_SUCCESS = 1.0  # 到達時の基礎報酬。
TIME_PENALTY = 0.5  # 到達時の所要時間ペナルティ係数（速い到達ほど高報酬）。

# 制御ゲイン paramKey（5 個・TS roboControlAdapter.ts PARAM_KEYS と 1:1・同名・同順）。
PARAM_KEYS = (
    "kp_lin",       # 距離 → 前進速度の比例ゲイン。
    "kp_ang",       # 角度差 → 角速度の比例ゲイン。
    "kd_ang",       # 角度差の微分ゲイン（旋回の振動抑制）。
    "align_thresh", # この角度差（rad）を超える間は前進を絞り旋回優先（向き合わせ閾値）。
    "v_cruise",     # 前進速度の上限スケール（0..1、v_max への割合。攻め/守りのトレードオフ）。
)


def default_params() -> Dict[str, float]:
    """既定ゲイン（手調整の出発点・TS initialCandidate と同値）。最適とは限らない局所点。"""
    return {
        "kp_lin": 0.8,
        "kp_ang": 2.0,
        "kd_ang": 0.3,
        "align_thresh": 0.6,
        "v_cruise": 0.7,
    }


def _norm_angle(a: float) -> float:
    """角度を [-pi, pi] に正規化（決定的）。"""
    return math.atan2(math.sin(a), math.cos(a))


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def _start_goal(seed: int, ep: int):
    """エピソード ep の初期姿勢 (x,y,theta) と目標 (gx,gy) を決定的に生成。"""
    rng = random.Random((seed * 1_000_003) ^ (ep + 1))
    # ロボットは原点近傍からスタート、向きはランダム。
    x = rng.uniform(-0.5, 0.5)
    y = rng.uniform(-0.5, 0.5)
    theta = rng.uniform(-math.pi, math.pi)
    # 目標は十分離れた位置（最低 1.5m 先）に置く（自明に到達済みを避ける）。
    while True:
        gx = rng.uniform(-FIELD, FIELD)
        gy = rng.uniform(-FIELD, FIELD)
        if math.hypot(gx - x, gy - y) >= 1.5:
            break
    return x, y, theta, gx, gy


def run_episode(params: Dict[str, float], seed: int, ep: int) -> float:
    """1 エピソードを回し報酬（[0,1] 付近・大きいほど良い）を返す。決定的。"""
    p = params
    kp_lin = p["kp_lin"]
    kp_ang = p["kp_ang"]
    kd_ang = p["kd_ang"]
    align_thresh = max(1e-3, p["align_thresh"])  # 0 除算回避。
    v_cruise = _clamp(p["v_cruise"], 0.0, 1.0)

    x, y, theta, gx, gy = _start_goal(seed, ep)
    init_dist = math.hypot(gx - x, gy - y)
    prev_ang_err = 0.0

    for step in range(MAX_STEPS):
        dx = gx - x
        dy = gy - y
        dist = math.hypot(dx, dy)
        if dist < GOAL_RADIUS:
            # 到達: 速いほど高報酬（time_penalty を所要 step 割合で引く）。
            return BASE_SUCCESS - TIME_PENALTY * (step / MAX_STEPS)

        desired = math.atan2(dy, dx)
        ang_err = _norm_angle(desired - theta)

        # 角速度（PD）。微分項は前 step との差分（dt で割る）。
        d_ang = (ang_err - prev_ang_err) / DT
        omega = kp_ang * ang_err - kd_ang * d_ang
        omega = _clamp(omega, -OMEGA_MAX, OMEGA_MAX)
        prev_ang_err = ang_err

        # 前進速度。向きが揃うほど速く、ズレる間は旋回優先で絞る。
        align = max(0.0, 1.0 - abs(ang_err) / align_thresh)
        v = kp_lin * dist * align
        v = _clamp(v, 0.0, V_MAX * v_cruise)

        # 前進オイラー積分（差動駆動の運動学）。
        theta = _norm_angle(theta + omega * DT)
        x += v * math.cos(theta) * DT
        y += v * math.sin(theta) * DT

    # 未到達: 詰めた割合 progress を [0, BASE_SUCCESS) 未満に圧縮（到達より必ず低い）。
    final_dist = math.hypot(gx - x, gy - y)
    progress = 0.0 if init_dist <= 1e-9 else max(0.0, 1.0 - final_dist / init_dist)
    return progress * (BASE_SUCCESS * 0.5)  # 到達群（>=0.5）と未到達群（<0.5）を分離。


def evaluate(params: Dict[str, float], episodes: int, seed: int) -> Dict[str, float]:
    """params の制御則を episodes 回走らせ、平均報酬を fitness として返す。決定的。"""
    n_ep = max(1, int(episodes))
    rewards: List[float] = []
    reaches = 0
    for ep in range(n_ep):
        r = run_episode(params, seed, ep)
        rewards.append(r)
        if r >= BASE_SUCCESS * 0.5:  # 到達群（成功報酬は >=0.5）。
            reaches += 1
    score = sum(rewards) / n_ep
    return {
        "score": score,                 # 平均報酬 = fitness（TS が読む値）。
        "reach_rate": reaches / n_ep,   # 到達率（診断）。
        "episodes": n_ep,
    }
