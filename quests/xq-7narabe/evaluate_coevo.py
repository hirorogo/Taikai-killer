#!/usr/bin/env python3
"""X Quest「七並べ」自己対戦コオエボリューション評価サイドカー（challenger 対 champion）。

役割（TS 側 orchestrator/quest/coevolve.ts の spawn と 1:1 の契約）:
  stdin で 1 行 JSON {challenger, opponent, games, seed} を受け取り、make_ai(challenger) の
  挑戦者プレイヤーを **実ゲームエンジン engine.py** 上で make_ai(opponent)（＝champion）の
  相手と 3 人卓で `games` 局戦わせ、挑戦者の **順位点 fitness（着順加重・[0,1]）** を
  1 行 JSON {"win_rate": x} で stdout に返す。診断は stderr。

  evaluate.py（対 random / 対 medium のヒューリスティック評価）と違い、本サイドカーは
  **相手も同じ ai_param のパラメータ化ヒューリスティック（champion params）**である点が肝。
  これにより「challenger を現 champion に対して最大化する」自己対戦探索（FunSearch/AlphaEvolve 型
  コオエボリューション）が成立する（docs/quests.md §4・D18 進化トラック）。

入力 (stdin, 1 行 JSON):
  {
    "challenger": {"w_edge_distance": 1.2, ...},  # 探索中の候補 params（部分可）
    "opponent":   {"w_edge_distance": 1.0, ...},  # 現 champion params（部分可・3 人卓の残り席）
    "games":      100,                            # 評価局数（>=1、既定 100）
    "seed":       0                              # 乱数 seed（決定性の要、既定 0）
  }
  ※ 3 人卓固定（challenger 1 + champion 2）。本番 7並べが 3 人戦のため。
    opponent 欠如時は default_params（ai_param）で補完する。

出力 (stdout, 1 行 JSON):
  {"win_rate": 0.52, "first_place_rate": 0.33, "avg_rank": 1.9, "games": 100}
  ※ TS 側（coevolve.ts / xqAdapter.parseEvalResult と同形）は `win_rate` のみ読み
    [0,1] にクランプして fitness にする。win_rate = 順位点 fitness（着順加重）。
    win_rate > 0.5 は「3 人卓平均で champion 2 体を上回る」を意味する（順位点 0.5 = 中位）。

順位点 fitness の定義（evaluate.py と同一規約。着順 → 点・[0,1] 正規化）:
  - N 人戦で着順 r（1 着 = 1, 最下位 = N）に対し point(r) = (N - r) / (N - 1)。
    3 人なら 1 着 1.0 / 2 着 0.5 / 3 着 0.0。fitness = 全 games の point(挑戦者の着順) 平均。

決定性（CLAUDE.md「Python は標準ライブラリ優先・決定的」）:
  - seed 固定で fitness は bit 一致。配り seed = seed + g。
  - 席順バイアス除去のため、局 g で挑戦者を席 (g % 3) に座らせ、その席の着順を採点する。
  - challenger / champion（make_ai）はともに決定的 → 全体決定的（set 反復順・hash 非依存）。

堅牢性:
  - stdout には JSON 1 個のみ（TS 側 JSON.parse 契約）。
  - stdin 不正/キー欠落は既定で補完。致命時は stderr に出し非 0 終了（TS が低 fitness 化）。

標準ライブラリ + numpy（engine 経由）のみ。
"""
from __future__ import annotations

import json
import sys

from ai_param import make_ai
from engine import play_table

_GAMES_DEFAULT = 100
_SEED_DEFAULT = 0
_PLAYERS = 3  # 3 人卓（challenger 1 + champion 2）。


def _rank_point(rank_1based: int, players_num: int) -> float:
    """着順（1=1 着 .. N=最下位）→ 順位点 [0,1]。1 着 1.0 / 最下位 0.0 / 等間隔。evaluate.py と同一。"""
    if players_num <= 1:
        return 1.0
    return (players_num - rank_1based) / (players_num - 1)


def evaluate(challenger: dict, opponent: dict, games: int, seed: int) -> dict:
    """make_ai(challenger) を make_ai(opponent)×2 と 3 人卓で games 局戦わせ順位点 fitness を返す。決定的。

    - challenger / opponent はともに ai_param のパラメータ化ヒューリスティック（部分指定 OK・
      未指定は default_params で補完）。相手が champion params である点が evaluate.py との違い。
    - 席順バイアス除去: 局 g で challenger を席 (g % _PLAYERS) に座らせ、その席の着順を採点する。
    - challenger / champion の jitter seed は seed 固定で決定的（同 seed で fitness bit 一致）。
    """
    n_games = max(1, int(games))

    fitness_sum = 0.0   # 順位点の総和。
    first_places = 0    # 1 着回数（literal な 1 着率の分子・診断）。
    rank_sum = 0        # 着順（1..N）の総和（平均着順用・診断）。

    challenger_fn = make_ai(challenger, seed=seed)
    champion_fn = make_ai(opponent, seed=seed)

    for g in range(n_games):
        deal_seed = seed + g
        seat = g % _PLAYERS  # 挑戦者の着席位置（席順バイアス除去）。

        fns = [champion_fn] * _PLAYERS
        fns[seat] = challenger_fn

        finish_order = play_table(fns, seed=deal_seed, players_num=_PLAYERS)
        rank = finish_order.index(seat) + 1  # 1=1 着 .. N=最下位。

        fitness_sum += _rank_point(rank, _PLAYERS)
        rank_sum += rank
        if rank == 1:
            first_places += 1

    return {
        "win_rate": fitness_sum / n_games,           # 順位点 fitness（TS が読む値）。
        "first_place_rate": first_places / n_games,  # literal な 1 着率（診断）。
        "avg_rank": rank_sum / n_games,              # 平均着順（診断、1=最良）。
        "games": n_games,
    }


def main() -> int:
    raw = sys.stdin.read()
    try:
        req = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        sys.stderr.write(f"evaluate_coevo.py: bad stdin JSON: {e}\n")
        return 2

    if not isinstance(req, dict):
        sys.stderr.write("evaluate_coevo.py: stdin must be a JSON object\n")
        return 2

    challenger = req.get("challenger") or {}
    opponent = req.get("opponent") or {}
    if not isinstance(challenger, dict) or not isinstance(opponent, dict):
        sys.stderr.write("evaluate_coevo.py: challenger/opponent must be objects\n")
        return 2

    games = req.get("games", _GAMES_DEFAULT)
    seed = req.get("seed", _SEED_DEFAULT)

    try:
        result = evaluate(challenger, opponent, int(games), int(seed))
    except Exception as e:  # noqa: BLE001 — 致命時は非 0 終了（TS 側が低 fitness 化）
        sys.stderr.write(
            f"evaluate_coevo.py: evaluation failed: {type(e).__name__}: {e}\n"
        )
        return 1

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
