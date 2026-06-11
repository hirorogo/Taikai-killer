/**
 * S2 外部知見フロー（D7 / docs/decisions.md「S2 収束」「クロール（D7）」、
 * docs/architecture.md「S2 外部知見<br/>最大4回 / 収束で早期終了」）。
 *
 * 役割:
 * - runS2 が round=0..S2_MAX_ROUNDS の反復ループを回し、各ラウンドで検索ワード由来の
 *   URL 集合を crawl→保存し、newUniqueRatio / shouldContinueS2 で収束を判定して早期終了する
 *   （これが S2 を S3-S6 と差別化する唯一の仕様＝回数キャップ＋収束停止）。
 * - crawl.ts（crawl / mapToCrawledUrl）に取得を委譲し（読むだけ・改変しない）、
 *   各 CrawledUrl の本文を knowledgeDir に保存して saved_path を確定する。
 * - steal B-2「派生インデックス」: 保存した本文から keyword/tag → ファイルパス逆引きの
 *   「知見INDEX」を一度だけ構築（各ワーカーは全文でなく index 経由で関連知見を pull）。
 * - 収束判定（D7）: 1ラウンドの新規ユニーク率が <10% なら「同じのが出る」とみなし早期終了。
 *   ハードキャップ4回と OR で早い方（decisions.md「S2 の収束判定」）。
 *
 * 設計方針（既存 crawl.ts / resume.ts / events.ts のスタイルに合わせる）:
 * - 純ロジック（buildKnowledgeIndex / dedupeUrls / newUniqueRatio / tokenize）を named export し
 *   vitest でテストする。実保存（fs 書き込み）は副作用関数として分離（saveKnowledge）。
 * - partial-first: 1 URL / 1 保存の失敗で全体を止めない。保存に失敗した本文は
 *   saved_path 空のまま結果に残す（失敗も first-class）。
 * - サイドカーは本文 text を返すが CrawledUrl は slim（本文を持たない）。本文は
 *   saveKnowledge が knowledgeDir に書き出し、INDEX が逆引きを担う。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { crawl } from "./crawl.ts";
import type { CrawledUrl } from "./types.ts";

// ───────── 収束判定（D7 / 純ロジック） ─────────

/** S2 のハードキャップ（decisions.md「最大4回」）。 */
export const S2_MAX_ROUNDS = 4;

/** 新規ユニーク率の収束しきい値（decisions.md「新規率 <10% で停止」）。 */
export const S2_CONVERGENCE_RATIO = 0.1;

/**
 * 直前ラウンドまでの既知集合 prev と、今ラウンドの取得集合 curr から
 * 「新規ユニーク率」= (curr のうち prev に無い件数) / (curr の総数) を返す（純ロジック）。
 *
 * - curr が空なら 0（新規ゼロ＝収束済みとみなす）。ゼロ除算を避ける。
 * - prev / curr は url 等の識別子文字列の集合を想定。重複は集合として畳む。
 * - 比較は dedupe 済みの「ユニーク件数」基準（同じ url が curr 内に複数あっても 1 と数える）。
 */
export function newUniqueRatio(prev: readonly string[], curr: readonly string[]): number {
  const known = new Set(prev);
  const seenThisRound = new Set<string>();
  let novel = 0;
  for (const item of curr) {
    if (seenThisRound.has(item)) continue;
    seenThisRound.add(item);
    if (!known.has(item)) novel += 1;
  }
  const total = seenThisRound.size;
  if (total === 0) return 0;
  return novel / total;
}

/**
 * S2 をもう1ラウンド回すべきか（D7 の停止条件を1関数に集約）。
 * - round はこれまで完了したラウンド数（0 始まり）。round >= 4 で停止（ハードキャップ）。
 * - 直前ラウンドの新規率が <10% なら収束とみなし停止（OR で早い方）。
 *   初回（round===0）は prevRatio を渡さない＝必ず継続。
 */
export function shouldContinueS2(round: number, prevRatio?: number): boolean {
  if (round >= S2_MAX_ROUNDS) return false;
  if (prevRatio !== undefined && prevRatio < S2_CONVERGENCE_RATIO) return false;
  return true;
}

// ───────── URL 重複排除（純ロジック） ─────────

/**
 * URL 群を重複排除（純ロジック）。
 * - 入力順を保持し、初出だけを残す（決定論性のため append 順）。
 * - 正規化: 前後空白を除去し、末尾スラッシュとフラグメント（#...）を畳んで同一視する。
 *   空文字（正規化後）は捨てる。スキームの大小は変えない（過剰正規化で別 URL を潰さない）。
 */
export function dedupeUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const key = normalizeUrlKey(raw);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out;
}

/** dedupe 用の比較キー（フラグメント除去・末尾スラッシュ畳み込み）。 */
function normalizeUrlKey(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  // パス末尾のスラッシュを畳む（"a/" と "a" を同一視）。
  // ホスト無しの裸スキーム（"http://"）は dedupe 経路に来ない想定だが、
  // 念のため "://" 直後のスラッシュ群までは削らない（"http://" を "http:" に壊さない）。
  const sep = s.indexOf("://");
  if (sep >= 0) {
    const head = s.slice(0, sep + 3); // "scheme://" まではそのまま残す
    const rest = s.slice(sep + 3).replace(/\/+$/, "");
    s = head + rest;
  } else {
    s = s.replace(/\/+$/, "");
  }
  return s;
}

// ───────── 知見INDEX（steal B-2 / 純ロジック） ─────────

/** INDEX 構築の入力レコード（保存済み本文1件）。 */
export interface KnowledgeRecord {
  path: string; // 保存先パス（saved_path）。逆引きの値になる
  title: string; // 見出し（トークン源として本文に前置して重み付け）
  text: string; // 本文プレーンテキスト
}

/** 逆引きインデックス: token → 出現ファイルパス（頻度上位順）。 */
export type KnowledgeIndex = Record<string, string[]>;

/** INDEX 構築のオプション。 */
export interface BuildIndexOptions {
  /** 1 token あたり保持する最大パス数（頻度上位）。既定 20。 */
  maxPathsPerToken?: number;
  /**
   * 採用する token の最大種類数（全体の頻度上位）。既定 500。
   * steal B-2 のトークン40-60%削減を先取りした INDEX 肥大抑制。
   * MVP（docs/mvp-vertical-slice.md「S2 は薄くスキップ可」）で過剰なら
   * maxTokens=Infinity を渡せば全 token を採用（=絞りを無効化）できる。
   */
  maxTokens?: number;
  /** token の最小文字数（既定 2: 1文字ノイズを落とす）。 */
  minTokenLength?: number;
}

/** 英数・日本語以外を区切りとする簡易トークナイザ（小文字化）。 */
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** ありふれた語を除いて index ノイズを減らす（最小限の stopword）。 */
const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "be", "this", "that", "with", "as", "by", "at", "from", "it", "we", "you",
  "の", "に", "は", "を", "が", "と", "で", "た", "し", "て", "も", "な", "い", "する", "こと",
]);

/**
 * テキストを簡易トークン化（純ロジック・テスト対象）。
 * - 小文字化し、英数/文字以外で分割。stopword と短すぎる token を除外。
 * - 重複は呼び側で数える（ここは出現順のトークン列を返す）。
 */
export function tokenize(text: string, minTokenLength = 2): string[] {
  const out: string[] = [];
  for (const part of text.toLowerCase().split(TOKEN_SPLIT)) {
    if (!part) continue;
    if (part.length < minTokenLength) continue;
    if (STOPWORDS.has(part)) continue;
    out.push(part);
  }
  return out;
}

/**
 * 保存済み本文群から逆引きインデックスを構築（steal B-2 / 純ロジック・テスト対象）。
 *
 * - 各レコードの title + text をトークン化し、token ごとに「出現したパス＋総頻度」を集計。
 * - token → paths は「その token を多く含むパス順（頻度降順、同点はパス昇順で決定論的）」。
 * - 全体で頻度上位 maxTokens 種類だけを採用（巨大インデックス肥大の抑制）。
 * - 同一パスが同 token で複数回出ても値配列には1回だけ（パスはユニーク）。
 *
 * 返り値はプレーンオブジェクト（知見INDEX.json にそのまま JSON.stringify できる）。
 */
export function buildKnowledgeIndex(
  records: readonly KnowledgeRecord[],
  opts: BuildIndexOptions = {},
): KnowledgeIndex {
  const maxPathsPerToken = opts.maxPathsPerToken ?? 20;
  const maxTokens = opts.maxTokens ?? 500;
  const minTokenLength = opts.minTokenLength ?? 2;

  // token → (path → そのパス内での出現頻度)
  const byToken = new Map<string, Map<string, number>>();
  // token → 全体頻度（採用する token を絞るため）
  const tokenTotal = new Map<string, number>();

  for (const rec of records) {
    if (!rec.path) continue; // 保存できなかった（saved_path 空）レコードは index に載せない
    // title は本文より知見の主題を表すので tokens に含める（重み付けは頻度に委ねる）。
    const tokens = tokenize(`${rec.title} ${rec.text}`, minTokenLength);
    for (const tok of tokens) {
      let perPath = byToken.get(tok);
      if (perPath === undefined) {
        perPath = new Map<string, number>();
        byToken.set(tok, perPath);
      }
      perPath.set(rec.path, (perPath.get(rec.path) ?? 0) + 1);
      tokenTotal.set(tok, (tokenTotal.get(tok) ?? 0) + 1);
    }
  }

  // 全体頻度上位の token だけ採用（頻度降順、同点は token 昇順で決定論的）。
  const acceptedTokens = [...tokenTotal.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxTokens)
    .map(([tok]) => tok);

  const index: KnowledgeIndex = {};
  for (const tok of acceptedTokens) {
    const perPath = byToken.get(tok);
    if (perPath === undefined) continue;
    const paths = [...perPath.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, maxPathsPerToken)
      .map(([path]) => path);
    index[tok] = paths;
  }
  return index;
}

// ───────── 保存先解決（純ロジック） ─────────

/**
 * 1 URL の保存先ファイル名を決定（純ロジック・決定論的）。
 * - url の sha256 先頭 12 桁 + index で衝突回避。拡張子は kind 由来（paper/arxiv は .txt 統一）。
 * - crawl() の resolveSavedPath に渡せるよう (url, index) から導出。
 */
export function knowledgeFileName(url: string, index: number): string {
  const h = createHash("sha256").update(url, "utf8").digest("hex").slice(0, 12);
  return `k${String(index).padStart(4, "0")}_${h}.txt`;
}

/** knowledgeDir 配下の保存先絶対/相対パスを解決（join のみ・副作用なし）。 */
export function resolveKnowledgePath(knowledgeDir: string, url: string, index: number): string {
  return join(knowledgeDir, knowledgeFileName(url, index));
}

// ───────── 実保存（副作用） ─────────

/**
 * ラウンド r（0 始まり）で検索ワードからクロール対象 URL 集合を導く provider。
 * - decisions.md L81「新規 url / 検索ワード ÷ 取得総数」: 各ラウンドは検索ワード由来の
 *   URL 集合を持つ。ラウンドごとに別の検索ワード/ページに広げられるよう r を渡す。
 * - 既定（未指定）は「初回だけ runS2 に渡された urls を返し、2 ラウンド目以降は空」。
 *   ＝ urls だけ渡せば従来どおり 1 ラウンドで収束扱い（空 round で newUniqueRatio→0→停止）。
 */
export type RoundUrlProvider = (round: number) => readonly string[] | Promise<readonly string[]>;

/** runS2 のオプション。 */
export interface RunS2Options {
  /** crawl のハード timeout（ms）。既定 60_000。 */
  timeoutMs?: number;
  /** crawl に渡す python 実行ファイル（テスト/差し替え用）。 */
  python?: string;
  /** crawl に渡すサイドカーパス（テスト/差し替え用）。 */
  sidecarPath?: string;
  /** INDEX 構築オプション。 */
  index?: BuildIndexOptions;
  /** crawl を差し替えるためのフック（テスト用。既定は crawl.ts の crawl）。 */
  crawlFn?: typeof crawl;
  /**
   * ラウンドごとの検索ワード由来 URL provider（D7 反復の本質）。
   * 未指定なら runS2 第1引数 urls を round 0 のみ使う（後続 round は空＝収束停止）。
   */
  urlsForRound?: RoundUrlProvider;
}

/** runS2 の結果（次フェーズ S3 が消費する slim な成果）。 */
export interface S2Result {
  /** クロール結果（全ラウンド分。saved_path は保存成功時のみ確定、失敗は空文字）。 */
  crawled: CrawledUrl[];
  /** 知見INDEX（token → ファイルパス逆引き / steal B-2）。 */
  knowledgeIndex: KnowledgeIndex;
  /** 実際に保存できた本文の件数（partial-first の観測値）。 */
  savedCount: number;
  /** 実際に回したラウンド数（収束 or ハードキャップで打ち切られた値 / D7 観測）。 */
  rounds: number;
}

/**
 * 1 件の本文を knowledgeDir に書き出す（副作用関数・partial-first）。
 * 書けたらパス、書けなければ "" を返す（throw しない＝1件失敗で全体を止めない）。
 */
export function saveKnowledge(knowledgeDir: string, path: string, text: string): string {
  try {
    mkdirSync(knowledgeDir, { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return "";
  }
}

/**
 * S2 外部知見フロー本体（副作用あり・D7 反復ループ）。
 *
 * フロー（decisions.md L74/L81・architecture.md「最大4回 / 収束で早期終了」）:
 * 1. round=0 から最大 S2_MAX_ROUNDS 回まで反復する:
 *    a. urlsForRound(round) で検索ワード由来の URL 集合を得て dedupe（純ロジック）。
 *       既定 provider は round 0 のみ runS2 引数 urls を返し、以降は空。
 *    b. crawl()（crawl.ts に委譲）で各 URL を取得。resolveSavedPath で knowledgeDir 配下の
 *       保存先を割り当て、本文 text は crawl 側 RawCrawlRecord に載るので、ここで保存する。
 *       ※ crawl() は CrawledUrl（slim）しか返さず本文を持たないため、保存は resolveSavedPath
 *       の副作用として行う（保存できた時だけそのパスを saved_path に確定する）。
 *    c. このラウンドの取得 url 集合 curr と、これまでの既知集合 prev から newUniqueRatio を計算。
 *    d. shouldContinueS2(round+1, ratio) が false なら break（収束 or ハードキャップ）。
 *       true なら prev に curr を merge して次 round へ。
 * 2. 全ラウンドの保存済みレコードから buildKnowledgeIndex（steal B-2）。
 *
 * 注意: crawl.ts は読むだけ（改変しない）。resolveSavedPath が rec.text を受け取れるので、
 *       そこで saveKnowledge を呼び、成功時のみ実パスを返す（失敗は "" → saved_path 空）。
 *       本文が空（trim 長 0）の rec は雑音なので保存せず "" を返す（D7 歩留まり前提）。
 */
export async function runS2(
  urls: readonly string[],
  knowledgeDir: string,
  opts: RunS2Options = {},
): Promise<S2Result> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doCrawl = opts.crawlFn ?? crawl;

  // 既定 provider: round 0 だけ引数 urls、以降は空（＝1 ラウンドで収束停止する従来挙動）。
  const urlsForRound: RoundUrlProvider =
    opts.urlsForRound ?? ((round) => (round === 0 ? urls : []));

  // 保存済み本文を index 構築用に蓄える（resolveSavedPath の副作用で集める）。
  const records: KnowledgeRecord[] = [];
  // 全ラウンドのクロール結果（次フェーズ S3 が消費）。
  const crawled: CrawledUrl[] = [];

  // resolveSavedPath は crawl が各 RawCrawlRecord（本文 text 付き）について呼ぶ。
  // ここで実保存し、成功時のみ確定パスを返す（失敗は "" で saved_path 空＝partial-first）。
  // 本文が空（trim 長 0）の rec は保存しない（空知見が saved_path 確定・index 汚染するのを防ぐ）。
  const resolveSavedPath = (rec: { url: string; title: string; text: string }, i: number): string => {
    const text = rec.text ?? "";
    if (text.trim().length === 0) return "";
    const target = resolveKnowledgePath(knowledgeDir, rec.url, i);
    const saved = saveKnowledge(knowledgeDir, target, text);
    if (saved) {
      records.push({ path: saved, title: rec.title ?? "", text });
    }
    return saved;
  };

  const crawlOpts: Parameters<typeof crawl>[2] = { resolveSavedPath };
  if (opts.python !== undefined) crawlOpts.python = opts.python;
  if (opts.sidecarPath !== undefined) crawlOpts.sidecarPath = opts.sidecarPath;

  // 既知 url 集合（dedupe 済みキー基準）。収束判定の prev。
  const known = new Set<string>();
  let rounds = 0;

  for (let round = 0; round < S2_MAX_ROUNDS; round += 1) {
    const roundUrls = dedupeUrls([...(await urlsForRound(round))]);
    if (roundUrls.length === 0) {
      // 検索ワード由来 URL が尽きた＝新規ゼロ＝収束。ラウンドは消費しない。
      break;
    }
    rounds += 1;

    const roundCrawled = await doCrawl([...roundUrls], timeoutMs, crawlOpts);
    crawled.push(...roundCrawled);

    // このラウンドの新規ユニーク率を prev(known) に対して計算（純ロジック）。
    const prev = [...known];
    const ratio = newUniqueRatio(prev, roundUrls);
    for (const u of roundUrls) known.add(u);

    // round+1（完了ラウンド数）と直前 ratio で停止判定（D7: 収束 or ハードキャップ）。
    if (!shouldContinueS2(round + 1, ratio)) break;
  }

  const knowledgeIndex = buildKnowledgeIndex(records, opts.index ?? {});
  return { crawled, knowledgeIndex, savedCount: records.length, rounds };
}
