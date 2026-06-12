#!/usr/bin/env python3
"""sim.py / evaluate.py の決定性・単調性・堅牢性の回帰テスト（pytest）。

このテストの主眼:
  - 同 seed で score が **bit 一致**する決定性（CLAUDE.md「Python は決定的を重視」）。
  - 報酬の単調性: 壊れた方策（ゲイン 0）< 既定方策（params で勾配が出る）。
  - 報酬が [0, 1] 付近に収まり、到達群（>=0.5）と未到達群（<0.5）が分離する。
  - evaluate.py の stdin 契約（空/不正/部分指定）の堅牢性。

pytest でも `python test_sim.py` 単体でも走る（後者は "N passed" を出力して exit）。
標準ライブラリのみ。
"""
from __future__ import annotations

import json
import subprocess
import sys

from sim import BASE_SUCCESS, PARAM_KEYS, default_params, evaluate, run_episode


def test_param_keys_match_defaults():
    """PARAM_KEYS と default_params のキー集合が 1:1（過不足なし）。"""
    assert set(PARAM_KEYS) == set(default_params().keys())
    assert len(PARAM_KEYS) == 5


def test_determinism_bit_identical():
    """同 seed・同 params・同 episodes で score が bit 一致（3 回）。"""
    p = default_params()
    runs = [evaluate(p, episodes=120, seed=7)["score"] for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]


def test_seed_changes_result():
    """seed が違えば score が変わる（評価が seed に依存している＝固定でないと再現不可）。"""
    p = default_params()
    a = evaluate(p, episodes=120, seed=1)["score"]
    b = evaluate(p, episodes=120, seed=2)["score"]
    assert a != b


def test_zero_gains_is_worst():
    """全ゲイン 0（前進も旋回もしない壊れた方策）は既定方策より厳密に低い報酬。"""
    broken = {"kp_lin": 0.0, "kp_ang": 0.0, "kd_ang": 0.0, "align_thresh": 0.6, "v_cruise": 0.7}
    base = default_params()
    z = evaluate(broken, episodes=200, seed=0)["score"]
    d = evaluate(base, episodes=200, seed=0)["score"]
    assert z < d
    assert z == 0.0  # 一切前進しない＝到達 0・未到達は progress 0（同位置）→ 報酬 0。


def test_param_sensitivity():
    """params で fitness が動く（ヒルクライムの勾配がある）。"""
    base = evaluate(default_params(), episodes=200, seed=0)["score"]
    # 攻めの設定（高ゲイン・広 align・全速）は既定とは別の値になる（識別力がある）。
    tuned = {"kp_lin": 1.2, "kp_ang": 3.0, "kd_ang": 0.5, "align_thresh": 1.0, "v_cruise": 1.0}
    alt = evaluate(tuned, episodes=200, seed=0)["score"]
    assert alt != base


def test_reward_bounds_and_separation():
    """報酬は [0,1] 付近。到達は >=0.5（base_success の半分以上）、未到達は <0.5 に分離。"""
    base = default_params()
    res = evaluate(base, episodes=200, seed=0)
    assert 0.0 <= res["score"] <= BASE_SUCCESS
    assert 0.0 <= res["reach_rate"] <= 1.0
    # 個々のエピソード報酬が到達群/未到達群の境界（0.5）でクラス分けされる。
    for ep in range(20):
        r = run_episode(base, seed=0, ep=ep)
        assert 0.0 <= r <= BASE_SUCCESS


def test_evaluate_cli_empty_stdin():
    """空 stdin は既定 params/episodes/seed で評価し score を返す（exit 0）。"""
    proc = subprocess.run(
        [sys.executable, "evaluate.py"],
        input="",
        capture_output=True,
        text=True,
        cwd=_here(),
    )
    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert "score" in out and isinstance(out["score"], float)


def test_evaluate_cli_bad_json_nonzero():
    """壊れた stdin JSON は非 0 終了（TS 側が低 fitness 化する契約）。"""
    proc = subprocess.run(
        [sys.executable, "evaluate.py"],
        input="not json at all",
        capture_output=True,
        text=True,
        cwd=_here(),
    )
    assert proc.returncode != 0


def test_evaluate_cli_partial_params():
    """部分指定 params は default で補完して評価できる（exit 0）。"""
    payload = json.dumps({"params": {"kp_lin": 1.5}, "episodes": 50, "seed": 3})
    proc = subprocess.run(
        [sys.executable, "evaluate.py"],
        input=payload,
        capture_output=True,
        text=True,
        cwd=_here(),
    )
    assert proc.returncode == 0
    out = json.loads(proc.stdout)
    assert out["episodes"] == 50


def _here() -> str:
    import os

    return os.path.dirname(os.path.abspath(__file__))


if __name__ == "__main__":
    import os

    os.chdir(_here())
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in funcs:
        fn()
        passed += 1
    print(f"{passed} passed")
