// provided テスト（信頼アンカー・改変禁止）。3 種括弧の対応・入れ子・順序・余りを判定。
//
// pytest 不要ならぬ依存ゼロの自己完結ランナー。
// test_cmd: node tests/test.js → "N passed, M failed" を出力し exit 0/1。
//
// エッジを厚く（20+ ケース）。一発で全部通すのは難しく、S5 の D22 reflector
// (失敗→reflect→retry) を発火させる狙い。

"use strict";

const path = require("path");

// (input, expected) — input は文字列。非括弧文字は無視される前提。
const CASES = [
  // --- 基本 true -------------------------------------------------------
  ["", true], // 空: 括弧なし
  ["()", true],
  ["[]", true],
  ["{}", true],
  ["()[]{}", true], // 並列・順序OK
  ["([])", true], // 入れ子（角の中に丸）
  ["([{}])", true], // 三重入れ子
  ["{[()]}", true], // 三重入れ子・別順
  ["(())", true], // 同種入れ子
  ["((()))", true], // 深い同種入れ子
  ["[({})]", true],
  ["()()()", true], // 連続並列

  // --- 非括弧文字は無視（true） ---------------------------------------
  ["a(b)c", true],
  ["a(b[c]{d}e)f", true],
  ["{ key: [1, 2] }", true], // 空白・カンマ・コロン・数字を無視
  ["if (x) { return [y]; }", true], // コード片
  ["no brackets here at all", true], // 括弧ゼロ
  ["1 + 2 * (3 - 4)", true],
  ["((a)(b))", true],

  // --- 順序崩れ false（交差） -----------------------------------------
  ["([)]", false], // 古典的な交差
  ["{[}]", false],
  ["[(])", false],
  ["([{]})", false], // 深い交差

  // --- 種類不一致 false ------------------------------------------------
  ["(]", false],
  ["[)", false],
  ["{)", false],
  ["(}", false],

  // --- 開き余り false（閉じられていない） ------------------------------
  ["(", false],
  ["[", false],
  ["{", false],
  ["(()", false], // 1 個開き余り
  ["({[", false], // 全部開きっぱなし
  ["(a(b", false],
  ["[[]", false],

  // --- 閉じ余り false（開く前に閉じる / 余分な閉じ） -------------------
  [")", false],
  ["]", false],
  ["}", false],
  ["())", false], // 1 個閉じ余り
  [")(", false], // 順序逆転
  ["][", false],
  ["()]", false], // 末尾に余分な閉じ
  ["a)b(c", false], // 文字を挟んでも閉じ先行は false
];

function run() {
  let isBalanced;
  try {
    // eslint-disable-next-line global-require
    const mod = require(path.join(__dirname, "..", "src", "main.js"));
    isBalanced = mod.isBalanced;
    if (typeof isBalanced !== "function") {
      throw new Error("module.exports.isBalanced が関数ではない");
    }
  } catch (e) {
    console.log(`0 passed, ${CASES.length} failed (import error: ${e && e.message})`);
    process.exit(1);
    return;
  }

  let passed = 0;
  let failed = 0;

  for (const [input, expected] of CASES) {
    let got;
    try {
      got = isBalanced(input);
    } catch (e) {
      failed += 1;
      console.log(`FAIL: isBalanced(${JSON.stringify(input)}) threw ${e && e.message}`);
      continue;
    }
    if (got === expected) {
      passed += 1;
    } else {
      failed += 1;
      console.log(
        `FAIL: isBalanced(${JSON.stringify(input)})=${JSON.stringify(got)} expected ${JSON.stringify(
          expected,
        )}`,
      );
    }
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
