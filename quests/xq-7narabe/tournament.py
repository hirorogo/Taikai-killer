#!/usr/bin/env python3
"""7並べ AI の総当たりトーナメント（強さの地に足のついた順位付け）。

目的（docs/quests.md §7.5 の地固め）: random / medium / heuristic(default) / champion(coevolution) /
mc(PIMC) を**同一エンジン上で公平に対戦**させ、平均着順スコアと 1 着率で順位を出す。
「どの AI が本当に強いか」を測ってから最適化する（measure-before-optimize）。LLM 非依存・決定的。

公平性の設計:
  - 3 人卓。AI プールから**相異なる 3 体の組（combinations）**を全列挙し、各組を games 局戦わせる。
  - 各局で座席→AI 割り当てを巡回ローテーション（g%3）するので、席順バイアスが平均で打ち消える
    （games が 3 の倍数のとき厳密に各 AI が各席に均等に座る）。
  - 各 AI は C(K-1,2) 組に均等に出場するので出場数は全 AI 同数（順位比較が公平）。
  - 着順スコア = (N-1-rank)/(N-1)（1 着=1.0 / 最下位=0.0）。evaluate.py と同じ順位点。

決定性: 局 g・席 s ごとに (base_seed, 三つ組 index, g, s) から派生した seed で AI と配りを作る。
  同 base_seed なら順位表が bit 一致再現。

使い方（quests/xq-7narabe/ で実行）:
  python tournament.py [games_per_triple=12] [mc_sim=20] [seed=0]
  ※ mc は 1 手ごとに mc_sim 回プレイアウトするので重い。mc_sim を上げるほど MC は強くなる想定。

標準ライブラリ + engine / ai_param / ai_medium / ai_mc（numpy 経由）のみ。
"""
from __future__ import annotations

import itertools
import json
import os
import random
import sys
from typing import Callable

from ai_medium import make_medium
from ai_param import default_params, make_ai
from ai_mc import make_mc_ai
from engine import play_table, random_action_fn

# AI 定義: (名前, factory(seed)->action_fn)。factory は局・席ごとに per-seed で呼ぶ（決定的・公平）。
AIFactory = Callable[[int], "Callable"]


def _load_params(filename: str) -> "dict | None":
    """quests/xq-7narabe/<filename> を読む（無ければ None）。"""
    path = os.path.join(os.path.dirname(__file__), filename)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _load_champion() -> dict:
    """champion_params.json を読む（無ければ default にフォールバック）。"""
    return _load_params("champion_params.json") or default_params()


def build_pool(mc_sim: int) -> "list[tuple[str, AIFactory]]":
    """対戦に出す AI プールを構築する。各 factory は seed を受け action_fn を返す。
    mc_sim<=0 のときは MC（重い）を除外し、安価な 4 体だけで高 games の清明な順位付けに使う。
    """
    champ = _load_champion()
    pool: "list[tuple[str, AIFactory]]" = [
        ("random", lambda s: random_action_fn(random.Random(s))),
        ("medium", lambda s: make_medium(seed=s)),
        ("heuristic", lambda s: make_ai(default_params(), seed=s)),
        ("champion", lambda s: make_ai(champ, seed=s)),
    ]
    # 混合フィールド最適化の champion があれば加える（§7.6 仮説の検証用）。
    mixed = _load_params("mixed_champion_params.json")
    if mixed is not None:
        pool.append(("mixed_champ", lambda s: make_ai(mixed, seed=s)))
    if mc_sim > 0:
        pool.append((f"mc(sim={mc_sim})", lambda s: make_mc_ai(default_params(), sim_count=mc_sim, seed=s)))
    return pool


def _rank_point(rank_1based: int, n: int) -> float:
    """着順 rank(1..N) → 順位点 [0,1]（1 着=1.0 / 最下位=0.0・等間隔）。"""
    if n <= 1:
        return 1.0
    return (n - rank_1based) / (n - 1)


def round_robin(
    pool: "list[tuple[str, AIFactory]]", games_per_triple: int, base_seed: int
) -> "dict[str, dict]":
    """相異なる 3 体の全組を games_per_triple 局ずつ戦わせ、AI ごとの集計を返す。決定的。"""
    n_players = 3
    stats: "dict[str, dict]" = {
        name: {"score_sum": 0.0, "first": 0, "games": 0} for name, _ in pool
    }

    for tri_idx, triple in enumerate(itertools.combinations(range(len(pool)), n_players)):
        for g in range(games_per_triple):
            # 席→AI 割り当てを巡回ローテーション（席順バイアス除去）。
            rot = g % n_players
            seat_ai = [triple[(seat + rot) % n_players] for seat in range(n_players)]

            fns = []
            for seat, ai_idx in enumerate(seat_ai):
                ai_seed = (base_seed * 1_000_003) ^ (tri_idx * 40_503) ^ (g * 2_246_822_519) ^ (seat + 1)
                fns.append(pool[ai_idx][1](ai_seed & 0xFFFF_FFFF))

            deal_seed = (base_seed + tri_idx * 7919 + g) & 0x7FFF_FFFF
            finish = play_table(fns, seed=deal_seed, players_num=n_players)

            for seat, ai_idx in enumerate(seat_ai):
                name = pool[ai_idx][0]
                rank = finish.index(seat) + 1  # 1..N
                stats[name]["score_sum"] += _rank_point(rank, n_players)
                stats[name]["games"] += 1
                if rank == 1:
                    stats[name]["first"] += 1

    return stats


def main() -> int:
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    mc_sim = int(sys.argv[2]) if len(sys.argv) > 2 else 20
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    pool = build_pool(mc_sim)
    stats = round_robin(pool, games, seed)

    rows = []
    for name, s in stats.items():
        gp = max(1, s["games"])
        rows.append((name, s["score_sum"] / gp, s["first"] / gp, s["games"]))
    rows.sort(key=lambda r: r[1], reverse=True)

    print(f"=== 7並べ 総当たり (games/triple={games}, mc_sim={mc_sim}, seed={seed}) ===")
    print(f"{'AI':<16}{'rank_score':>12}{'first_rate':>12}{'games':>8}")
    for name, score, first, gp in rows:
        print(f"{name:<16}{score:>12.3f}{first:>12.3f}{gp:>8}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
