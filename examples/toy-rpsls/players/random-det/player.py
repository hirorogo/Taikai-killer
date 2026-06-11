#!/usr/bin/env python3
"""toy-rpsls プレイヤー: round を seed にした「決定的擬似ランダム」で 5 手から選ぶ。

名前は random だが乱数源は持たない（Math.random / 時刻に依存しない）。round 番号だけを
seed にした固定ハッシュ（mulberry32 相当の単純 LCG）で手を選ぶので、同じ round → 同じ手で
完全に決定的・再現可能。5 手を満遍なく散らすため beat-last 系には読まれにくいベースライン。

seed は round のみ（履歴に依存しない）。これにより同じラウンド番号なら相手が誰でも同じ手を
出す＝再現性が最優先（CLAUDE.md「決定論的」「プロンプトは静的」方針に倣う）。

プロトコル:
  stdin  ← 1 行 JSON  {round, you:[...], opponent:[...], history:[{you,opponent},...]}
  stdout → 1 行で次の手 'rock' | 'paper' | 'scissors' | 'lizard' | 'spock'

標準ライブラリのみ・決定的。
"""
import sys
import json

MOVES = ["rock", "paper", "scissors", "lizard", "spock"]


def prng(seed: int) -> int:
    """round を入れると 0..2^32-1 の決定的な値を返す簡易ハッシュ（mulberry32 風）。"""
    x = (seed + 0x9E3779B9) & 0xFFFFFFFF
    x = (x ^ (x >> 16)) & 0xFFFFFFFF
    x = (x * 0x21F0AAAD) & 0xFFFFFFFF
    x = (x ^ (x >> 15)) & 0xFFFFFFFF
    x = (x * 0x735A2D97) & 0xFFFFFFFF
    x = (x ^ (x >> 15)) & 0xFFFFFFFF
    return x


def decide(state: dict) -> str:
    rnd = state.get("round", 0)
    try:
        seed = int(rnd)
    except (TypeError, ValueError):
        seed = 0
    return MOVES[prng(seed) % len(MOVES)]


def main() -> None:
    raw = sys.stdin.read()
    try:
        state = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        state = {}
    print(decide(state))


if __name__ == "__main__":
    main()
