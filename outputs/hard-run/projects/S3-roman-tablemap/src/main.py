import re

# 降順 (値, 記号) ペア表。減算記法を含む標準形の基底。
_ROMAN_PAIRS = [
    (1000, 'M'), (900, 'CM'), (500, 'D'), (400, 'CD'),
    (100, 'C'), (90, 'XC'), (50, 'L'), (40, 'XL'),
    (10, 'X'), (9, 'IX'), (5, 'V'), (4, 'IV'), (1, 'I'),
]

# 標準形 (canonical) のみを受理する厳格パターン。
# - M{0,3}: 1000の桁は最大3 (MMM=3000 まで)
# - (CM|CD|D?C{0,3}): 100の桁、減算ペア CM/CD と D の単独/重複禁止を表現
# - 同様に 10の桁 / 1の桁。4回連続や VLD 重複、非標準減算 (IL, IC, VX...) を全て弾く。
_CANONICAL_RE = re.compile(
    r'^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$'
)


def to_roman(n):
    # bool は int のサブクラスなので type 同一性で明示的に弾く。
    if type(n) is not int:
        raise TypeError('to_roman expects an int (bool is rejected)')
    if n < 1 or n > 3999:
        raise ValueError('value out of range: must be 1..3999')
    result = []
    for value, symbol in _ROMAN_PAIRS:
        while n >= value:
            result.append(symbol)
            n -= value
    return ''.join(result)


def from_roman(s):
    if not isinstance(s, str):
        raise TypeError('from_roman expects a str')
    # 空文字は正規表現上は全グループ空でマッチしてしまうため明示的に弾く。
    if s == '':
        raise ValueError('empty string is not a valid roman numeral')
    # 非標準形 (非ローマ文字 / 小文字 / 4連続 / VLD重複 / 非標準減算) を一括拒否。
    if not _CANONICAL_RE.match(s):
        raise ValueError('not a canonical roman numeral: %r' % (s,))
    # 標準形と判明したので左から走査して整数化する。
    result = 0
    i = 0
    for value, symbol in _ROMAN_PAIRS:
        length = len(symbol)
        while s[i:i + length] == symbol:
            result += value
            i += length
    # 往復検証で二重に保証 (canonical 性の最終チェック)。
    if i != len(s) or to_roman(result) != s:
        raise ValueError('not a canonical roman numeral: %r' % (s,))
    return result
