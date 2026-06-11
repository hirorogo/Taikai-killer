#!/usr/bin/env python3
"""X Quest（7並べ）3人自己対戦エンジン。

正本: hirorogo/singyura の reference/base_game_engine.py と doc/ガイド/ゲーム仕様書.md を
移植・整理したもの。大会本番と**同じ盤面ルール**で 7並べを回す最重要パート。

設計方針（CLAUDE.md / 担当仕様）:
  - 標準ライブラリ + numpy のみ。
  - **決定的**: deal は seed 付き擬似乱数（random.Random(seed)）で配るので、同 seed →
    同じ配り。Math.random/Date 非依存（Python の random.Random をローカルに閉じ込める）。
  - State API は本家互換: my_actions() / is_done() / turn_player / next(action, pass_flag) /
    legal_actions() / my_hands()。AI（ai_param.py）と evaluate.py はこの API のみに依存する。

ルール（本家 base_game_engine.py 準拠）:
  - 52 枚を 3 人に配る（numpy array_split = 18/17/17 枚）。
  - 各 7 は配った瞬間に自動で場に出る（start_flag。♢7 を持つ人が先手）。
  - 合法手: 各スートで 7 から連続して伸びる外側 1 枚。A/K の端 + トンネルルール
    （A が出たら反対端の K が出せる／K が出たら A が出せる）。
  - パス 4 回目（pass_count > 3）でバースト = 手札を全部場に出して失格（out_player）。
  - 手札 0 枚で上がり（is_done）。最初に上がった人が勝者。

このファイルは単体でも遊べる（`python engine.py` でランダム自己対戦のデモを 1 戦表示）。
"""
from __future__ import annotations

import random
import sys
from enum import Enum
from typing import Callable, Optional

import numpy as np


class Suit(Enum):
    """カードのスート（マーク）。array の行 index は宣言順（0..3）。"""

    SPADE = "♠"
    CLUB = "♣"
    HEART = "♡"
    DIAMOND = "♢"

    def __str__(self) -> str:
        return self.value

    def __repr__(self) -> str:
        return f"Suit.{self.name}"


class Number(Enum):
    """カードの数字。val=1..13（A..K）、string=表示文字。"""

    ACE = (1, "A")
    TWO = (2, "2")
    THREE = (3, "3")
    FOUR = (4, "4")
    FIVE = (5, "5")
    SIX = (6, "6")
    SEVEN = (7, "7")
    EIGHT = (8, "8")
    NINE = (9, "9")
    TEN = (10, "10")
    JACK = (11, "J")
    QUEEN = (12, "Q")
    KING = (13, "K")

    def __init__(self, val: int, string: str) -> None:
        self.val = val
        self.string = string

    def __str__(self) -> str:
        return self.string

    def __repr__(self) -> str:
        return f"Number.{self.name}"


# index 変換テーブル（num_to_enum で使用）。
_NUMBER_BY_VAL: list[Number] = sorted(Number, key=lambda n: n.val)
_SUIT_LIST: list[Suit] = list(Suit)


class Card:
    """1 枚のカード（suit, number）。等値・ハッシュ可能（集合・手札判定に使う）。"""

    __slots__ = ("suit", "number")

    def __init__(self, suit: Suit, number: Number) -> None:
        if not (isinstance(suit, Suit) and isinstance(number, Number)):
            raise ValueError("Card は Suit/Number Enum で構築する")
        self.suit = suit
        self.number = number

    def __str__(self) -> str:
        return str(self.suit) + str(self.number)

    def __repr__(self) -> str:
        return f"Card({self.__str__()})"

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, Card):
            return False
        return (self.suit, self.number) == (other.suit, other.number)

    def __hash__(self) -> int:
        return hash((self.suit, self.number))


class Hand(list):
    """手札（list 継承）。check/choice で本家 API を踏襲。"""

    def __init__(self, card_list) -> None:
        super().__init__(i for i in card_list)

    def check_number(self) -> list[int]:
        return [i.number.val for i in self]

    def check_suit(self) -> list[str]:
        return [str(i.suit) for i in self]

    def choice(self, card: Card) -> Card:
        if card in self:
            self.remove(card)
            return card
        raise ValueError("手札に無いカードを選んだ")

    def check(self, card: Card) -> bool:
        return card in self


def _build_deck() -> list[Card]:
    """52 枚（スート×数字）を生成。並びは決定的（後で seed shuffle する）。"""
    return [Card(suit, number) for suit in Suit for number in Number]


def deal(players_num: int = 3, seed: Optional[int] = None) -> list[Hand]:
    """52 枚を seed 付きでシャッフルし players_num 人に array_split で配る。

    決定的: 同じ seed → 同じ配り。seed=None ならシステム乱数（非再現）。
    本家 Deck.deal と同じ np.array_split（端数は先頭の山が 1 枚多い）。
    """
    deck = _build_deck()
    rng = random.Random(seed)
    rng.shuffle(deck)
    hands = [Hand(part) for part in np.array_split(np.array(deck, dtype=object), players_num)]
    return hands


class State:
    """7並べのゲーム状態。AI/評価器はこの API だけを触る。

    主要 API:
      - my_actions(): 現手番が出せる Card のリスト（空なら出せない＝要パス）
      - my_hands():   現手番の Hand
      - legal_actions(): 場として今出せる Card 全部（手札を問わない）
      - turn_player:  現手番 index（失格者はスキップ済み）
      - is_done():    現手番の手札が 0 か（本家互換 API。勝者検出には使わない）
      - next(action, pass_flag): 行動を適用した**完全に独立な新しい State** を返す（真に非破壊。
        self は変更しない＝PIMC の枝クローンが安全。共有参照なし）
    """

    def __init__(
        self,
        players_num: int = 3,
        field_cards=None,
        players_cards=None,
        turn_player: Optional[int] = None,
        pass_count=None,
        out_player=None,
        seed: Optional[int] = None,
    ) -> None:
        if players_cards is None:
            # 新規ゲーム: 配って 7 を自動で場に出し、♢7 保持者を先手にする。
            self.players_cards = deal(players_num, seed=seed)
            self.players_num = players_num
            self.field_cards = np.zeros((4, 13), dtype="int64")
            self.start_flags = [0] * self.players_num
            self.pass_count = [0] * self.players_num
            self.out_player: list[int] = []

            for p in range(players_num):
                self.start_flags[p] = self._choice_seven(self.players_cards[p])
            # ♢7 保持者を先手（本家準拠）。万一見つからなければ 0。
            self.turn_player = (
                self.start_flags.index(1) if 1 in self.start_flags else 0
            )
        else:
            # 既存状態の引き継ぎ（next が作る）。
            self.players_cards = players_cards
            self.field_cards = field_cards
            self.players_num = players_num
            self.turn_player = turn_player
            self.pass_count = pass_count
            self.out_player = out_player

    # ───────── 初期配置 ─────────
    def _choice_seven(self, hand: Hand) -> int:
        """配られた 7 を全部場に出す。♢7 を持っていたら start_flag=1（先手）。"""
        start_flag = 0
        if hand.check(Card(Suit.DIAMOND, Number.SEVEN)):
            start_flag = 1
        for suit in Suit:
            card = Card(suit, Number.SEVEN)
            if hand.check(card):
                self.put_card(hand.choice(card))
        return start_flag

    # ───────── 盤面操作 ─────────
    def put_card(self, card: Card) -> None:
        """カードを場（field_cards）に立てる。行=スート、列=数字-1。"""
        row = _SUIT_LIST.index(card.suit)
        self.field_cards[row][card.number.val - 1] = 1

    @staticmethod
    def num_to_enum(num: int) -> Number:
        """1..13 → Number。"""
        return _NUMBER_BY_VAL[num - 1]

    def legal_actions(self) -> list[Card]:
        """場として今出せる Card 全部（手札不問）。本家ロジック + トンネルルール。"""
        actions: list[Card] = []
        for suit in Suit:
            n = _SUIT_LIST.index(suit)
            row = self.field_cards[n]
            small_side = row[0:6][::-1].tolist()  # 6,5,4,3,2,A の順
            large_side = row[7:13].tolist()       # 8,9,10,J,Q,K の順

            is_ace_out = row[0] == 1
            is_king_out = row[12] == 1

            # 7 より小さい側（A-6）の外側 1 枚。
            if small_side.count(1) != 6:
                card_num_val = 6 - small_side.index(0)
                if card_num_val != 1:
                    actions.append(Card(suit, self.num_to_enum(card_num_val)))
                elif row[1] == 1 and not is_ace_out:
                    actions.append(Card(suit, Number.ACE))

            # 7 より大きい側（8-K）の外側 1 枚。
            if large_side.count(1) != 6:
                card_num_val = 8 + large_side.index(0)
                if card_num_val != 13:
                    actions.append(Card(suit, self.num_to_enum(card_num_val)))
                elif row[11] == 1 and not is_king_out:
                    actions.append(Card(suit, Number.KING))

            # トンネルルール: 片端が埋まっていれば反対端を解放。
            if is_ace_out and not is_king_out:
                actions.append(Card(suit, Number.KING))
            elif is_king_out and not is_ace_out:
                actions.append(Card(suit, Number.ACE))

        # 重複除去だが **決定的順序** を保つ（set の反復順は PYTHONHASHSEED 依存で
        # プロセス間非決定になるため使わない）。str キーで安定ソートして返す。
        seen: set[str] = set()
        unique: list[Card] = []
        for c in sorted(actions, key=str):
            key = str(c)
            if key not in seen:
                seen.add(key)
                unique.append(c)
        return unique

    def my_actions(self) -> list[Card]:
        """現手番が実際に出せる Card（合法手 ∩ 手札）。"""
        hand = self.players_cards[self.turn_player]
        return [c for c in self.legal_actions() if hand.check(c)]

    def my_actions_str(self) -> list[str]:
        return [str(c) for c in self.my_actions()]

    def my_hands(self) -> Hand:
        return self.players_cards[self.turn_player]

    def my_hands_str(self) -> list[str]:
        return [str(c) for c in self.players_cards[self.turn_player]]

    # ───────── 状態遷移 ─────────
    def next(self, action: Optional[Card], pass_flag: int = 0) -> "State":
        """行動を適用した**完全に独立な新しい State** を返す（真に非破壊）。

        - 自分（self）は一切変更しない。盤面・手札・pass_count・out_player を**ディープコピー**した
          新 State を作り、その新 State にだけ行動を適用して返す。
        - 非破壊性そのものは play_game / play_table の純シーケンシャル進行では必須でない
          （破壊的進行でも回る）。ただし「同一 root から複数の枝を独立に展開できる」性質は
          test_engine.py が回帰として固定しており（探索系プレイヤーを後から足すときの安全網）、
          ここではその不変条件を保つために非破壊にしている。
          ※ quests.md §4.1 の PIMC プレイヤー自体は**本リポジトリ未実装**。ここで先取りして
            実装はしない（未実装機能を理由にした最適化はしない）。

        手順:
        - 出せる手が無い、または pass_flag=1 ならパス（pass_count++ → バースト判定）。
        - それ以外は action を手札から抜いて場に出す。
        - その後、次の手番（失格者スキップ）に進める。
        """
        # ディープコピー: numpy 盤面は .copy()、手札は Hand 再構築、可変 list はスライスで複製。
        nxt = State(
            players_num=self.players_num,
            field_cards=self.field_cards.copy(),
            players_cards=[Hand(h) for h in self.players_cards],
            turn_player=self.turn_player,
            pass_count=list(self.pass_count),
            out_player=list(self.out_player),
        )

        if not nxt.my_actions():
            # 強制パス（出せるカードが無い）。
            nxt.pass_count[nxt.turn_player] += 1
            nxt._pass_check()
        elif pass_flag == 1:
            # 意図的パス。
            nxt.pass_count[nxt.turn_player] += 1
            nxt._pass_check()
        else:
            nxt.players_cards[nxt.turn_player].remove(action)
            nxt.put_card(action)

        nxt._next_player()
        return nxt

    def _next_player(self) -> None:
        """次の手番へ（失格者 out_player はスキップ）。全員失格なら現状維持。"""
        if len(self.out_player) >= self.players_num:
            return
        for _ in range(self.players_num):
            self.turn_player = (self.turn_player + 1) % self.players_num
            if self.turn_player not in self.out_player:
                return

    def _pass_check(self) -> None:
        """パス回数チェック。4 回目（>3）でバースト = 手札全部を場に出し失格。"""
        if self.pass_count[self.turn_player] > 3:
            for card in list(self.my_hands()):
                self.put_card(card)
            self.players_cards[self.turn_player] = Hand([])
            if self.turn_player not in self.out_player:
                self.out_player.append(self.turn_player)

    def is_done(self) -> bool:
        """現手番（turn_player）の手札が 0 枚か（本家互換 API）。

        注意: これは「現手番の手札が空か」を見るだけで、**勝者検出には使わない**。
        勝者は play_game が next() 適用直後に『今行動した本人が手札 0 かつ非失格』で
        確定する（旧来の is_done()+last_player 方式は上がり手の取り違えを招いたため廃止）。
        """
        return len(self.my_hands()) == 0

    def active_players(self) -> list[int]:
        """まだ失格していないプレイヤー index。"""
        return [p for p in range(self.players_num) if p not in self.out_player]

    def __str__(self) -> str:
        lines = ["場のカード"]
        for n, suit in enumerate(Suit):
            cells = []
            for v in range(13):
                if self.field_cards[n][v] == 1:
                    cells.append(f"{suit}{self.num_to_enum(v + 1)}")
                else:
                    cells.append("--")
            lines.append(" ".join(f"{c:>4}" for c in cells))
        lines.append(f"\n手番 P{self.turn_player}  pass={self.pass_count[self.turn_player]}")
        lines.append("手札: " + " ".join(self.my_hands_str()))
        lines.append("出せる: " + " ".join(self.my_actions_str()))
        return "\n".join(lines)


# AI の型: State を受け (Card|None, pass_flag) を返す。
ActionFn = Callable[[State], "tuple[Optional[Card], int]"]


def play_game(
    action_fns: list[ActionFn],
    seed: Optional[int] = None,
    players_num: int = 3,
    max_turns: int = 2000,
) -> int:
    """1 戦を最後まで回し、勝者の player index を返す。

    - action_fns[i] が player i の方策（State → (Card|None, pass_flag)）。
    - **勝者 = 最初に手札を 0 枚にした非失格プレイヤー。** 行動を適用した**直後**に
      「今行動した本人が手札 0 になったか」を判定して即 return する（critical 修正）。
      旧実装は「ループ先頭で現手番の手札が 0 か」を見ていたが、next() は既に手番を
      次へ進めた後なので、実際に上がった人ではなく『たまたま手札 0 のまま手番が
      回ってきた別人』を検出し、勝者として『直前に行動した人(last_player)』という
      無関係な index を返していた（勝率がノイズ化）。
    - 出せる手が無い手番は方策に関わらず強制パス（next 内で処理）。バーストで
      手札 0 になった失格者は out_player に入るので勝者判定（非失格条件）で除外する。
    - max_turns 到達時は手札最小のアクティブプレイヤーを勝者にする（安全弁・通常到達しない）。

    決定的: seed を渡せば配りが固定。方策が決定的なら勝者も再現する。
    """
    state = State(players_num=players_num, seed=seed)

    for _ in range(max_turns):
        current = state.turn_player
        my_actions = state.my_actions()

        if not my_actions:
            # 強制パス（バーストし得る。バースト放出は失格＝勝者ではない）。
            state = state.next(None, pass_flag=1)
        else:
            action, pass_flag = action_fns[current](state)
            if pass_flag == 1 or action is None:
                state = state.next(None, pass_flag=1)
            else:
                state = state.next(action, pass_flag=0)

        # 上がり検出: 今行動した本人(current)が手札 0 かつ失格でない＝最初の上がり＝勝者。
        # next() 適用直後にここで判定するので、検出ズレ（last_player 方式の取り違え）が無い。
        if (
            len(state.players_cards[current]) == 0
            and current not in state.out_player
        ):
            return current

    # 安全弁: 異常に長引いた場合は手札最小のアクティブプレイヤー勝ち。
    actives = state.active_players()
    if not actives:
        return 0
    return min(actives, key=lambda p: len(state.players_cards[p]))


def play_table(
    action_fns: list[ActionFn],
    seed: Optional[int] = None,
    players_num: int = 3,
    max_turns: int = 2000,
) -> list[int]:
    """1 卓 1 局を最後まで回し、**着順（finish order）**＝早く上がった順の席 index を返す。

    docs/quests.md §4.1 が要求する `playTable(players[]) -> seatResults[]` 相当。
    `play_game` は「最初の上がり者 1 人」しか返さないので 2 位/3 位を区別できず、3 人戦では
    勝率が上限 0.333（多人数なら 1/N）に張り付いて候補間の識別力（最適化の勾配）が弱い。
    本関数は全員の決着順を返すので、evaluate.py が **平均着順 / 順位点**を fitness にできる。

    決着規約（引き分けは稀だが規約として明記）:
      - 手札を 0 にして上がった人を、上がった**順**に finish order の先頭から並べる。
      - バースト失格者（手札を全放出した out_player）は上がりではない。**最下位群**として
        失格した順に上がり者の後ろへ並べる（早く失格した方が上）。
      - max_turns 安全弁に達した場合、未決着のアクティブプレイヤーは手札が少ない順
        （同枚数は席 index 昇順で安定）に上がり者の後ろ・失格者の前へ挿入する。
      - 返り値は長さ players_num の席 index 配列。finish[0]=1 着の席, finish[-1]=最下位の席。

    決定的: seed を渡せば配り・決着順とも再現する（play_game と同一進行ロジック）。
    """
    state = State(players_num=players_num, seed=seed)

    finished: list[int] = []  # 上がった順の席 index。
    busted: list[int] = []    # 失格した順の席 index（最下位群）。
    seen_out = 0              # 直前までに確定していた out_player 数（増分検出用）。

    for _ in range(max_turns):
        current = state.turn_player
        my_actions = state.my_actions()

        if not my_actions:
            state = state.next(None, pass_flag=1)
        else:
            action, pass_flag = action_fns[current](state)
            if pass_flag == 1 or action is None:
                state = state.next(None, pass_flag=1)
            else:
                state = state.next(action, pass_flag=0)

        # 新たにバースト失格した席を、失格した順で最下位群に積む。
        # 既に上がった席（finished）は除外する: 上がり者にも手番が回り続ける
        # （_next_player は out_player しかスキップしない）ため、手札 0 のまま
        # パスを重ねて事後的に out_player 入りし得る。それは「上がり後の空打ち」で
        # あって失格ではないので最下位群に入れない（着順の二重計上を防ぐ）。
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

        # 全席が上がりか失格で決着したら終了。
        if len(finished) + len(busted) >= players_num:
            break

    # 安全弁/未決着: 残りのアクティブを手札少ない順（同数は席昇順で安定）に挿入。
    remaining = [
        p
        for p in range(players_num)
        if p not in finished and p not in busted
    ]
    remaining.sort(key=lambda p: (len(state.players_cards[p]), p))

    return finished + remaining + busted


def random_action_fn(rng: random.Random) -> ActionFn:
    """seed 付きランダム方策。出せる手から一様に 1 枚。空ならパス。"""

    def fn(state: State) -> "tuple[Optional[Card], int]":
        actions = state.my_actions()
        if not actions:
            return None, 1
        # 決定性のため Card を文字列でソートしてから選ぶ。
        actions_sorted = sorted(actions, key=str)
        return rng.choice(actions_sorted), 0

    return fn


def _demo() -> None:
    """`python engine.py` 用デモ: ランダム 3 人で 1 戦回して勝者を表示。"""
    seed = 12345
    rng = random.Random(seed)
    fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
    winner = play_game(fns, seed=seed)
    print(f"seed={seed} winner=P{winner}", file=sys.stderr)
    print(winner)


if __name__ == "__main__":
    _demo()
