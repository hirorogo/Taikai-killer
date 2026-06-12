"""provided テスト（信頼アンカー・S5 は改変禁止）。AC2 検証用に**わざと充足不能**にしてある。

同一入力 n=4 に対し "even" と "divisible_by_two" の両方を正解として要求するため、
classify は単一値しか返せず必ずどちらかが落ちる＝どんな実装でも PASS 不能。
これにより D22 ループは maxAttempts 回まで試行し、各失敗で reflector が発火する。
test_cmd: python tests/test_impossible.py  →  "N passed, M failed" を出力し exit 0/1。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# 矛盾ケース: n=4 に2つの相異なる期待値（同時には満たせない）。
CASES = [
    (4, "even"),
    (4, "divisible_by_two"),  # ↑と矛盾＝必ずどちらか失敗
    (3, "odd"),
]


def run() -> None:
    try:
        from main import classify  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"0 passed, {len(CASES)} failed (import error: {e})")
        sys.exit(1)

    passed = 0
    failed = 0
    for n, exp in CASES:
        try:
            got = classify(n)
            assert got == exp, f"classify({n})={got!r} expected {exp!r}"
            passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL: {e}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    run()
