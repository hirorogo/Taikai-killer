#!/usr/bin/env python3
"""決定化 Monte-Carlo（簡易 PIMC）AI の評価サイドカー（対ヒューリスティック self-play）。

役割:
  stdin で 1 行 JSON {params, games, seed, sim_count} を受け取り、make_mc_ai(params, sim_count, seed)
  の MC 候補を **既定ヒューリスティック make_ai（default_params）×2** と 3 人卓で `games` 局戦わせ、
  MC 候補の **勝率** を 1 行 JSON {"win_rate": x} で stdout に返す。診断は stderr。

  狙い（docs/quests.md §4.1）: 事前実行＝時間制約なしを活かし、sim_count を上げるほど PIMC が
  強くなる想定。既定ヒューリスティック AI に**勝ち越せるか**（win_rate > 0.5）を確かめる評価器。
  3 人卓で MC 1 + ヒューリスティック 2 なので、ランダム基準（全員同等）は 1/3 ≒ 0.333。
  win_rate > 0.5 なら「ヒューリスティック相手に明確に勝ち越している」と言える。

入力 (stdin, 1 行 JSON):
  {
    "params":    {"w_edge_distance": 1.2, ...},  # ヒューリスティック係数（MC のプレイアウトと相手の両方に使う・部分可）
    "games":     50,                              # 評価局数（>=1、既定 50）
    "seed":      0,                               # 乱数 seed（決定性の要、既定 0）
    "sim_count": 30                               # MC の 1 手あたりプレイアウト本数（>=1、既定 30）
  }

出力 (stdout, 1 行 JSON):
  {"win_rate": 0.56, "games": 50, "sim_count": 30}
  ※ win_rate = MC 候補が 1 着（最初の上がり）になった割合（literal な勝率）。3 人卓なので
    > 0.5 で「ヒューリスティック 2 体に勝ち越し」を意味する。

決定性（CLAUDE.md「Python は標準ライブラリ優先・決定的」）:
  - seed 固定で win_rate は bit 一致。配り seed = seed + g、MC/相手の方策 seed も seed から派生。
  - 席順バイアス除去のため、局 g で MC 候補を席 (g % players) に座らせ、その席が勝者なら勝ち。
  - MC 候補（make_mc_ai）も相手ヒューリスティック（make_ai）も決定的 → 全体決定的。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約・xqAdapter.parseEvalResult と同形）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。

標準ライブラリ + numpy（engine 経由）のみ。
"""
from __future__ import annotations

import json
import sys

from ai_mc import make_mc_ai
from ai_param import make_ai
from engine import play_game

_GAMES_DEFAULT = 50
_SEED_DEFAULT = 0
_SIM_COUNT_DEFAULT = 30
_PLAYERS = 3  # 3 人卓（MC 1 + ヒューリスティック 2）。


def evaluate(params: dict, games: int, seed: int, sim_count: int) -> dict:
    """make_mc_ai(params, sim_count, seed) を対ヒューリスティック make_ai×2 で games 局戦わせ勝率を返す。決定的。

    - MC 候補のプレイアウト方策と相手は同じ params の make_ai（既定ヒューリスティック）。
      つまり「同じ係数のヒューリスティックを、PIMC で 1 手読みするだけで勝ち越せるか」を測る。
    - 席順バイアス除去: 局 g で候補を席 (g % _PLAYERS) に座らせ、勝者がその席なら勝ち。
    """
    n_games = max(1, int(games))
    n_sims = max(1, int(sim_count))

    wins = 0
    for g in range(n_games):
        deal_seed = seed + g
        seat = g % _PLAYERS  # 候補の着席位置（席順バイアス除去）。
        # MC 候補・相手ともに seed から決定的に派生（同 seed で win_rate bit 一致）。
        mc_fn = make_mc_ai(params, sim_count=n_sims, seed=seed)
        heur_fn = make_ai(params, seed=seed)

        fns = [heur_fn] * _PLAYERS
        fns[seat] = mc_fn

        winner = play_game(fns, seed=deal_seed, players_num=_PLAYERS)
        if winner == seat:
            wins += 1

    return {
        "win_rate": wins / n_games,
        "games": n_games,
        "sim_count": n_sims,
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stderr.write(f"evaluate_mc.py: bad stdin JSON: {e}\n")
        return 2

    if not isinstance(req, dict):
        sys.stderr.write("evaluate_mc.py: stdin must be a JSON object\n")
        return 2

    params = req.get("params") or {}
    if not isinstance(params, dict):
        sys.stderr.write("evaluate_mc.py: params must be an object\n")
        return 2

    games = req.get("games", _GAMES_DEFAULT)
    seed = req.get("seed", _SEED_DEFAULT)
    sim_count = req.get("sim_count", _SIM_COUNT_DEFAULT)

    try:
        result = evaluate(params, int(games), int(seed), int(sim_count))
    except Exception as e:  # noqa: BLE001 — 致命時は非 0 終了（TS 側が低 fitness 化）
        sys.stderr.write(f"evaluate_mc.py: evaluation failed: {type(e).__name__}: {e}\n")
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
