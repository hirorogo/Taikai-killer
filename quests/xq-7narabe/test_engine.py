#!/usr/bin/env python3
"""engine.py の決定性・非破壊性・バースト放出の回帰テスト（pytest）。

このテストの主眼（指摘修正のロック）:
  - State.next() が **真に非破壊**であること（self を一切変更せず、返す State が独立参照）。
    → quests.md §4.1 の PIMC「枝を試すたびに状態クローン」前提を engine 側で保証する。
      共有参照で探索木をルートごと汚す回帰（high 指摘）を二度と起こさない。
  - 同 seed で勝者・配りが bit 一致する決定性（CLAUDE.md「Python は決定的を重視」）。
  - バースト（4 回目パス）で手札を全部場に出し、手札が空 = 失格になること。

pytest でも `python test_engine.py` 単体でも走る（後者は "N passed" を出力して exit）。
標準ライブラリ + numpy のみ。
"""
from __future__ import annotations

import os
import random
import subprocess
import sys

import numpy as np

from engine import (
    Card,
    Hand,
    Number,
    State,
    Suit,
    play_game,
    play_table,
    random_action_fn,
)


def _fresh_action(state: State):
    """state の合法手が在れば先頭を、無ければパスを返す（next 呼び出し用の決定的入力）。"""
    acts = state.my_actions()
    if acts:
        return acts[0], 0
    return None, 1


# ───────── 非破壊性（high 指摘の核心）─────────


def test_next_returns_independent_state() -> None:
    """next() の返り値は self と配列参照を共有しない（field/players/pass/out すべて別物）。"""
    s = State(players_num=3, seed=42)
    action, pass_flag = _fresh_action(s)
    s2 = s.next(action, pass_flag)

    assert s2.field_cards is not s.field_cards
    assert s2.players_cards is not s.players_cards
    assert s2.pass_count is not s.pass_count
    assert s2.out_player is not s.out_player
    # 手札 Hand も新インスタンス（中身を変えても self に波及しない）。
    for h_new, h_old in zip(s2.players_cards, s.players_cards):
        assert h_new is not h_old


def test_next_does_not_mutate_self() -> None:
    """next() 後も self の盤面・手番・手札枚数・pass_count が一切変わらない。"""
    s = State(players_num=3, seed=42)
    field_before = s.field_cards.copy()
    turn_before = s.turn_player
    sizes_before = [len(h) for h in s.players_cards]
    pass_before = list(s.pass_count)

    action, pass_flag = _fresh_action(s)
    s.next(action, pass_flag)

    assert np.array_equal(s.field_cards, field_before)
    assert s.turn_player == turn_before
    assert [len(h) for h in s.players_cards] == sizes_before
    assert s.pass_count == pass_before


def test_pimc_style_branching_does_not_contaminate_root() -> None:
    """同一 root から全合法手を分岐展開しても root 状態は不変（PIMC 枝クローンの安全性）。"""
    s = State(players_num=3, seed=7)
    field0 = s.field_cards.copy()
    hands0 = [list(h) for h in s.players_cards]

    for a in s.my_actions():
        child = s.next(a, 0)
        # 子で手を進めても親には波及しない。
        child.put_card(Card(Suit.SPADE, Number.ACE))

    assert np.array_equal(s.field_cards, field0)
    assert [list(h) for h in s.players_cards] == hands0


# ───────── 決定性 ─────────


def test_play_game_is_deterministic() -> None:
    """同 seed・同方策なら勝者が再現する（複数 seed で確認）。"""
    for seed in (0, 1, 99, 12345):
        rng = random.Random(seed)
        fns1 = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        w1 = play_game(fns1, seed=seed)

        rng = random.Random(seed)
        fns2 = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        w2 = play_game(fns2, seed=seed)

        assert w1 == w2
        assert 0 <= w1 < 3


def test_deal_is_deterministic() -> None:
    """同 seed の配りは完全一致、異 seed では（ほぼ確実に）異なる。"""
    a = State(players_num=3, seed=5)
    b = State(players_num=3, seed=5)
    a_hands = [sorted(str(c) for c in h) for h in a.players_cards]
    b_hands = [sorted(str(c) for c in h) for h in b.players_cards]
    assert a_hands == b_hands

    c = State(players_num=3, seed=6)
    c_hands = [sorted(str(c) for c in h) for h in c.players_cards]
    assert a_hands != c_hands


# ───────── バースト（4 回目パス）放出 ─────────


def test_bust_releases_entire_hand() -> None:
    """pass_count が 3 の手番が更にパスするとバースト = 手札を全放出して空・失格になる。"""
    s = State(players_num=3, seed=1)
    p = s.turn_player
    assert len(s.players_cards[p]) > 0  # 先手は配り直後で手札を持つ。

    s.pass_count[p] = 3  # 次のパスで 4 回目 = バースト。
    s2 = s.next(None, pass_flag=1)

    # バーストした本人の手札は空、out_player に入る。
    assert len(s2.players_cards[p]) == 0
    assert p in s2.out_player
    # 非破壊: 元の self は依然として手札を持つ（バーストは新 State にのみ適用）。
    assert len(s.players_cards[p]) > 0
    assert p not in s.out_player


def test_forced_pass_bust_releases_entire_hand() -> None:
    """強制パス経由（my_actions()==[] で next の not my_actions 分岐）のバーストも全放出する。

    high 指摘: 既存テストは pass_flag=1 の意図パス経路しか踏まない。実戦で頻発する
    『合法手ゼロ＝強制パス』も別コードパスでバーストし得るので、ここで固定する。
    手札を場に出せない 1 枚（場に 7 だけの初期盤面で ♠A は 2..6 が無く出せない）にして
    my_actions()==[] を作り、pass_count=3 のまま next(None, pass_flag=0) を呼ぶ（=強制パス経由）。
    """
    s = State(players_num=3, seed=2)
    p = s.turn_player
    # ♠A は場に♠7しか無い初期状態では出せない（A は 2..6 の連鎖が要る）。
    s.players_cards[p] = Hand([Card(Suit.SPADE, Number.ACE)])
    assert s.my_actions() == []  # 合法手ゼロ＝強制パス経路に入る。

    s.pass_count[p] = 3  # 次のパスで 4 回目 = バースト。
    # pass_flag=0 でも my_actions()==[] なら next 内の強制パス分岐を通る。
    s2 = s.next(None, pass_flag=0)

    assert len(s2.players_cards[p]) == 0  # 手札全放出。
    assert p in s2.out_player              # 失格登録。
    # 非破壊: 元の self は手札を保持し未失格のまま。
    assert len(s.players_cards[p]) == 1
    assert p not in s.out_player


def test_game_terminates_within_max_turns() -> None:
    """ランダム自己対戦は安全弁(max_turns)に頼らず通常終了し、勝者を 1 人返す。"""
    for seed in range(8):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        winner = play_game(fns, seed=seed)
        assert winner in (0, 1, 2)


# ───────── 勝者検出（critical 指摘のロック）─────────


def _oracle_first_finisher(fns, seed: int, players_num: int = 3) -> int:
    """play_game とは独立に『最初に手札 0 にした非失格プレイヤー』を再現追跡する参照実装。

    next() 適用直後に『今行動した本人(current)が手札 0 かつ未失格』を判定するだけ。
    旧来の is_done()+last_player 方式の取り違え（上がった人と無関係な index を返す）を
    検出するためのオラクル。
    """
    state = State(players_num=players_num, seed=seed)
    for _ in range(2000):
        current = state.turn_player
        acts = state.my_actions()
        if not acts:
            state = state.next(None, pass_flag=1)
        else:
            action, pass_flag = fns[current](state)
            if pass_flag == 1 or action is None:
                state = state.next(None, pass_flag=1)
            else:
                state = state.next(action, pass_flag=0)
        if len(state.players_cards[current]) == 0 and current not in state.out_player:
            return current
    actives = state.active_players()
    return min(actives, key=lambda p: len(state.players_cards[p])) if actives else 0


def test_winner_is_first_player_to_empty_hand() -> None:
    """play_game の勝者 = 最初に手札 0 にした非失格プレイヤー（seed 横断で常に成立）。

    critical 指摘の核心: 旧実装は『手番が回ってきたたまたま手札 0 の別人』を検出し
    last_player（無関係な直前行動者）を返していた。修正後はオラクルと完全一致する。
    """
    for seed in range(200):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        winner = play_game(fns, seed=seed)

        rng2 = random.Random(seed)
        fns2 = [random_action_fn(random.Random(rng2.random())) for _ in range(3)]
        oracle = _oracle_first_finisher(fns2, seed)

        assert winner == oracle, f"seed={seed}: play_game={winner} oracle={oracle}"


def test_declared_winner_actually_has_empty_hand() -> None:
    """宣言された勝者は『その局で実際に手札を 0 にした非失格プレイヤー』である。

    seed=11 系の回帰（勝者と称された P が手札を残したまま／sizes=[2,3,0] で P1 を返す等）を固定。
    勝者を最後まで再走して、勝者席が確かに手札 0 へ到達し out_player でないことを確認する。
    """
    for seed in range(60):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        winner = play_game(fns, seed=seed)

        # 勝者席を最後まで再走し、勝者が手札 0・非失格で確定する瞬間を検出。
        rng2 = random.Random(seed)
        fns2 = [random_action_fn(random.Random(rng2.random())) for _ in range(3)]
        state = State(players_num=3, seed=seed)
        confirmed = False
        for _ in range(2000):
            current = state.turn_player
            acts = state.my_actions()
            if not acts:
                state = state.next(None, pass_flag=1)
            else:
                a, pf = fns2[current](state)
                state = state.next(
                    a if pf == 0 and a is not None else None,
                    1 if (pf == 1 or a is None) else 0,
                )
            if len(state.players_cards[current]) == 0 and current not in state.out_player:
                assert current == winner, f"seed={seed}: first finisher {current} != winner {winner}"
                confirmed = True
                break
        assert confirmed, f"seed={seed}: no finisher confirmed (unexpected max_turns path)"


# ───────── プロセス間決定性（PYTHONHASHSEED 非依存）─────────


_CROSS_PROC_SNIPPET = (
    "import random, sys\n"
    "from engine import State, play_game, random_action_fn\n"
    "seed = int(sys.argv[1])\n"
    "deal = [sorted(str(c) for c in h) for h in State(players_num=3, seed=seed).players_cards]\n"
    "rng = random.Random(seed)\n"
    "fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]\n"
    "w = play_game(fns, seed=seed)\n"
    "print(repr((deal, w)))\n"
)


def _run_in_subprocess(seed: int, hashseed: str) -> str:
    """別プロセスで PYTHONHASHSEED を固定し、同 seed の deal と winner を文字列で返す。"""
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = hashseed
    # スート記号(♠♣♡♢)を子プロセスが print するので stdout を UTF-8 に固定する。
    # Windows 既定の cp932 では glyph が UnicodeEncodeError になり subprocess が落ちるため。
    env["PYTHONIOENCODING"] = "utf-8"
    here = os.path.dirname(os.path.abspath(__file__))
    proc = subprocess.run(
        [sys.executable, "-c", _CROSS_PROC_SNIPPET, str(seed)],
        cwd=here,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert proc.returncode == 0, f"subprocess failed (HASHSEED={hashseed}): {proc.stderr}"
    return proc.stdout.strip()


def test_deal_and_winner_stable_across_pythonhashseed() -> None:
    """README が約束する『プロセス間 bit 一致（PYTHONHASHSEED 非依存）』を別プロセスで検証する。

    low 指摘: 同一プロセス内の再実行は自明に近い。legal_actions() の安定ソートが将来
    set 反復順へ退行すれば deal/winner はプロセス間で割れる。PYTHONHASHSEED=0 と 1 の
    2 プロセスで deal と winner が一致することを要求して退行を捕まえる。
    """
    for seed in (0, 3, 7):
        out0 = _run_in_subprocess(seed, "0")
        out1 = _run_in_subprocess(seed, "1")
        assert out0 == out1, f"seed={seed}: HASHSEED 0/1 differ:\n{out0}\n{out1}"


# ───────── 安全弁（max_turns 到達時の勝者定義）─────────


def test_safety_valve_winner_is_min_hand_active_player() -> None:
    """max_turns 到達の安全弁経路では『手札最小の非失格プレイヤー』が勝者（docs 準拠）。

    low 指摘: 全 seed が ~50 ターンで通常終了するため安全弁分岐は未検証のデッドパス。
    max_turns を小さく差し込んで安全弁を強制発火させ、勝者定義（手札最小=勝ち）を固定する。
    """
    for seed in range(8):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        # max_turns=2 で確実に安全弁経路へ（通常終了は ~50 ターン）。
        winner = play_game(fns, seed=seed, max_turns=2)

        # 同手順を 2 ターンだけ再走して停止時点の盤面を作り、勝者定義を独立に確認。
        rng2 = random.Random(seed)
        fns2 = [random_action_fn(random.Random(rng2.random())) for _ in range(3)]
        state = State(players_num=3, seed=seed)
        finished_early = False
        for _ in range(2):
            current = state.turn_player
            acts = state.my_actions()
            if not acts:
                state = state.next(None, pass_flag=1)
            else:
                a, pf = fns2[current](state)
                state = state.next(
                    a if pf == 0 and a is not None else None,
                    1 if (pf == 1 or a is None) else 0,
                )
            if len(state.players_cards[current]) == 0 and current not in state.out_player:
                finished_early = True
                break

        if finished_early:
            continue  # 2 ターン以内に上がった稀ケースは安全弁を踏まないのでスキップ。

        actives = state.active_players()
        assert actives, f"seed={seed}: no active players at safety valve"
        expected = min(actives, key=lambda p: len(state.players_cards[p]))
        assert winner == expected, f"seed={seed}: valve winner {winner} != min-hand active {expected}"
        # 安全弁の勝者は失格者を選ばない。
        assert winner not in state.out_player


# ───────── 着順（play_table / medium 指摘のロック）─────────


def test_play_table_returns_full_finish_order() -> None:
    """play_table は長さ N の席 index の置換（着順）を返す。重複・欠落なし。"""
    for seed in range(30):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        order = play_table(fns, seed=seed, players_num=3)
        assert sorted(order) == [0, 1, 2], f"seed={seed}: not a permutation: {order}"


def test_play_table_first_place_matches_play_game_winner() -> None:
    """play_table の 1 着（finish_order[0]）は play_game の勝者と一致する（同一進行ロジック）。"""
    for seed in range(60):
        rng = random.Random(seed)
        fns1 = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        winner = play_game(fns1, seed=seed)

        rng2 = random.Random(seed)
        fns2 = [random_action_fn(random.Random(rng2.random())) for _ in range(3)]
        order = play_table(fns2, seed=seed, players_num=3)

        assert order[0] == winner, f"seed={seed}: table 1st {order[0]} != play_game {winner}"


def test_play_table_is_deterministic() -> None:
    """同 seed・同方策なら着順が bit 一致で再現する。"""
    for seed in (0, 1, 7, 42, 12345):
        rng = random.Random(seed)
        f1 = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        o1 = play_table(f1, seed=seed)

        rng = random.Random(seed)
        f2 = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        o2 = play_table(f2, seed=seed)

        assert o1 == o2


def test_play_table_busted_player_never_first() -> None:
    """常にパスする方策はバースト失格し、決して 1 着にならず最下位群（後半）に来る。

    medium 指摘の核心: 着順を区別できること。1 席だけ常パス AI を座らせ、その席が
    1 着（先頭）には絶対来ず、3 人戦なら 2 着以降（後半）に落ちることを確認する
    （順位点 fitness が出し切りを促す根拠）。他席も巻き込まれてバーストし得るので
    『厳密に最下位』ではなく『1 着でない＝先頭でない』を固定する。
    """
    def always_pass(_state):  # noqa: ANN001,ANN202
        return None, 1

    for seed in range(20):
        rng = random.Random(seed)
        fns = [random_action_fn(random.Random(rng.random())) for _ in range(3)]
        fns[1] = always_pass  # 席 1 は必ずパス → バースト失格。
        order = play_table(fns, seed=seed, players_num=3)
        assert sorted(order) == [0, 1, 2], f"seed={seed}: not a permutation: {order}"
        assert order[0] != 1, f"seed={seed}: passer became 1st: {order}"
        assert order.index(1) >= 1, f"seed={seed}: passer in top: {order}"


# ───────── 単体ランナー（pytest 不要でも走る）─────────


def _run_standalone() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:  # noqa: PERF203,BLE001 — AssertionError 以外の実バグ例外も握って継続
            # low 指摘: AssertionError しか捕捉しないと ValueError/IndexError 等の実バグで
            # run ごとスタックトレース中断し FAIL 1 件として記録されない（partial-first に反する）。
            # 例外型も含めて記録し、残りのテストを止めない。
            failed += 1
            print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(_run_standalone())
