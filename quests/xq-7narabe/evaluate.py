#!/usr/bin/env python3
"""X Quest「七並べ（xq-7narabe）」評価サイドカー（実エンジン self-play）。

役割（TS 側 orchestrator/quest/xqAdapter.ts の evaluate と 1:1 の契約）:
  stdin で 1 行 JSON {params, games, seed, opponents} を受け取り、make_ai(params) の
  候補プレイヤーを **実ゲームエンジン engine.py** 上で対 random 相手と `games` 局戦わせ、
  候補の **順位点 fitness** を 1 行 JSON で stdout に返す。診断は stderr。

入力 (stdin, 1 行 JSON):
  {
    "params":   {"w_edge_distance": 1.2, ...},  # ai_param のチューニング値（部分可）
    "games":    100,                             # 評価局数（>=1、既定 100）
    "seed":     0,                               # 乱数 seed（決定性の要、既定 0）
    "opponents":2                                # 候補以外の random 相手数（既定 2 = 3 人戦）
  }
  ※ opponents は「候補以外の人数」。本エンジンは 3 人戦なので opponents=2 が標準。
    互換のため任意 int を受けるが players_num = opponents + 1 にクランプして使う。

出力 (stdout, 1 行 JSON):
  {"win_rate": 0.52, "first_place_rate": 0.33, "avg_rank": 1.9, "games": 100}
  ※ TS 側 parseEvalResult は `win_rate` のみ読み [0,1] にクランプして fitness にする。
    本実装では `win_rate` = **順位点 fitness（着順加重・[0,1] 正規化）** を載せる。
    docs/quests.md §4.1 が「最初の1人勝ちの二値ではなく平均着順／勝点を fitness にせよ」と
    指示しているため、最初の上がり者だけを 1/0 で数える旧 win_rate（3 人戦で上限 0.333 に
    張り付き候補の識別力が弱い）をやめ、**着順を加重した連続値**にして最適化の勾配を増やす。
    互換のため literal な勝率は first_place_rate に、平均着順は avg_rank に併記する（診断用）。

順位点 fitness の定義（着順 → 点・[0,1] 正規化。引き分けは稀でも規約として明記）:
  - N 人戦で着順 r（1 着 = 1, 最下位 = N）に対し point(r) = (N - r) / (N - 1)。
    1 着 = 1.0、最下位 = 0.0、中間は等間隔（3 人なら 1 着 1.0 / 2 着 0.5 / 3 着 0.0）。
  - バースト失格は play_table が最下位群へ回すので最低点に近づく（出し切りを促す）。
  - fitness = 全 games の point(候補の着順) の平均 → [0,1]。決定的。

決定性（CLAUDE.md「Python は標準ライブラリ優先・決定的を重視」）:
  - seed 固定で fitness は bit 一致。配り seed = seed + g、相手 random は (seed,g) から派生。
  - 席順バイアス除去のため、局 g で候補を席 (g % players) に座らせ、その席の着順を採点する。
  - 候補 AI（make_ai）は決定的、相手 random も seed 付き → 全体決定的。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。

標準ライブラリ + numpy（engine 経由）のみ。
"""
from __future__ import annotations

import json
import random
import sys

from ai_param import make_ai
from engine import play_table, random_action_fn

_GAMES_DEFAULT = 100
_SEED_DEFAULT = 0
_OPPONENTS_DEFAULT = 2  # 候補以外の人数（3 人戦）。


def _rank_point(rank_1based: int, players_num: int) -> float:
    """着順（1=1 着 .. N=最下位）→ 順位点 [0,1]。1 着 1.0 / 最下位 0.0 / 等間隔。"""
    if players_num <= 1:
        return 1.0
    return (players_num - rank_1based) / (players_num - 1)


def evaluate(params: dict, games: int, seed: int, opponents: int) -> dict:
    """make_ai(params) を実エンジンで対 random×opponents、games 局戦わせ順位点 fitness を返す。決定的。

    旧実装は「最初の上がり者か否か」の二値勝率だったが（3 人戦で上限 0.333 に張り付き候補の
    識別力が弱い）、docs/quests.md §4.1 に従い **平均着順を順位点 [0,1] に加重した連続 fitness**
    にする。literal な 1 着率（first_place_rate）と平均着順（avg_rank）も診断用に併記する。
    """
    n_games = max(1, int(games))
    n_opp = max(1, int(opponents))
    players_num = n_opp + 1

    ai_fn = make_ai(params, seed=seed)

    fitness_sum = 0.0   # 順位点の総和。
    first_places = 0    # 1 着回数（literal な勝率の分子）。
    rank_sum = 0        # 着順（1..N）の総和（平均着順用）。

    for g in range(n_games):
        deal_seed = seed + g
        seat = g % players_num  # 候補の着席位置（席順バイアス除去）。
        # 相手 random の種を (seed, g) から決定的に導出。
        opp_rng = random.Random((seed * 1_000_003) ^ (g + 1))

        fns = []
        for seat_idx in range(players_num):
            if seat_idx == seat:
                fns.append(ai_fn)
            else:
                fns.append(random_action_fn(random.Random(opp_rng.randrange(1 << 30))))

        # play_table は着順（席 index の決着順）を返す。候補席の 1-based 着順を採点する。
        finish_order = play_table(fns, seed=deal_seed, players_num=players_num)
        rank = finish_order.index(seat) + 1  # 1=1 着 .. N=最下位。

        fitness_sum += _rank_point(rank, players_num)
        rank_sum += rank
        if rank == 1:
            first_places += 1

    return {
        "win_rate": fitness_sum / n_games,        # 順位点 fitness（TS が読む値）。
        "first_place_rate": first_places / n_games,  # literal な 1 着率（診断）。
        "avg_rank": rank_sum / n_games,           # 平均着順（診断、1=最良）。
        "games": n_games,
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

    games = req.get("games", _GAMES_DEFAULT)
    seed = req.get("seed", _SEED_DEFAULT)
    opponents = req.get("opponents", _OPPONENTS_DEFAULT)

    try:
        result = evaluate(params, int(games), int(seed), int(opponents))
    except Exception as e:  # noqa: BLE001 — 致命時は非 0 終了（TS 側が低 fitness 化）
        sys.stderr.write(f"evaluate.py: evaluation failed: {type(e).__name__}: {e}\n")
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
