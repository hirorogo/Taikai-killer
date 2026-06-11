# toy-fizzbuzz-plus（ひねりあり）

`src/main.py` に関数 `fizzbuzz_plus(n: int) -> str` を実装せよ。通常のFizzBuzzに**桁の条件**が加わる。

- **Fizz 条件**: n が 3 の倍数 **または** n の十進表記に数字 `3` を含む
- **Buzz 条件**: n が 5 の倍数 **または** n の十進表記に数字 `5` を含む
- Fizz と Buzz の両方を満たす → `"FizzBuzz"`
- Fizz のみ → `"Fizz"` / Buzz のみ → `"Buzz"` / どちらも満たさない → `str(n)`

例:
- `fizzbuzz_plus(13) == "Fizz"`（13は3を含む）
- `fizzbuzz_plus(52) == "Buzz"`（52は5を含む）
- `fizzbuzz_plus(35) == "FizzBuzz"`（35は5の倍数かつ3を含む）
- `fizzbuzz_plus(7) == "7"`
