#!/usr/bin/env python3
"""ai_param.py / evaluate.py の回帰テスト（pytest）。

このテストの主眼（指摘修正のロック）:
  - 勝者検出バグ修正後、make_ai の既定重み(default)が all-zero（実質ランダム同等）を
    有意に上回る（critical 指摘②: fitness が戦略の良し悪しに相関すること）。
  - 勝率が params に正方向で反応する固定ケース（最適化器が勾配を得られる）。
  - w_pass_reserve が w_blocking と線形従属でない（high 指摘③: 二重計上解消の固定）。
    片方だけ動かすと勝率が変わる＝独立な探索次元であること。
  - evaluate の決定性（同 seed → bit 一致）。

pytest でも `python test_ai_param.py` 単体でも走る。標準ライブラリ + numpy のみ。
"""
from __future__ import annotations

from ai_param import default_params, make_ai, PARAM_KEYS
from evaluate import evaluate


def _winrate(params: dict, games: int = 2000, seed: int = 0, opponents: int = 2) -> float:
    return evaluate(params, games, seed, opponents)["win_rate"]


# ───────── default が all-zero / ランダム基準を上回る（critical②）─────────


def test_default_beats_allzero() -> None:
    """既定重みは all-zero（決定的 tie-break のみ＝ほぼランダム）を明確に上回る。

    勝者検出が壊れていた頃は default(0.314) < allzero(0.340) で両方ランダム基準 0.333 と
    区別不能だった。修正後は default が all-zero を有意に上回ること（下限固定）。
    """
    d = default_params()
    z = {k: 0.0 for k in PARAM_KEYS}
    wr_default = _winrate(d)
    wr_zero = _winrate(z)
    assert wr_default > wr_zero, f"default {wr_default} <= allzero {wr_zero}"
    # 3 人戦のランダム基準 = 1/3。default はそれを実質的に上回る（戦略に意味がある）。
    assert wr_default > 0.40, f"default win_rate {wr_default} <= 0.40（戦略が効いていない）"


def test_default_beats_random_baseline() -> None:
    """既定重みは複数 seed 平均でランダム基準(1/3)を確実に上回る。"""
    d = default_params()
    avg = sum(_winrate(d, games=800, seed=s) for s in (0, 1, 2)) / 3.0
    assert avg > 0.40, f"default avg win_rate {avg} <= 0.40"


# ───────── 勝率が params に正方向で反応（最適化の勾配）─────────


def test_winrate_responds_to_a_card_differentiating_param() -> None:
    """カード間に差を付ける係数（w_edge_distance）を動かすと勝率が反応する（平坦でない）。

    numericOptimizer が意味のある勾配を得られることを保証する最低 1 ケース。
    注: w_release_urgency / w_pass_reserve(の定数成分) のように『手番内で全候補に同じ値を
    足す』係数は argmax を変えないので勝率に無反応なのが正しい挙動。ここでは確実にカード間で
    値が変わる w_edge_distance で『params→勝率の反応』を固定する。
    """
    d = default_params()
    lo = dict(d, w_edge_distance=0.0)
    hi = dict(d, w_edge_distance=3.0)
    assert _winrate(lo) != _winrate(hi), "w_edge_distance に勝率が無反応（平坦）"


# ───────── w_pass_reserve の独立性（high③: 二重計上解消）─────────


def test_pass_reserve_is_independent_of_blocking() -> None:
    """w_pass_reserve は w_blocking と別の特徴に結線され、独立に勝率を動かす。

    旧実装は `- w_blocking*opened - w_pass_reserve*opened` で同じ opened を二重減算し、
    2 係数が線形従属＝探索次元が 1 つ潰れていた。修正後は w_pass_reserve だけ動かすと
    （w_blocking 固定でも）勝率が変わる＝独立次元であることを固定する。
    """
    d = default_params()
    base = _winrate(d)
    bumped = _winrate(dict(d, w_pass_reserve=3.0))
    assert base != bumped, "w_pass_reserve が勝率に無反応（blocking と従属している疑い）"


# ───────── 決定性 ─────────


def test_evaluate_is_deterministic() -> None:
    """同 params・同 seed・同局数なら win_rate が bit 一致（CLAUDE.md 決定性要件）。"""
    d = default_params()
    a = evaluate(d, 500, 0, 2)
    b = evaluate(d, 500, 0, 2)
    assert a == b


def test_failfitness_anchoring_not_confused_with_weak_candidate() -> None:
    """正常な弱い候補(all-zero)の勝率は 0 ではなく、評価失敗(0)と区別できる。

    low 指摘⑤の前提を固定: failFitness=0 と『本当に弱い候補』が衝突しないよう、
    最弱に近い all-zero でも勝率は明確に正（>0.2）であること。
    """
    z = {k: 0.0 for k in PARAM_KEYS}
    wr = _winrate(z, games=1000)
    assert wr > 0.2, f"allzero win_rate {wr} が低すぎ（failFitness=0 と混同される）"


# ───────── 単体ランナー（pytest 不要でも走る）─────────


def _run_standalone() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except AssertionError as e:  # noqa: PERF203
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    import sys

    sys.exit(_run_standalone())
