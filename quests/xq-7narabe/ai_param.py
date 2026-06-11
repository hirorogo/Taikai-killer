#!/usr/bin/env python3
"""パラメータ化ヒューリスティック 7並べ AI（実エンジン engine.State 上で動く）。

make_ai(params: dict) -> action_fn(state) を返す。action_fn は engine.State を受け
(Card|None, pass_flag) を返す決定的方策（engine.ActionFn 互換）。

パラメータ（8 個・orchestrator/quest/xqAdapter.ts paramKeys / evaluate.py PARAM_KEYS と
1:1・同名・同順。TS 最適化器がこのキー集合のベクタを摂動する。値が大きいほどその要素を重視）:
  w_edge_distance    場の端からの距離（7 から遠い札）を優先（道を早く開ける）
  w_blocking         自分が止めると相手が困る境界札を温存（出すと相手の道を開く手を減点）
  w_rank_extreme     A/K 寄り（端ランク）を早めに出す
  w_hold_seven_adj   7 隣接（6/8）を保持して主導権を握る（出すのを抑制＝減点）
  w_suit_balance     手札が多いスートを優先して捌く（連鎖で一気に減らす）
  w_pass_reserve     出し惜しみ＝そのスートで自分の最後の出せる札（出すと連鎖が切れ手番を
                     渡す手）を温存して保留する傾向。序盤ほど強く、終盤は緩む。カードごとに
                     値が変わる独立特徴で、blocking（相手開放回避）とは別軸に結線。
  w_release_urgency  終盤（手札が少ない）ほど出し切りを急ぐ
  w_random_jitter    わずかな探索ノイズ（盤面指紋＋カードから決定的に派生＝同一局面なら再現、
                     別盤面では別ノイズ。盤面非依存で実質効かなかった旧実装を修正）

選択方針:
  出せる合法手それぞれを _card_score でスコア付けし、最大を選ぶ決定的方策。
  同点は str(card) 昇順で割る。出せる手が無いときだけパス（None, 1）。
  7並べは手札を減らすのが基本の勝ち筋なので、出せる手があれば必ず出す。

標準ライブラリ + engine（numpy 経由）のみ。
"""
from __future__ import annotations

import random
from typing import Callable, Optional

from engine import Card, State, Suit, _SUIT_LIST

ActionFn = Callable[[State], "tuple[Optional[Card], int]"]

START_RANK = 7  # 7並べの中心。

# paramKey（8 個）。xqAdapter.ts / evaluate.py と完全一致・同順。
PARAM_KEYS = (
    "w_edge_distance",
    "w_blocking",
    "w_rank_extreme",
    "w_hold_seven_adj",
    "w_suit_balance",
    "w_pass_reserve",
    "w_release_urgency",
    "w_random_jitter",
)


def default_params() -> dict:
    """2025 既定値（xqAdapter.ts initialCandidate / evaluate.py default_params と同値）。"""
    return {
        "w_edge_distance": 1.0,
        "w_blocking": 0.5,
        "w_rank_extreme": 0.3,
        "w_hold_seven_adj": 0.4,
        "w_suit_balance": 0.2,
        "w_pass_reserve": 0.1,
        "w_release_urgency": 0.6,
        "w_random_jitter": 0.05,
    }


def _suit_counts(hand) -> dict:
    counts = {s: 0 for s in Suit}
    for c in hand:
        counts[c.suit] += 1
    return counts


def _opens_for_others(state: State, card: Card, hand) -> int:
    """card を場に出した後、新たに**場として**出せるようになる札のうち、
    自分の手札に無い（＝相手に渡る恐れがある）枚数を返す。

    State を壊さず field_cards を一時的に立てて legal_actions 差分で近似（決定的）。
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
    # 自分が次に出せる分は連鎖（相手開放ではない）。
    return sum(1 for c in opened if c not in hand)


def _board_fingerprint(state: State) -> int:
    """field_cards（盤面）を決定的な int 指紋に畳む。jitter を盤面依存にするための種。

    numpy 盤面の bit を 1 本の int に詰める（52 bit）。PYTHONHASHSEED に依存しない
    （hash() を使わず生 bit を読む）ので、プロセス間でも同一盤面 → 同一指紋で再現する。
    """
    fp = 0
    flat = state.field_cards.reshape(-1).tolist()  # 4*13=52 要素、0/1。
    for bit in flat:
        fp = (fp << 1) | (1 if bit else 0)
    return fp


def _card_jitter(base_seed: int, board_fp: int, card: Card) -> float:
    """(base_seed, 盤面指紋, card) から決定的に 0..1 の探索ノイズを作る。

    盤面を種に混ぜるので「手札枚数と席が同じ別盤面で同一ノイズ」だった旧実装の弱点
    （w_random_jitter が実質効かない＝最適化器を誤誘導）を解消する。決定性は維持
    （seed 固定・同盤面・同カードなら毎回同値。random.Random をローカルに閉じ込める）。
    """
    card_key = (_SUIT_LIST.index(card.suit) << 4) | (card.number.val & 0xF)
    mixed = (base_seed * 1_000_003) ^ (board_fp * 2_654_435_761) ^ (card_key * 40_503)
    return random.Random(mixed & 0xFFFF_FFFF_FFFF_FFFF).random()


def _card_score(
    state: State,
    card: Card,
    params: dict,
    suit_counts: dict,
    hand,
    base_seed: int,
    board_fp: int,
) -> float:
    """出せる合法手 card の優先度スコア（高いほど先に出す）。決定的（seed 固定）。"""
    p = params
    rank = card.number.val

    edge_distance = abs(rank - START_RANK)          # 0..6（7=0, A/K=6）
    rank_extreme = abs(rank - START_RANK) / 6.0     # 0..1
    seven_adj = 1.0 if abs(rank - START_RANK) == 1 else 0.0  # 6 or 8
    suit_count = suit_counts[card.suit]
    opened = _opens_for_others(state, card, hand)   # 相手に渡しうる開放数
    hand_size = max(1, len(hand))
    jitter = _card_jitter(base_seed, board_fp, card)  # 盤面＋カード依存の決定的ノイズ。

    # w_pass_reserve（独立特徴・**カードごとに値が変わる**＝出し惜しみ）:
    # この card が「そのスートで自分が今出せる唯一の外側札」なら、出すと自分の連鎖が
    # 途切れ手番（主導権）を相手に渡す。そういう手を減点して選択肢を温存する。
    # 序盤（手札多）ほど温存圧を強く、終盤（手札少）ほど緩める＝出し切りへ移行する。
    # blocking（opened：相手開放の回避）とは別の特徴に結線するので 2 係数が線形従属にならない
    # （high 指摘の二重計上を解消）。かつ手番内でカード間に差がつくので argmax に効く
    # （手札規模だけの定数では全候補同値になり実質無効化する問題も回避）。
    is_last_outlet_in_suit = 1.0 if suit_count == 1 else 0.0
    reserve_pressure = is_last_outlet_in_suit * ((hand_size - 1) / hand_size)

    score = (
        p["w_edge_distance"] * edge_distance
        + p["w_rank_extreme"] * rank_extreme
        - p["w_hold_seven_adj"] * seven_adj
        + p["w_suit_balance"] * suit_count
        - p["w_blocking"] * opened
        - p["w_pass_reserve"] * reserve_pressure
        + p["w_release_urgency"] * (1.0 / hand_size)
        + p["w_random_jitter"] * jitter
    )
    # 端札（A/K）の安全性は rank_extreme（=1.0 になる）で既に表現されるので、
    # 以前あった追加加点（rank_extreme と二重計上）は削除した（特徴の独立性を保つ）。
    return score


def make_ai(params: Optional[dict] = None, seed: Optional[int] = None) -> ActionFn:
    """パラメータ辞書から決定的方策 action_fn(state) を作る。

    - params は default_params で補完（部分指定 OK、未知キーは無視）。
    - 各合法手を _card_score でスコア付けし最大を選ぶ。同点は str(card) 昇順。
    - seed: w_random_jitter 用の決定的 rng の種（既定 0）。同 seed → 同方策。
    """
    full = default_params()
    if params:
        for k, v in params.items():
            if k in PARAM_KEYS:
                full[k] = float(v)

    base_seed = 0 if seed is None else int(seed)

    def action_fn(state: State) -> "tuple[Optional[Card], int]":
        actions = state.my_actions()
        if not actions:
            return None, 1
        hand = state.my_hands()
        suit_counts = _suit_counts(hand)
        # jitter は盤面指紋＋カードから決定的に派生（盤面非依存だった旧実装の弱点を解消）。
        # 同一局面・同一 seed なら毎回同じノイズ＝再現性を保ちつつ、別盤面では別ノイズになる。
        board_fp = _board_fingerprint(state)
        best = min(
            actions,
            key=lambda c: (
                -_card_score(state, c, full, suit_counts, hand, base_seed, board_fp),
                str(c),
            ),
        )
        return best, 0

    return action_fn
