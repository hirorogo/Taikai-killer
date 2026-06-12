#!/usr/bin/env python3
"""固定の中級ヒューリスティック 7並べ AI（評価のベンチマーク相手）。

evaluate.py の `--vs medium`（または payload の opponents 種別）で候補 make_ai を戦わせる
**固定の対戦相手**。random より明確に強く、しかし make_ai（チューニング対象）とは別系統の
シンプルな貪欲方策なので「候補が中級ヒューリスティックに勝ち越せるか」を測れる。

方針（7並べ定石を最小限・固定パラメータで実装）:
  1. 長いスートから捌く（手札の同スート枚数が多い札を優先）。手札が速く減り上がりが早い。
  2. 端寄り（7 から遠い＝A/K 寄り）を優先。詰まり（出せず手番だけ消費）を避ける定石。
  3. 相手の道を開けすぎる手（出すと相手に渡る新規開放が多い手）をわずかに減点。
  これらを**固定係数**の線形和でスコア化し最大を選ぶ。チューニング対象ではない（ベンチマーク
  の安定性のため固定）。出せる手が無いときだけパス。

make_ai（ai_param）とは独立実装で、PARAM_KEYS には依存しない。engine.State の API のみ使う。
決定的（同盤面なら同じ手。同点は str(card) 昇順で割る）。標準ライブラリ + engine のみ。
"""
from __future__ import annotations

from typing import Callable, Optional

from engine import Card, State, Suit, _SUIT_LIST

ActionFn = Callable[[State], "tuple[Optional[Card], int]"]

START_RANK = 7

# 固定係数（中級の強さに調整済み・チューニングしない）。
_W_SUIT = 2.0      # 長いスートから捌く（主係数）。
_W_EDGE = 0.5      # 端寄り（7 から遠い）を優先。
_W_OPEN = 1.0      # 相手への開放を減点。


def _suit_counts(hand) -> dict:
    counts = {s: 0 for s in Suit}
    for c in hand:
        counts[c.suit] += 1
    return counts


def _opens_for_others(state: State, card: Card, hand) -> int:
    """card を出した後に新たに**場として**出せるようになる札のうち自分の手札に無い枚数。

    ai_param._opens_for_others と同じ近似（field_cards を一時的に立てて legal_actions 差分）。
    State を壊さない（saved を必ず戻す）。決定的。
    """
    before = set(state.legal_actions())
    row = _SUIT_LIST.index(card.suit)
    col = card.number.val - 1
    saved = state.field_cards[row][col]
    state.field_cards[row][col] = 1
    try:
        after = set(state.legal_actions())
    finally:
        state.field_cards[row][col] = saved
    opened = (after - before) - {card}
    return sum(1 for c in opened if c not in hand)


def make_medium(seed: Optional[int] = None) -> ActionFn:
    """固定中級ヒューリスティック方策 action_fn(state) を作る（seed は API 互換のため受けるだけ）。

    各合法手を固定係数の線形和でスコア付けし最大を選ぶ。同点は str(card) 昇順で割る（決定的）。
    """

    def action_fn(state: State) -> "tuple[Optional[Card], int]":
        actions = state.my_actions()
        if not actions:
            return None, 1
        hand = state.my_hands()
        counts = _suit_counts(hand)

        def score(card: Card) -> float:
            suit_count = counts[card.suit]
            edge = abs(card.number.val - START_RANK)
            opened = _opens_for_others(state, card, hand)
            return _W_SUIT * suit_count + _W_EDGE * edge - _W_OPEN * opened

        return min(actions, key=lambda c: (-score(c), str(c))), 0

    return action_fn
