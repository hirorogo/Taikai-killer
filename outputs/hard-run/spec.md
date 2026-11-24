# toy-hard-roman（ローマ数字 ⇔ 整数 双方向変換・厳格版）

`src/main.py` に **2つの関数** を実装せよ。曖昧さ・エッジケースが多い「難しめ」課題。

## 1. `to_roman(n: int) -> str`

整数 `n` を**標準形（canonical）**のローマ数字文字列に変換する。

- 有効範囲は **1..3999**。範囲外（`n < 1` または `n > 3999`）は `ValueError` を送出する。
- `int` 以外（`bool` を含む — Python では `True` は `int` のサブクラスなので明示的に弾く）が来たら `TypeError` を送出する。
- 出力は**大文字**のみ。
- **減算記法**を必ず使う：`4=IV`, `9=IX`, `40=XL`, `90=XC`, `400=CD`, `900=CM`。
  - 例えば `4` は `"IIII"` ではなく `"IV"`、`40` は `"XXXX"` ではなく `"XL"`。

## 2. `from_roman(s: str) -> int`

**標準形の**ローマ数字文字列 `s` を整数に変換する。

- 入力は**標準形（canonical）のみ**を受理する。`to_roman(from_roman(s)) == s` が成り立つ文字列だけが有効。
- 以下はすべて `ValueError`（厳格な検証）：
  - 空文字列 `""`
  - 非ローマ文字を含む（`A`, 小文字 `iv`, 数字, 空白など）
  - 同一記号を **4回以上連続**（`IIII`, `XXXX`, `CCCC`, `MMMM`）。なお `MMM`(3000) は有効。
  - `V`, `L`, `D` は **2回以上**現れてはならない（`VV`, `LL`, `DD` は不正）。
  - **非標準の減算**：`IL`(49を意図), `IC`, `XM`, `VX`, `LC`, `IIV`, `IXX` など、標準形でない並びはすべて不正。
  - 正しい減算ペアは `IV IX XL XC CD CM` の6つのみ。それ以外の「小→大」隣接は不正。
  - 大きい桁の繰り返しより後に同じ桁が再登場する（`XIX` は valid だが `IXI`, `VIV` は invalid）。
- `str` 以外が来たら `TypeError`。

## ラウンドトリップ不変条件
- すべての `n in 1..3999` で `from_roman(to_roman(n)) == n`。
- すべての有効な標準ローマ数字 `s` で `to_roman(from_roman(s)) == s`。

## 例
- `to_roman(4) == "IV"`, `to_roman(9) == "IX"`, `to_roman(40) == "XL"`, `to_roman(944) == "CMXLIV"`
- `to_roman(3888) == "MMMDCCCLXXXVIII"`（最長形）, `to_roman(3999) == "MMMCMXCIX"`
- `from_roman("MCMXCIV") == 1994`, `from_roman("XLII") == 42`
- `from_roman("IIII")` → `ValueError`, `from_roman("IL")` → `ValueError`, `from_roman("")` → `ValueError`
- `to_roman(0)` → `ValueError`, `to_roman(4000)` → `ValueError`, `to_roman(True)` → `TypeError`
