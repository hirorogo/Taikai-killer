#!/usr/bin/env python3
"""Determinization Monte-Carlo（PIMC 簡易版）7並べ AI（engine.State 上で動く）。

make_mc_ai(params, sim_count, seed) -> action_fn(state) を返す。action_fn は engine.State を
受け (Card|None, pass_flag) を返す決定的方策（engine.ActionFn 互換）。

狙い（docs/quests.md §4.1）:
  7並べは不完全情報（相手手札が見えない）多人数ゲーム。PIMC は「相手手札を多数サンプリングし、
  各サンプルを完全情報とみなしてプレイアウトし、結果を集約する」系の手法で強い。事前実行＝
  時間制約なしを活かし、本番では budget（sim_count）を上げるほど強くなる。本ファイルは既存
  ヒューリスティック make_ai を壊さず（読むだけ）、その上に被せる**簡易 PIMC** を新規実装する。

アルゴリズム（make_mc_ai が返す action_fn が現手番で行うこと）:
  1. 現手番（root 席）の合法手 my_actions() を列挙。0 手ならパス（None, 1）。1 手なら即それ。
  2. 各合法手 a について sim_count 回のプレイアウトで**期待スコア**を推定:
       a. 相手の見えない手札を**決定化**する: 全 52 枚から「場に出ている札」と「自分の手札」を
          除いた残り（= 未知札）を seed 付き RNG でシャッフルし、各相手の既知手札枚数ぶん配り直す。
       b. その決定化盤面で root が手 a を打ち、以降は全席を make_ai(params)（決定的ヒューリスティック）
          で最後までプレイアウトする。
       c. プレイアウト結果を root 席の**着順スコア**（1 着=1.0 / 最下位=0.0 を線形に按分）で採点する。
          sim_count 回平均が手 a の期待スコア推定。
  3. 期待スコア最大の手を選ぶ。同点は str(card) 昇順で割る（決定的）。

  ※ 採点を二値勝率（1 着なら 1 / それ以外 0）でなく**着順スコア**にしているのは重要な修正:
    3 人卓で全席が同一プレイアウト方策（ヒューリスティック）だと root の 1 着率は手 a に依らず
    ≈1/3 に張り付き、手の差（信号）が決定化ノイズに埋もれる。その結果 sim_count を上げても
    勝率が上がらない（むしろ揺れて下がる）非単調が生じていた。着順（1 着 / 2 着 / 3 着 / 失格）
    を連続値で採れば、悪い手は平均着順が悪化するので手間の差がはっきり出て、sim_count を増やす
    ほど推定が締まり強くなる（単調性が回復する）。本番の literal な勝率（1 着率）は evaluate_mc.py
    が別途集計するので、内部採点を着順スコアにしても出力契約は変わらない。

決定性（CLAUDE.md「Python は標準ライブラリ優先・決定的」）:
  - 乱数は random.Random をローカルに閉じ込め、(seed, 盤面指紋, 手番席, 手 index, sim index) から
    決定的に派生させる。同 seed・同局面なら毎回同じ決定化列＝勝率推定が bit 一致。
  - set 反復順（PYTHONHASHSEED 依存）に依存しない: 未知札・合法手は str キーで安定ソートしてから扱う。
  - プレイアウトの方策 make_ai も決定的（seed 固定）。

非破壊性: 決定化は engine.State を新規構築して行い、root の self は一切触らない（State.next と同じく
  完全に独立した盤面を作る）。これは PIMC の枝クローン安全性（engine.py の State 非破壊契約）に乗る。

標準ライブラリ + engine / ai_param（numpy 経由）のみ。
"""
from __future__ import annotations

import random
from typing import Callable, Optional

from ai_param import make_ai
from engine import (
    Card,
    Hand,
    Number,
    State,
    Suit,
    _SUIT_LIST,
)

ActionFn = Callable[[State], "tuple[Optional[Card], int]"]


def _board_fingerprint(state: State) -> int:
    """field_cards（盤面）を決定的な int 指紋に畳む（ai_param と同方式・PYTHONHASHSEED 非依存）。

    numpy 盤面の 52 bit を 1 本の int に詰める。hash() を使わず生 bit を読むのでプロセス間でも
    同一盤面 → 同一指紋。決定化 RNG の種に混ぜて「同一局面なら同一サンプル列」を保証する。
    """
    fp = 0
    for bit in state.field_cards.reshape(-1).tolist():
        fp = (fp << 1) | (1 if bit else 0)
    return fp


def _full_deck() -> list[Card]:
    """52 枚（スート×数字）を決定的順序で生成（engine._build_deck と同じ並び）。"""
    return [Card(suit, number) for suit in Suit for number in Number]


def _unknown_cards(state: State, root_seat: int) -> list[Card]:
    """root_seat から見えない札（= 相手の手札になり得る札）を str キー安定ソートで返す。

    未知札 = 全 52 枚 − 場に出ている札 − 自分（root_seat）の手札。
    場に出ている札は field_cards（4×13）から復元する。決定化はこの集合を相手へ配り直す。
    """
    on_field: set[str] = set()
    field = state.field_cards
    for n, suit in enumerate(Suit):
        for v in range(13):
            if field[n][v] == 1:
                on_field.add(str(Card(suit, State.num_to_enum(v + 1))))

    own: set[str] = {str(c) for c in state.players_cards[root_seat]}

    unknown = [
        c for c in _full_deck() if str(c) not in on_field and str(c) not in own
    ]
    # str キーで安定ソート（set 反復順に依存しない決定的順序）。
    unknown.sort(key=str)
    return unknown


def _determinize(state: State, root_seat: int, rng: random.Random) -> State:
    """相手の見えない手札を rng で決定化した**独立な新 State** を返す（root の手札・盤面は不変）。

    - 場札・自分の手札・pass_count・out_player・turn_player はそのまま引き継ぐ。
    - 未知札をシャッフルし、各相手（root 以外）の**既知手札枚数**ぶんを順に配り直す。
      失格者（out_player）や手札 0 の席は 0 枚なので何も受け取らない（枚数保存）。
    - 端数があっても各席の枚数を厳密に保つ（未知札の総数 = 相手の手札枚数合計なので過不足は出ない）。
    """
    unknown = _unknown_cards(state, root_seat)
    shuffled = list(unknown)
    rng.shuffle(shuffled)

    new_hands: list[Hand] = []
    idx = 0
    for seat in range(state.players_num):
        if seat == root_seat:
            # 自分の手札は既知なのでそのまま複製（Hand 再構築で参照を切る）。
            new_hands.append(Hand(state.players_cards[seat]))
            continue
        n = len(state.players_cards[seat])
        new_hands.append(Hand(shuffled[idx : idx + n]))
        idx += n

    return State(
        players_num=state.players_num,
        field_cards=state.field_cards.copy(),
        players_cards=new_hands,
        turn_player=state.turn_player,
        pass_count=list(state.pass_count),
        out_player=list(state.out_player),
    )


def _derive_seed(base_seed: int, board_fp: int, root_seat: int, move_idx: int, sim_idx: int) -> int:
    """(base_seed, 盤面指紋, 手番席, 手 index, sim index) から決定的に 64bit 種を作る。

    決定化シャッフルの再現性を担保する（同一局面・同一 base_seed なら毎回同じサンプル列）。
    hash() を使わず算術混合だけで派生＝PYTHONHASHSEED に依存しない。
    """
    mixed = (
        (base_seed * 1_000_003)
        ^ (board_fp * 2_654_435_761)
        ^ ((root_seat + 1) * 40_503)
        ^ ((move_idx + 1) * 2_246_822_519)
        ^ ((sim_idx + 1) * 3_266_489_917)
    )
    return mixed & 0xFFFF_FFFF_FFFF_FFFF


def make_mc_ai(
    params: Optional[dict] = None,
    sim_count: int = 30,
    seed: Optional[int] = None,
) -> ActionFn:
    """決定化 Monte-Carlo（簡易 PIMC）方策 action_fn(state) を作る。

    各合法手について相手手札を seed 付きでランダム決定化し sim_count 回プレイアウトして**期待着順
    スコア**を推定し、最良手を選ぶ。プレイアウトの方策は make_ai(params)（決定的ヒューリスティック）。
    採点は二値勝率でなく着順スコア（1 着=1.0 / 最下位=0.0）にしている（理由は冒頭 docstring 参照）。

    - params: ヒューリスティック係数（make_ai が default_params で補完）。プレイアウト方策に使う。
    - sim_count: 1 手あたりのプレイアウト本数（budget）。大きいほど推定が安定し強くなる想定。
      0 以下のときは 1 にクランプ（最低 1 本は回す）。
    - seed: 決定化 RNG の種（既定 0）。同 seed・同局面なら毎回同じ手を返す（決定的）。

    返す action_fn は engine.ActionFn 互換（State → (Card|None, pass_flag)）。
    """
    base_seed = 0 if seed is None else int(seed)
    n_sims = max(1, int(sim_count))
    # プレイアウト方策（全席共通の決定的ヒューリスティック）。seed 固定で再現。
    playout_fn = make_ai(params, seed=base_seed)

    def action_fn(state: State) -> "tuple[Optional[Card], int]":
        root_seat = state.turn_player
        actions = state.my_actions()
        if not actions:
            return None, 1
        # 合法手を str キーで安定ソート（決定的な手 index 付け）。
        actions = sorted(actions, key=str)
        if len(actions) == 1:
            return actions[0], 0

        board_fp = _board_fingerprint(state)
        playout_fns = [playout_fn] * state.players_num
        n_players = state.players_num

        # ── Common Random Numbers（共通乱数・分散削減）──
        # 全候補手を **同一の決定化集合**（同じ相手手札）で評価する。手 index を seed に混ぜず
        # sim_idx だけで決定化を作るので、手 A と手 B は同じ盤面サンプル上で比較される（paired）。
        # これにより「手の差」の推定分散が激減し、決定化ノイズに手の優劣が埋もれる旧挙動
        # （sim_count を増やしても弱い・§7.6/§4.2）を直す。State.next は非破壊なので 1 つの det を
        # 全手で使い回せる。
        dets = [
            _determinize(
                state,
                root_seat,
                random.Random(_derive_seed(base_seed, board_fp, root_seat, 0, sim_idx)),
            )
            for sim_idx in range(n_sims)
        ]

        best_action: Optional[Card] = None
        best_score = -1.0  # 期待着順スコア（0..1）の最大。同点は後の str 昇順で割る。

        for action in actions:
            total = 0.0
            for det in dets:
                # root が手 action を打った独立盤面。det は非破壊なので全手で共有して next できる。
                after = det.next(action, pass_flag=0)
                finish = _playout_order(after, playout_fns)
                total += _rank_score(finish, root_seat, n_players)
            score = total / n_sims
            # 期待着順スコア最大を選ぶ。同点は actions が str 昇順なので先勝ち＝str 昇順 tie-break。
            if score > best_score:
                best_score = score
                best_action = action

        # 念のため（理論上ここに来ないが）best が無ければ str 最小を返す。
        if best_action is None:
            best_action = actions[0]
        return best_action, 0

    return action_fn


def _rank_score(finish: "list[int]", seat: int, n_players: int) -> float:
    """着順 finish（finish[0]=1 着席, finish[-1]=最下位席）から seat の着順スコア（0..1）を返す。

    1 着=1.0 / 最下位=0.0 を線形按分（n_players 人なら rank r(0始まり) → (n-1-r)/(n-1)）。
    n_players==1 のときは 1.0（按分不能なので最良扱い）。finish に seat が無い異常時は 0.0。
    二値勝率より勾配が滑らかで、手の良し悪しが平均スコア差として表れる（sim_count の単調性）。
    """
    if n_players <= 1:
        return 1.0
    try:
        r = finish.index(seat)
    except ValueError:
        return 0.0
    return (n_players - 1 - r) / (n_players - 1)


def _playout_order(
    state: State, action_fns: "list[ActionFn]", max_turns: int = 2000
) -> "list[int]":
    """与えた盤面 state を action_fns で最後まで回し、**着順（finish order）**を返す（play_table と同進行）。

    play_table は新規 State を seed から作り直すため「途中盤面からの続行」ができない。PIMC は
    決定化済みの途中盤面からプレイアウトする必要があるので、ここで play_table と同一の着順
    決定ロジックを途中 state 開始で回す（上がり順 → 安全弁未決着は手札少ない順 → 失格順）。
    返り値は長さ players_num の席 index 配列（finish[0]=1 着, finish[-1]=最下位）。
    """
    n = state.players_num
    finished: list[int] = []  # 上がった順の席 index。
    busted: list[int] = []    # 失格した順の席 index（最下位群）。
    seen_out = 0

    for _ in range(max_turns):
        current = state.turn_player
        my_actions = state.my_actions()

        if not my_actions:
            state = state.next(None, pass_flag=1)
        else:
            act, pass_flag = action_fns[current](state)
            if pass_flag == 1 or act is None:
                state = state.next(None, pass_flag=1)
            else:
                state = state.next(act, pass_flag=0)

        # 新たにバースト失格した席を、失格した順で最下位群に積む（上がり済みは除外）。
        if len(state.out_player) > seen_out:
            for p in state.out_player:
                if p not in busted and p not in finished:
                    busted.append(p)
            seen_out = len(state.out_player)

        # 今行動した本人が手札 0 かつ非失格＝上がり。重複なく着順に積む。
        if (
            len(state.players_cards[current]) == 0
            and current not in state.out_player
            and current not in finished
        ):
            finished.append(current)

        if len(finished) + len(busted) >= n:
            break

    remaining = [p for p in range(n) if p not in finished and p not in busted]
    remaining.sort(key=lambda p: (len(state.players_cards[p]), p))
    return finished + remaining + busted


def _demo() -> None:
    """`python ai_mc.py` 用デモ: MC AI を席 0 に、ヒューリスティックを席 1,2 に置き 1 戦回す。"""
    import sys

    from ai_param import default_params
    from engine import play_game

    mc = make_mc_ai(default_params(), sim_count=20, seed=0)
    heur = make_ai(default_params(), seed=0)
    winner = play_game([mc, heur, heur], seed=123)
    print(f"seed=123 winner=P{winner}", file=sys.stderr)
    print(winner)


if __name__ == "__main__":
    _demo()
