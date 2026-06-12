# toy-impossible（AC2 検証用・わざと通らない仕様）

`src/main.py` に関数 `classify(n: int) -> str` を実装せよ。

この仕様は **D22 Reflexion ループの検証専用に、わざと充足不能（矛盾）にしてある**。
同じ入力に対して両立しない出力を要求するため、どんな実装でも provided テストの一部は必ず落ちる。
目的は「通らない仕様で D22 ループが maxAttempts 回試行し、reflector フィードバックを
feedbackHistory に積む」ことの実証（Issue #3 AC2）であって、PASS させることではない。

- `n` が偶数なら `"even"` を返す
- 同時に、`n` が偶数なら `"divisible_by_two"` を返す（↑と矛盾＝同一入力に2つの正解）
- `n` が奇数なら `"odd"` を返す

例: `classify(4)` は `"even"` であり同時に `"divisible_by_two"` でなければならない（両立不能）。
