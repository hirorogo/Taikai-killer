# toy-multi-duration（継続時間 文字列 ⇔ 秒・3関数・厳格版）

`src/main.py` に **3つの関数** を実装せよ。1ファイルに複数関数・エッジが厚い「難しめ」課題。
一発で全テストを通すのは難しく、複数 round で世代交代しながら改善していく狙い。

書式は **`1h2m3s` 形式**（時間 `h` / 分 `m` / 秒 `s`）。

## 1. `parse_duration(s: str) -> int`

継続時間文字列 `s` を**総秒数（int）**に変換する。

- 受理する形は **`<数値><単位>` の並び**。単位は `h`（3600秒）, `m`（60秒）, `s`（1秒）。
  - 例：`"1h2m3s"` → `3600 + 120 + 3 = 3723`、`"90m"` → `5400`、`"45s"` → `45`、`"2h"` → `7200`。
- 各単位は **0回または1回**だけ出現でき、**必ず `h` → `m` → `s` の順**でなければならない。
  - `"1m1h"`（順序違反）、`"1h1h"`（重複）はすべて `ValueError`。
- 各単位の数値は **1桁以上の非負整数**（`0` を許容、先頭ゼロ `"01h"` は不正 → `ValueError`。ただし数値 `"0"` 単体は有効、例：`"0s"` → `0`）。
  - `m` と `s` の数値が **60以上**でも、parse 段階では**そのまま受理**する（`"90m"` → `5400`、`"120s"` → `120`）。正規化は format 側の責務。
- 以下はすべて `ValueError`（厳格な検証）：
  - 空文字列 `""`、単位なしの数値 `"100"`、数値なしの単位 `"h"`、未知の単位 `"5d"`, `"5H"`（大文字）。
  - 符号・小数・空白を含む（`"-1h"`, `"1.5h"`, `"1h 2m"`, `" 1h"`, `"1h2m3s "`）。
  - 全単位ゼロ個（どの単位も無い）。
- `str` 以外（`bool` 含む — `True` は明示的に弾く）が来たら `TypeError`。

## 2. `format_duration(sec: int) -> str`

総秒数 `sec` を**正規化された** `1h2m3s` 形式の文字列に変換する。

- `sec` は **0以上の int**。負値は `ValueError`、`int` 以外（`bool` 含む）は `TypeError`。
- 値が **0 の単位は省略**する（`3600` → `"1h"`、`60` → `"1m"`、`3661` → `"1h1m1s"`）。
- `sec == 0` の特例は **`"0s"`**（空文字ではない）。
- 出力は常に **`h` → `m` → `s` の順**、各単位の数値は **0..59 に正規化**（`m`/`s` は60未満、`h` は上限なし）。
  - 例：`3723` → `"1h2m3s"`、`5400` → `"1h30m"`、`7325` → `"2h2m5s"`、`59` → `"59s"`、`3600` → `"1h"`。

## 3. `add_durations(a: str, b: str) -> str`

2つの継続時間文字列を**加算**し、正規化済みの文字列で返す。

- `a`, `b` は `parse_duration` が受理する文字列。どちらかが不正なら **`ValueError`/`TypeError` が伝播**する。
- 戻り値は `format_duration(parse_duration(a) + parse_duration(b))` と等価。
  - 例：`add_durations("1h", "30m")` → `"1h30m"`、`add_durations("90m", "90m")` → `"3h"`、`add_durations("0s", "0s")` → `"0s"`。

## ラウンドトリップ不変条件
- すべての `sec >= 0` で `parse_duration(format_duration(sec)) == sec`。
- すべての受理可能な正規化文字列 `s` で `format_duration(parse_duration(s)) == s`（`s` が既に正規化済みの場合）。

## 例
- `parse_duration("1h2m3s") == 3723`, `parse_duration("0s") == 0`, `parse_duration("90m") == 5400`
- `parse_duration("1m1h")` → `ValueError`, `parse_duration("01h")` → `ValueError`, `parse_duration("h")` → `ValueError`
- `format_duration(3723) == "1h2m3s"`, `format_duration(0) == "0s"`, `format_duration(5400) == "1h30m"`
- `format_duration(-1)` → `ValueError`, `format_duration(True)` → `TypeError`
- `add_durations("90m", "90m") == "3h"`, `add_durations("1h59m59s", "1s") == "2h"`
