#!/usr/bin/env python3
"""toy-rpsls プレイヤー: 相手の直前の手に勝つ手を出す（決定的カウンター）。

RPSLS では各手はちょうど 2 手に勝ち、2 手に負ける。相手が前ラウンドに出した手 X に対し、
X に勝つ手は 2 つあるので、正準順 [rock, paper, scissors, lizard, spock] で最初に来る
方を選んで決定性を保つ（同じ stdin → 同じ手）。

優劣表（A が B に勝つ）:
  rock     → scissors, lizard
  paper    → rock,     spock
  scissors → paper,    lizard
  lizard   → spock,    paper
  spock    → scissors, rock

X に勝つ手（BEATEN_BY[X] = X を倒せる手、正準順で先頭を採用）:
  scissors を倒す: rock      (rock が正準順で先頭)
  lizard   を倒す: rock
  rock     を倒す: paper
  spock    を倒す: paper
  paper    を倒す: scissors
  ...

履歴が無い初手（round 0）は rock。always-rock 相手なら 2 手目以降 rock を倒す paper を
出して勝ち越す。

プロトコル:
  stdin  ← 1 行 JSON  {round, you:[...], opponent:[...], history:[{you,opponent},...]}
  stdout → 1 行で次の手 'rock' | 'paper' | 'scissors' | 'lizard' | 'spock'

標準ライブラリのみ・決定的。
"""
import sys
import json

# 正準順（決定性のため、複数候補があるとき先頭を選ぶ）。
ORDER = ["rock", "paper", "scissors", "lizard", "spock"]

# A が勝つ相手の集合。
BEATS = {
    "rock": {"scissors", "lizard"},
    "paper": {"rock", "spock"},
    "scissors": {"paper", "lizard"},
    "lizard": {"spock", "paper"},
    "spock": {"scissors", "rock"},
}


def counter(last: str) -> str:
    """last に勝つ手を正準順で先頭から選ぶ。未知の手なら rock。"""
    if last not in BEATS:
        return "rock"
    for move in ORDER:
        if last in BEATS[move]:
            return move
    return "rock"


def decide(state: dict) -> str:
    opponent = state.get("opponent") or []
    if opponent:
        return counter(opponent[-1])
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
