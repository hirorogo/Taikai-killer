# toy-js-parens

`src/main.js` に関数 `isBalanced(s)` を実装し、`module.exports = { isBalanced }` で公開せよ（Node.js, `language: node`）。

## 仕様

文字列 `s` に含まれる 3 種類の括弧

- 丸括弧 `(` `)`
- 角括弧 `[` `]`
- 波括弧 `{` `}`

について、**対応・入れ子・順序** がすべて正しく、開き括弧の **余り**・閉じ括弧の **余り** がない場合に `true`、そうでなければ `false` を返す。

ルール:

- 開いた括弧は、同じ種類の閉じ括弧で、**最も内側から順に**（LIFO）閉じられなければならない。
  例: `"([)]"` は順序が崩れているので `false`。`"([])"` は `true`。
- 閉じ括弧が、対応する開き括弧より先に現れたら `false`（例: `")("`、`"]"`）。
- 最後まで読んで閉じられていない開き括弧が残っていたら `false`（例: `"("`、`"({["`）。
- 括弧以外の文字（英数字・空白・記号など）は **すべて無視** する。
  例: `"a(b)c"` は `true`、`"{ key: [1, 2] }"` は `true`。
- 空文字列 `""` は括弧が一つもないので `true`。

## シグネチャ

```js
function isBalanced(s) { /* ... */ }
module.exports = { isBalanced };
```

## 例

- `isBalanced("()")` === `true`
- `isBalanced("()[]{}")` === `true`
- `isBalanced("([])")` === `true`
- `isBalanced("([)]")` === `false`
- `isBalanced("(")` === `false`
- `isBalanced(")")` === `false`
- `isBalanced("a(b[c]{d}e)f")` === `true`
- `isBalanced("")` === `true`

## 評価

`tests/test.js`（provided・改変禁止）が多数のアサートを実行し、
`"N passed, M failed"` を出力して exit 0/1 する。`eval_mode: test`。
