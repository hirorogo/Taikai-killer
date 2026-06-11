/**
 * provided テスト（信頼アンカー・改変禁止）。YYYY-MM-DD 2日付の差日数。
 *
 * vitest 不要の自己完結ランナー（tsx で直接実行）。
 * test_cmd: npx tsx tests/test.ts → "N passed, M failed" を出力し exit 0/1。
 *
 * エッジを厚く（うるう年・月跨ぎ・年跨ぎ・同日0・順序非依存・不正形式 throw）。
 * 一発で全部通すのは難しく、S5 の D22 reflector(失敗→reflect→retry) を発火させる狙い。
 *
 * NodeNext + verbatimModuleSyntax のため、相対 import は .ts 拡張子を明示する。
 */
import { daysBetween } from "../src/main.ts";

type Results = Array<[boolean, string | null]>;

const results: Results = [];

function checkEq(label: string, got: unknown, expected: number): void {
  if (got === expected) {
    results.push([true, null]);
  } else {
    results.push([false, `${label} = ${String(got)} expected ${expected}`]);
  }
}

/** daysBetween(a,b) === expected かつ順序非依存（b,a でも一致）を 1 ケースで両方検証。 */
function eq(a: string, b: string, expected: number): void {
  let forward: unknown;
  try {
    forward = daysBetween(a, b);
  } catch (e) {
    results.push([false, `daysBetween(${r(a)}, ${r(b)}) threw ${errName(e)}: ${errMsg(e)}`]);
    // 逆順も評価して件数を揃える
    results.push([false, `daysBetween(${r(b)}, ${r(a)}) skipped (forward threw)`]);
    return;
  }
  checkEq(`daysBetween(${r(a)}, ${r(b)})`, forward, expected);

  let backward: unknown;
  try {
    backward = daysBetween(b, a);
  } catch (e) {
    results.push([false, `daysBetween(${r(b)}, ${r(a)}) threw ${errName(e)}: ${errMsg(e)}`]);
    return;
  }
  checkEq(`daysBetween(${r(b)}, ${r(a)}) [order-independent]`, backward, expected);
}

/** 不正形式: throw を期待。a/b いずれが不正でも throw すべき。 */
function bad(a: unknown, b: unknown): void {
  try {
    // 非文字列も渡せるよう any 経由
    const got = (daysBetween as (x: unknown, y: unknown) => number)(a, b);
    results.push([false, `daysBetween(${r(a)}, ${r(b)}) = ${String(got)} expected throw`]);
  } catch {
    results.push([true, null]);
  }
}

function r(v: unknown): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}
function errName(e: unknown): string {
  return e instanceof Error ? e.constructor.name : typeof e;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- 同日 0 -------------------------------------------------------------
eq("2021-01-01", "2021-01-01", 0);
eq("2000-02-29", "2000-02-29", 0);
eq("1999-12-31", "1999-12-31", 0);

// --- 隣接日 1 -----------------------------------------------------------
eq("2021-01-01", "2021-01-02", 1);
eq("2021-01-31", "2021-02-01", 1); // 月跨ぎ（1月31日）
eq("2021-04-30", "2021-05-01", 1); // 30日月の月跨ぎ
eq("2020-12-31", "2021-01-01", 1); // 年跨ぎ

// --- うるう年 -----------------------------------------------------------
eq("2020-02-28", "2020-02-29", 1); // うるう日へ
eq("2020-02-29", "2020-03-01", 1); // うるう日から
eq("2020-02-28", "2020-03-01", 2); // うるう年の 2月跨ぎ（28→29→3/1）
eq("2019-02-28", "2019-03-01", 1); // 平年の 2月跨ぎ（29 が無い）
eq("2000-02-28", "2000-03-01", 2); // 2000 はうるう年
eq("1900-02-28", "1900-03-01", 1); // 1900 は平年（400則）

// --- 月・年スパン -------------------------------------------------------
eq("2021-01-01", "2021-02-01", 31); // 1月は31日
eq("2021-02-01", "2021-03-01", 28); // 平年2月
eq("2020-02-01", "2020-03-01", 29); // うるう年2月
eq("2021-01-01", "2021-12-31", 364); // 平年: 1/1 → 12/31
eq("2020-01-01", "2020-12-31", 365); // うるう年: 366日年
eq("2000-01-01", "2000-12-31", 365); // 2000 うるう年
eq("1999-01-01", "1999-12-31", 364); // 平年
eq("2021-01-01", "2022-01-01", 365); // 丸1年（平年）
eq("2020-01-01", "2021-01-01", 366); // 丸1年（うるう年）
eq("2019-12-31", "2020-12-31", 366); // うるう年を内包する1年

// --- 大スパン -----------------------------------------------------------
eq("2000-01-01", "2020-01-01", 7305); // 20年（うるう: 2000,04,08,12,16 → 5回 → 365*20+5）
eq("1970-01-01", "2000-01-01", 10957); // 30年

// --- 不正形式: throw ----------------------------------------------------
bad("", "2021-01-01"); // 空文字
bad("2021-1-1", "2021-01-01"); // ゼロ詰めなし
bad("2021-01-1", "2021-01-01"); // 日のゼロ詰めなし
bad("2021/01/01", "2021-01-01"); // 区切り違い
bad("2021-01-01 ", "2021-01-01"); // 末尾空白
bad(" 2021-01-01", "2021-01-01"); // 先頭空白
bad("2021-01-01T00:00:00", "2021-01-01"); // 余分な時刻
bad("20210101", "2021-01-01"); // 区切りなし
bad("abcd-ef-gh", "2021-01-01"); // 非数字
bad("2021-00-10", "2021-01-01"); // 月 0
bad("2021-13-01", "2021-01-01"); // 月 13
bad("2021-01-00", "2021-01-01"); // 日 0
bad("2021-01-32", "2021-01-01"); // 日 32（1月）
bad("2021-04-31", "2021-01-01"); // 4月31日（30日まで）
bad("2021-06-31", "2021-01-01"); // 6月31日
bad("2021-02-29", "2021-01-01"); // 平年の 2/29
bad("1900-02-29", "2021-01-01"); // 1900 平年の 2/29
bad("2100-02-29", "2021-01-01"); // 2100 平年の 2/29
bad("2021-01-01", "2021-02-30"); // 第2引数が不正
bad("2021-01-01", "9999-99-99"); // 第2引数が不正
bad("0000-01-01", "0000-01-02"); // 年 0000 は無効（範囲外として弾く）
// 非文字列
bad(20210101, "2021-01-01");
bad(null, "2021-01-01");
bad(undefined, "2021-01-01");
bad({}, "2021-01-01");
bad(["2021-01-01"], "2021-01-01");

// --- 有効: 2/29 を含むうるう年は受理 -----------------------------------
eq("2020-02-29", "2024-02-29", 1461); // 4年（うるう4回ぶん含む）

function run(): void {
  let passed = 0;
  let failed = 0;
  for (const [ok, msg] of results) {
    if (ok) {
      passed += 1;
    } else {
      failed += 1;
      console.log(`FAIL: ${msg}`);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run();
