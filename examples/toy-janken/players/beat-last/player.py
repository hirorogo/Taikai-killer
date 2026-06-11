#!/usr/bin/env python3
"""toy-janken プレイヤー: 相手の直前の手に勝つ手を出す（決定的カウンター）。

戦略: 相手が前ラウンドに出した手 X に対し、X に勝つ手を出す。
  rock     ← 相手が scissors  (rock が scissors に勝つ)
  paper    ← 相手が rock
  scissors ← 相手が paper
履歴が無い初手（round 0）は rock。always-rock 相手なら 2 手目以降 paper を出して勝ち越す。

プロトコル（battleRunner.ts と一致）:
  stdin  ← 1 行 JSON  {round, you:[...], opponent:[...], history:[{you,opponent},...]}
  stdout → 1 行で次の手 'rock' | 'paper' | 'scissors'

標準ライブラリのみ・決定的（同じ stdin → 同じ手）。
"""
import sys
import json

# X に勝つ手（X を倒すには？）
BEATS = {"rock": "paper", "paper": "scissors", "scissors": "rock"}


def decide(state: dict) -> str:
    opponent = state.get("opponent") or []
    if opponent:
        last = opponent[-1]
        return BEATS.get(last, "rock")
    return "rock"


def main() -> None:
    raw = sys.stdin.read()
    try:
        state = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        state = {}
    print(decide(state))


if __name__ == "__main__":
    main()
