"""provided テスト（信頼アンカー・改変禁止）。桁条件つき FizzBuzz。
test_cmd: python tests/test_fbp.py → "N passed, M failed" を出力し exit 0/1。"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# (n, expected)
CASES = [
    (1, "1"),
    (2, "2"),
    (3, "Fizz"),    # div3
    (13, "Fizz"),   # contains 3
    (23, "Fizz"),   # contains 3
    (5, "Buzz"),    # div5
    (52, "Buzz"),   # contains 5
    (35, "FizzBuzz"),  # div5 + contains 3
    (53, "FizzBuzz"),  # contains 5 and 3
    (15, "FizzBuzz"),  # div3 + div5
    (7, "7"),
    (8, "8"),
    (31, "Fizz"),   # contains 3
    (50, "Buzz"),   # div5 + contains 5
]


def run() -> None:
    try:
        from main import fizzbuzz_plus  # type: ignore
    except Exception as e:  # noqa: BLE001
        print(f"0 passed, {len(CASES)} failed (import error: {e})")
        sys.exit(1)

    passed = 0
    failed = 0
    for n, exp in CASES:
        try:
            got = fizzbuzz_plus(n)
            assert got == exp, f"fizzbuzz_plus({n})={got!r} expected {exp!r}"
            passed += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL: {e}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    run()
