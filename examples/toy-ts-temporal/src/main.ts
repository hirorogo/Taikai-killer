/**
 * toy-ts-temporal — YYYY-MM-DD 2日付の差日数（絶対値・順序非依存・不正形式は throw）。
 *
 * named export のみ（default export 禁止）。`Date` のローカルタイムゾーン/ロールオーバー
 * 依存を避けるため、自前でフォーマット検証 + 日数計算する。
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** グレゴリオ暦のうるう年判定。 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 当該年・月（1..12）の日数。 */
function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/**
 * 厳密に YYYY-MM-DD を検証して [year, month, day] を返す。不正なら throw。
 * 非文字列・形式不一致・範囲外・実在しない日付（例: 平年 2/29, 4/31）をすべて弾く。
 */
function parseDate(s: unknown): [number, number, number] {
  if (typeof s !== "string") {
    throw new Error(`invalid date: expected string, got ${typeof s}`);
  }
  const m = DATE_RE.exec(s);
  if (m === null) {
    throw new Error(`invalid date format (expected YYYY-MM-DD): ${JSON.stringify(s)}`);
  }
  // 正規表現で 3 グループはキャプチャ済み（noUncheckedIndexedAccess 対策に明示チェック）。
  const ys = m[1];
  const ms = m[2];
  const ds = m[3];
  if (ys === undefined || ms === undefined || ds === undefined) {
    throw new Error(`invalid date: ${JSON.stringify(s)}`);
  }
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);

  if (year < 1 || year > 9999) {
    throw new Error(`year out of range: ${year}`);
  }
  if (month < 1 || month > 12) {
    throw new Error(`month out of range: ${month}`);
  }
  const dim = daysInMonth(year, month);
  if (day < 1 || day > dim) {
    throw new Error(`day out of range for ${year}-${ms}: ${day} (max ${dim})`);
  }
  return [year, month, day];
}

/**
 * proleptic グレゴリオ暦における通日番号（ある固定起点からの日数）。
 * Howard Hinnant の days-from-civil アルゴリズム。返り値の絶対値ではなく差分のみ使う。
 */
function dayNumber(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (month + 9) % 12; // Mar=0 .. Feb=11
  const doy = Math.floor((153 * mp + 2) / 5) + (day - 1); // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/**
 * 2つの YYYY-MM-DD 日付の差日数を返す（絶対値・非負整数）。
 * 順序非依存: daysBetween(a, b) === daysBetween(b, a)。不正形式は throw。
 */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseDate(a);
  const [by, bm, bd] = parseDate(b);
  const na = dayNumber(ay, am, ad);
  const nb = dayNumber(by, bm, bd);
  return Math.abs(na - nb);
}
