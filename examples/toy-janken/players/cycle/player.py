#!/usr/bin/env python3
"""toy-janken プレイヤー: round 番号で rock→paper→scissors を循環（決定的シーケンス）。

round % 3 で手を選ぶ。履歴に依存せず round だけで一意に決まるので完全に決定的・予測可能。
パターン読みの相手（beat-last 等）には読まれるが、ベースラインの多様性として置く。

プロトコル（battleRunner.ts と一致）:
  stdin  ← 1 行 JSON  {round, you:[...], opponent:[...], history:[{you,opponent},...]}
  stdout → 1 行で次の手 'rock' | 'paper' | 'scissors'

標準ライブラリのみ。
"""
import sys
import json

CYCLE = ["rock", "paper", "scissors"]


def decide(state: dict) -> str:
    rnd = state.get("round", 0)
    try:
        idx = int(rnd) % 3
    except (TypeError, ValueError):
        idx = 0
    return CYCLE[idx]


def main() -> None:
    raw = sys.stdin.read()
    try:
        state = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        state = {}
    print(decide(state))


if __name__ == "__main__":
    main()
