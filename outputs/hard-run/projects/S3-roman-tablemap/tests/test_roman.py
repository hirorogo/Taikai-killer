"""provided テスト（信頼アンカー・改変禁止）。ローマ数字 ⇔ 整数 厳格双方向変換。

pytest 不要の自己完結ランナー。
test_cmd: python tests/test_roman.py → "N passed, M failed" を出力し exit 0/1。

エッジを厚く（20+ ケース）。一発で全部通すのは難しく、S5 の D22 reflector
(失敗→reflect→retry) を発火させる狙い。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

_RAISE = object()  # sentinel: 期待値が「例外送出」を意味する


# --- to_roman: (n, expected_str) ----------------------------------------
TO_ROMAN_OK = [
    (1, "I"),
    (2, "II"),
    (3, "III"),
    (4, "IV"),          # 減算記法（IIII ではない）
    (5, "V"),
    (8, "VIII"),
    (9, "IX"),          # 減算記法
    (14, "XIV"),
    (40, "XL"),         # 減算記法
    (42, "XLII"),
    (49, "XLIX"),       # IL ではない
    (90, "XC"),
    (99, "XCIX"),       # IC でも XCIX、二重減算なし
    (400, "CD"),
    (444, "CDXLIV"),    # 三段減算
    (900, "CM"),
    (944, "CMXLIV"),
    (1000, "M"),
    (1994, "MCMXCIV"),
    (2024, "MMXXIV"),
    (3000, "MMM"),
    (3549, "MMMDXLIX"),
    (3888, "MMMDCCCLXXXVIII"),  # 最長標準形
    (3999, "MMMCMXCIX"),        # 上限
]

# --- to_roman: 例外系 (n, exc_type) -------------------------------------
TO_ROMAN_RAISE = [
    (0, ValueError),
    (-1, ValueError),
    (4000, ValueError),
    (10000, ValueError),
    (True, TypeError),       # bool は int サブクラスだが弾く
    (1.0, TypeError),        # float
    ("5", TypeError),        # str
]

# --- from_roman: (s, expected_int) --------------------------------------
FROM_ROMAN_OK = [
    ("I", 1),
    ("III", 3),
    ("IV", 4),
    ("IX", 9),
    ("XIV", 14),
    ("XL", 40),
    ("XLII", 42),
    ("XLIX", 49),
    ("XCIX", 99),
    ("CD", 400),
    ("CDXLIV", 444),
    ("CM", 900),
    ("MCMXCIV", 1994),
    ("MMXXIV", 2024),
    ("MMM", 3000),
    ("MMMCMXCIX", 3999),
    ("XIX", 19),     # 大桁の後に小桁が再登場する正当形
]

# --- from_roman: 例外系 (s, exc_type) -----------------------------------
FROM_ROMAN_RAISE = [
    ("", ValueError),         # 空
    ("IIII", ValueError),     # 4連続
    ("XXXX", ValueError),
    ("MMMM", ValueError),     # 4000 相当・4連続
    ("VV", ValueError),       # V は2回不可
    ("LL", ValueError),
    ("DD", ValueError),
    ("IL", ValueError),       # 非標準減算（49 を意図）
    ("IC", ValueError),
    ("XM", ValueError),
    ("VX", ValueError),       # V から減算は不可
    ("IIV", ValueError),      # 二重減算
    ("IXI", ValueError),      # 減算の後に同桁戻り
    ("VIV", ValueError),      # V 重複的並び（9 は IX）
    ("iv", ValueError),       # 小文字
    ("IV ", ValueError),      # 末尾空白
    ("A", ValueError),        # 非ローマ文字
    ("MMMM", ValueError),
    ("IIII", ValueError),
]

# --- from_roman: 型エラー (s, TypeError) --------------------------------
FROM_ROMAN_TYPE = [
    (4, TypeError),
    (None, TypeError),
    (["I"], TypeError),
]

# --- ラウンドトリップ: 全 1..3999 で from_roman(to_roman(n)) == n -------
ROUNDTRIP_SAMPLE = [1, 4, 9, 14, 49, 99, 444, 944, 1994, 2024, 3888, 3999]


def _check_ok(name, fn, arg, expected, results):
    try:
        got = fn(arg)
        if got == expected and type(got) == type(expected):
            results.append((True, None))
        else:
            results.append((False, f"{name}({arg!r})={got!r} expected {expected!r}"))
    except Exception as e:  # noqa: BLE001
        results.append((False, f"{name}({arg!r}) raised {type(e).__name__}: {e}"))


def _check_raise(name, fn, arg, exc_type, results):
    try:
        got = fn(arg)
        results.append((False, f"{name}({arg!r})={got!r} expected {exc_type.__name__}"))
    except exc_type:
        results.append((True, None))
    except Exception as e:  # noqa: BLE001
        results.append(
            (False, f"{name}({arg!r}) raised {type(e).__name__} expected {exc_type.__name__}")
        )


def run() -> None:
    try:
        from main import to_roman, from_roman  # type: ignore
    except Exception as e:  # noqa: BLE001
        total = (
            len(TO_ROMAN_OK) + len(TO_ROMAN_RAISE)
            + len(FROM_ROMAN_OK) + len(FROM_ROMAN_RAISE)
            + len(FROM_ROMAN_TYPE) + len(ROUNDTRIP_SAMPLE)
        )
        print(f"0 passed, {total} failed (import error: {e})")
        sys.exit(1)

    results = []  # list of (ok: bool, msg)

    for n, exp in TO_ROMAN_OK:
        _check_ok("to_roman", to_roman, n, exp, results)
    for n, exc in TO_ROMAN_RAISE:
        _check_raise("to_roman", to_roman, n, exc, results)

    for s, exp in FROM_ROMAN_OK:
        _check_ok("from_roman", from_roman, s, exp, results)
    for s, exc in FROM_ROMAN_RAISE:
        _check_raise("from_roman", from_roman, s, exc, results)
    for s, exc in FROM_ROMAN_TYPE:
        _check_raise("from_roman", from_roman, s, exc, results)

    # round-trip 不変条件
    for n in ROUNDTRIP_SAMPLE:
        try:
            back = from_roman(to_roman(n))
            if back == n:
                results.append((True, None))
            else:
                results.append((False, f"roundtrip from_roman(to_roman({n}))={back!r}"))
        except Exception as e:  # noqa: BLE001
            results.append((False, f"roundtrip({n}) raised {type(e).__name__}: {e}"))

    passed = sum(1 for ok, _ in results if ok)
    failed = sum(1 for ok, _ in results if not ok)
    for ok, msg in results:
        if not ok:
            print(f"FAIL: {msg}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    run()
