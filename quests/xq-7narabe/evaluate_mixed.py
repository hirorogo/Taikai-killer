#!/usr/bin/env python3
"""X Quest「七並べ」**混合フィールド**評価サイドカー（intransitivity drift 対策）。

背景（docs/quests.md §7.6）: 自己対戦のみの coevolution champion は、対 random 単体では強いのに
混合多人数卓では既定ヒューリスティックに負ける（intransitivity）。原因は trainer の相手分布が
本番（多様な相手が混在）と乖離していること。本サイドカーは候補を **random / medium / heuristic が
混ざる卓**で評価し、fitness を「本番に近い相手分布での順位点」にする。これを最適化すれば混合卓で
強い params が得られる、という仮説の評価器。

入出力契約は evaluate.py と互換（xqAdapter の buildEvalPayload/parseEvalResult をそのまま再利用可）:
  stdin  : {"params": {...}, "games": N, "seed": S, "opponents": 2}
  stdout : {"win_rate": <順位点 fitness 0..1>, "first_place_rate": ..., "avg_rank": ..., "games": N,
            "field": ["random","medium","heuristic"]}

混合の作り方（決定的）:
  - 候補は局 g で席 (g % players) に着席（席順バイアス除去・evaluate.py と同方針）。
  - 候補以外の各席は、(seed, g, seat) から決定的に **field = [random, medium, heuristic] から1つ選ぶ**。
    これにより 1 卓に複数種の相手が混在し得る（純 random 卓・純 heuristic 卓に偏らない）。
  - 着順スコア = (N-rank)/(N-1)（1 着=1.0 / 最下位=0.0）。evaluate.py と同一指標。

決定性: 配り seed = seed+g、相手選択・相手 rng は (seed,g,seat) から派生。同 seed で bit 一致。
標準ライブラリ + engine / ai_param / ai_medium（numpy 経由）のみ。
"""
from __future__ import annotations

import json
import random
import sys

from ai_medium import make_medium
from ai_param import default_params, make_ai
from engine import play_table, random_action_fn

_GAMES_DEFAULT = 100
_SEED_DEFAULT = 0
_OPPONENTS_DEFAULT = 2  # 候補以外の人数（3 人戦）。
# 混合フィールドの相手種別（本番に近い多様性）。default heuristic も入れて「強い相手」を含める。
_FIELD = ("random", "medium", "heuristic")


def _make_opponent(kind: str, seed: int):
    """相手種別 → action_fn（決定的）。heuristic は既定 params の make_ai。"""
    if kind == "medium":
        return make_medium(seed=seed)
    if kind == "heuristic":
        return make_ai(default_params(), seed=seed)
    return random_action_fn(random.Random(seed))


def _rank_point(rank_1based: int, players_num: int) -> float:
    if players_num <= 1:
        return 1.0
    return (players_num - rank_1based) / (players_num - 1)


def evaluate(params: dict, games: int, seed: int, opponents: int) -> dict:
    """候補を混合フィールド（random/medium/heuristic 混在）で games 局評価し順位点 fitness を返す。決定的。"""
    n_games = max(1, int(games))
    n_opp = max(1, int(opponents))
    players_num = n_opp + 1

    ai_fn = make_ai(params, seed=seed)

    fitness_sum = 0.0
    first_places = 0
    rank_sum = 0

    for g in range(n_games):
        deal_seed = seed + g
        seat = g % players_num  # 候補の着席位置。

        fns = []
        for seat_idx in range(players_num):
            if seat_idx == seat:
                fns.append(ai_fn)
            else:
                # (seed, g, seat_idx) から相手種別と相手 seed を決定的に選ぶ。
                pick = ((seed * 1_000_003) ^ (g * 2_246_822_519) ^ ((seat_idx + 1) * 40_503)) & 0x7FFF_FFFF
                kind = _FIELD[pick % len(_FIELD)]
                fns.append(_make_opponent(kind, pick))

        finish_order = play_table(fns, seed=deal_seed, players_num=players_num)
        rank = finish_order.index(seat) + 1
        fitness_sum += _rank_point(rank, players_num)
        rank_sum += rank
        if rank == 1:
            first_places += 1

    return {
        "win_rate": fitness_sum / n_games,
        "first_place_rate": first_places / n_games,
        "avg_rank": rank_sum / n_games,
        "games": n_games,
        "field": list(_FIELD),
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stderr.write(f"evaluate_mixed.py: bad stdin JSON: {e}\n")
        return 2
    if not isinstance(req, dict):
        sys.stderr.write("evaluate_mixed.py: stdin must be a JSON object\n")
        return 2

    params = req.get("params") or {}
    if not isinstance(params, dict):
        sys.stderr.write("evaluate_mixed.py: params must be an object\n")
        return 2

    games = req.get("games", _GAMES_DEFAULT)
    seed = req.get("seed", _SEED_DEFAULT)
    opponents = req.get("opponents", _OPPONENTS_DEFAULT)

    try:
        result = evaluate(params, int(games), int(seed), int(opponents))
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"evaluate_mixed.py: evaluation failed: {type(e).__name__}: {e}\n")
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
