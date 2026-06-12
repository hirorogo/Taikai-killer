#!/usr/bin/env python3
"""champion/default params を対 random・対 medium で測る計測ヘルパ（docs §7.5 更新用）。

使い方（quests/xq-7narabe/ で実行）:
  python measure.py <params.json> [games] [seed]

evaluate.evaluate を直接呼び、{vs: win_rate(順位点), first_place_rate} を両相手で出す。
LLM 非依存・決定的（evaluate.py と同 seed 規約）。診断用なので stdout に人間可読で出す。
"""
from __future__ import annotations

import json
import sys

from ai_param import default_params
from evaluate import evaluate


def _load_params(path: str) -> dict:
    if path == "default":
        return default_params()
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "default"
    games = int(sys.argv[2]) if len(sys.argv) > 2 else 400
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 12345
    params = _load_params(path)
    for vs in ("random", "medium"):
        r = evaluate(params, games, seed, opponents=2, vs=vs)
        print(
            f"vs {vs:6s}: win_rate(順位点)={r['win_rate']:.3f} "
            f"first_place_rate={r['first_place_rate']:.3f} avg_rank={r['avg_rank']:.3f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
