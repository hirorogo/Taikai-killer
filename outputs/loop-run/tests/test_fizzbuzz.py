"""provided テスト（信頼アンカー）。S5 は改変禁止。pytest 不要の自己完結ランナー。
test_cmd: python tests/test_fizzbuzz.py  →  "N passed, M failed" を出力し exit 0/1。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

CASES = [
    (1, "1"), (2, "2"), (3, "Fizz"), (5, "Buzz"), (6, "Fizz"),
    (7, "7"), (10, "Buzz"), (15, "FizzBuzz"), (30, "FizzBuzz"), (98, "98"),
]


def run() -> None:
    try:
        from main import fizzbuzz  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"0 passed, {len(CASES)} failed (import error: {e})")
        sys.exit(1)

    passed = 0
    failed = 0
    for n, exp in CASES:
        try:
            got = fizzbuzz(n)
            assert got == exp, f"fizzbuzz({n})={got!r} expected {exp!r}"
            passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL: {e}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    run()
