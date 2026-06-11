#!/usr/bin/env python3
"""toy-janken プレイヤー: 常に rock を出す（最も単純な決定的戦略）。

プロトコル（battleRunner.ts と一致）:
  stdin  ← 1 行 JSON  {round, you:[...], opponent:[...], history:[{you,opponent},...]}
  stdout → 1 行で次の手 'rock' | 'paper' | 'scissors'

標準ライブラリのみ。状態は持たず、毎起動 stdin だけで手を決める（fresh context 前提）。
"""
import sys
import json


def decide(state: dict) -> str:
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
