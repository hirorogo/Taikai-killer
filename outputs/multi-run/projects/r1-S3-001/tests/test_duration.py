"""provided テスト（信頼アンカー・改変禁止）。継続時間 文字列 ⇔ 秒 厳格版・3関数。

pytest 不要の自己完結ランナー。
test_cmd: python tests/test_duration.py → "N passed, M failed" を出力し exit 0/1。

エッジを厚く（30+ ケース）。一発で全部通すのは難しく、複数 round の
失敗→reflect→retry／いいとこ取り再投入で世代交代しながら改善する狙い。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


# --- parse_duration: (s, expected_int) ----------------------------------
PARSE_OK = [
    ("0s", 0),
    ("1s", 1),
    ("45s", 45),
    ("1m", 60),
    ("2m", 120),
    ("90m", 5400),       # 60以上でも parse はそのまま受理
    ("120s", 120),       # 同上
    ("1h", 3600),
    ("2h", 7200),
    ("1h2m3s", 3723),
    ("1h30m", 5400),
    ("2h2m5s", 7325),
    ("1h0m0s", 3600),    # ゼロ単位も parse 段階では受理（明示記載なし→値そのまま）
    ("0h", 0),
    ("0m", 0),
    ("23h59m59s", 86399),
    ("10h", 36000),
]

# --- parse_duration: 例外系 (s, ValueError) -----------------------------
PARSE_RAISE = [
    ("", ValueError),         # 空
    ("100", ValueError),      # 単位なし
    ("h", ValueError),        # 数値なし単位
    ("m", ValueError),
    ("s", ValueError),
    ("5d", ValueError),       # 未知単位
    ("5H", ValueError),       # 大文字 H
    ("1M", ValueError),       # 大文字 M
    ("1m1h", ValueError),     # 順序違反
    ("1s1m", ValueError),     # 順序違反
    ("1h1h", ValueError),     # 重複
    ("1m1m", ValueError),     # 重複
    ("01h", ValueError),      # 先頭ゼロ
    ("00s", ValueError),      # 先頭ゼロ
    ("-1h", ValueError),      # 符号
    ("1.5h", ValueError),     # 小数
    ("1h 2m", ValueError),    # 内部空白
    (" 1h", ValueError),      # 先頭空白
    ("1h2m3s ", ValueError),  # 末尾空白
    ("1hh", ValueError),      # 不正並び
    ("h1", ValueError),       # 逆順
    ("1x", ValueError),       # 未知単位
]

# --- parse_duration: 型エラー (s, TypeError) ----------------------------
PARSE_TYPE = [
    (60, TypeError),
    (None, TypeError),
    (True, TypeError),        # bool は明示的に弾く
    (1.0, TypeError),
    (["1h"], TypeError),
]

# --- format_duration: (sec, expected_str) -------------------------------
FORMAT_OK = [
    (0, "0s"),                # 特例
    (1, "1s"),
    (59, "59s"),
    (60, "1m"),
    (61, "1m1s"),
    (120, "2m"),
    (3600, "1h"),
    (3601, "1h1s"),
    (3660, "1h1m"),
    (3661, "1h1m1s"),
    (3723, "1h2m3s"),
    (5400, "1h30m"),
    (7325, "2h2m5s"),
    (86399, "23h59m59s"),
    (36000, "10h"),
]

# --- format_duration: 例外系 (sec, exc_type) ----------------------------
FORMAT_RAISE = [
    (-1, ValueError),
    (-3600, ValueError),
    (True, TypeError),        # bool
    (1.0, TypeError),         # float
    ("60", TypeError),        # str
    (None, TypeError),
]

# --- add_durations: (a, b, expected_str) --------------------------------
ADD_OK = [
    ("1h", "30m", "1h30m"),
    ("90m", "90m", "3h"),
    ("0s", "0s", "0s"),
    ("1h59m59s", "1s", "2h"),
    ("45s", "45s", "1m30s"),
    ("2h", "2h", "4h"),
    ("59m", "1m", "1h"),
    ("1h2m3s", "0s", "1h2m3s"),
]

# --- add_durations: 伝播する例外 (a, b, exc_type) -----------------------
ADD_RAISE = [
    ("1m1h", "1s", ValueError),   # a が不正
    ("1h", "100", ValueError),    # b が不正
    ("01h", "1s", ValueError),    # 先頭ゼロ伝播
    (60, "1s", TypeError),        # a の型エラー伝播
    ("1h", None, TypeError),      # b の型エラー伝播
]

# --- ラウンドトリップ: parse_duration(format_duration(sec)) == sec ------
ROUNDTRIP_SAMPLE = [0, 1, 59, 60, 61, 3600, 3661, 3723, 5400, 7325, 86399, 36000]


def _check_ok(name, fn, args, expected, results):
    try:
        got = fn(*args)
        if got == expected and type(got) == type(expected):
            results.append((True, None))
        else:
            results.append((False, f"{name}{args!r}={got!r} expected {expected!r}"))
    except Exception as e:  # noqa: BLE001
        results.append((False, f"{name}{args!r} raised {type(e).__name__}: {e}"))


def _check_raise(name, fn, args, exc_type, results):
    try:
        got = fn(*args)
        results.append((False, f"{name}{args!r}={got!r} expected {exc_type.__name__}"))
    except exc_type:
        results.append((True, None))
    except Exception as e:  # noqa: BLE001
        results.append(
            (False, f"{name}{args!r} raised {type(e).__name__} expected {exc_type.__name__}")
        )


def run() -> None:
    try:
        from main import parse_duration, format_duration, add_durations  # type: ignore
    except Exception as e:  # noqa: BLE001
        total = (
            len(PARSE_OK) + len(PARSE_RAISE) + len(PARSE_TYPE)
            + len(FORMAT_OK) + len(FORMAT_RAISE)
            + len(ADD_OK) + len(ADD_RAISE) + len(ROUNDTRIP_SAMPLE)
        )
        print(f"0 passed, {total} failed (import error: {e})")
        sys.exit(1)

    results = []  # list of (ok: bool, msg)

    for s, exp in PARSE_OK:
        _check_ok("parse_duration", parse_duration, (s,), exp, results)
    for s, exc in PARSE_RAISE:
        _check_raise("parse_duration", parse_duration, (s,), exc, results)
    for s, exc in PARSE_TYPE:
        _check_raise("parse_duration", parse_duration, (s,), exc, results)

    for sec, exp in FORMAT_OK:
        _check_ok("format_duration", format_duration, (sec,), exp, results)
    for sec, exc in FORMAT_RAISE:
        _check_raise("format_duration", format_duration, (sec,), exc, results)

    for a, b, exp in ADD_OK:
        _check_ok("add_durations", add_durations, (a, b), exp, results)
    for a, b, exc in ADD_RAISE:
        _check_raise("add_durations", add_durations, (a, b), exc, results)

    # round-trip 不変条件: parse(format(sec)) == sec
    for sec in ROUNDTRIP_SAMPLE:
        try:
            back = parse_duration(format_duration(sec))
            if back == sec:
                results.append((True, None))
            else:
                results.append((False, f"roundtrip parse(format({sec}))={back!r}"))
        except Exception as e:  # noqa: BLE001
            results.append((False, f"roundtrip({sec}) raised {type(e).__name__}: {e}"))

    passed = sum(1 for ok, _ in results if ok)
    failed = sum(1 for ok, _ in results if not ok)
    for ok, msg in results:
        if not ok:
            print(f"FAIL: {msg}")
    print(f"{passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    run()
