/**
 * S2 外部知見クロールの TS ブリッジ（D7）。
 * 正本: docs/architecture.md「External Knowledge: Scrapling（Python サイドカー）」、
 *       orchestrator/types.ts CrawledUrl（urlクロール.json）。
 *
 * 方針:
 * - 取得本体は Python サイドカー（crawl-py/crawl.py）に委譲。ここは spawn して
 *   URL を stdin に流し、stdout の JSON 配列を CrawledUrl[] にマップするだけ。
 * - geminiRunner.ts / battle.ts と同形: spawn / stdin 投入 / ハード timeout /
 *   純ロジック（JSON→型 変換）を named export してテスト可能にする。
 * - partial-first: 1 URL の失敗で全体を止めない。サイドカーが各 URL の error を
 *   フィールドに入れて返すので、ここは throw せずマップする
 *   （CLAUDE.md「単一ワーカーの失敗でループを止めない」）。
 *
 * CrawledUrl（types.ts）との対応:
 * - サイドカーは {url,title,kind,text,error?} を返す（本文 text 付き）。
 * - CrawledUrl は {url,title,kind,saved_path,excluded?} で本文を持たない（slim、本体は別保存）。
 * - 変換時に saved_path を割り当てる（保存はオーケストレータ側の責務なので、
 *   ここでは「保存先を解決する関数」を受け取り、純ロジックを保つ）。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { CrawledUrl } from "./types.ts";

const IS_WIN = process.platform === "win32";

/** サイドカー実行パス（リポジトリルートからの相対）。 */
const SIDECAR_REL = join("crawl-py", "crawl.py");

/** サイドカーが stdout に出す 1 URL 分の生レコード（crawl.py の出力契約と 1:1）。 */
export interface RawCrawlRecord {
  url: string;
  title: string;
  kind: string; // "web" | "paper" | "arxiv"（サイドカー側で推定、未知値は web に丸める）
  text: string;
  error?: string;
}

/** CrawledUrl の kind 許容値（types.ts）。 */
const KIND_VALUES = ["web", "paper", "arxiv"] as const;
type CrawlKind = (typeof KIND_VALUES)[number];

/** 文字列を CrawledUrl.kind に正規化（未知値は "web"）。 */
export function normalizeKind(kind: unknown): CrawlKind {
  return typeof kind === "string" && (KIND_VALUES as readonly string[]).includes(kind)
    ? (kind as CrawlKind)
    : "web";
}

/**
 * サイドカーの生レコード 1 件 → CrawledUrl（純ロジック・テスト対象）。
 *
 * - saved_path は「保存先解決関数」から得る（保存の副作用はここに持ち込まない）。
 *   index で衝突しないファイル名を作れるよう index も渡す。
 * - error を持つレコードは取得失敗。saved_path は空文字（本文が無いので保存しない）。
 *   excluded は広告/nsfw 判定（サイドカーは付けないので未指定のまま＝後段フィルタの責務）。
 *
 * exactOptionalPropertyTypes: excluded は値があるときだけ載せる（undefined を載せない）。
 */
export function mapToCrawledUrl(
  rec: RawCrawlRecord,
  index: number,
  resolveSavedPath: (rec: RawCrawlRecord, index: number) => string,
): CrawledUrl {
  const hasError = typeof rec.error === "string" && rec.error.length > 0;
  const out: CrawledUrl = {
    url: rec.url,
    title: rec.title ?? "",
    kind: normalizeKind(rec.kind),
    // 取得失敗（error あり）や本文空なら保存先は空文字（保存対象が無い）。
    saved_path: hasError ? "" : resolveSavedPath(rec, index),
  };
  return out;
}

/**
 * サイドカー stdout（JSON 配列文字列）→ CrawledUrl[]（純ロジック・テスト対象）。
 * - 壊れた JSON は throw せず空配列（partial-first: 0 件として次フェーズへ）。
 * - 配列でない/要素が不正なものはスキップ（読めるものだけ返す、events.readEvents と同方針）。
 */
export function parseSidecarOutput(
  stdout: string,
  resolveSavedPath: (rec: RawCrawlRecord, index: number) => string,
): CrawledUrl[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CrawledUrl[] = [];
  let i = 0;
  for (const item of parsed) {
    if (isRawCrawlRecord(item)) {
      out.push(mapToCrawledUrl(item, i, resolveSavedPath));
      i += 1;
    }
  }
  return out;
}

/** stdout の 1 要素が RawCrawlRecord として最低限妥当か（url が文字列）。 */
export function isRawCrawlRecord(v: unknown): v is RawCrawlRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o["url"] === "string";
}

/** crawl() のオプション。 */
export interface CrawlOptions {
  /** 1 URL の保存先パスを解決（既定: 何も保存しない＝空文字）。 */
  resolveSavedPath?: (rec: RawCrawlRecord, index: number) => string;
  /** サイドカーのパス（既定: cwd/crawl-py/crawl.py）。テスト/差し替え用。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定: "python"）。 */
  python?: string;
}

/** 既定の保存先リゾルバ: 保存しない（オーケストレータが指定するまで空文字）。 */
const NO_SAVE = (): string => "";

/**
 * URL 群をサイドカーに投げてクロールし、CrawledUrl[] を返す。
 * - spawn("python", ["crawl-py/crawl.py"]) に URL を改行区切りで stdin 投入。
 * - ハード timeout（geminiRunner と同方針: 超過で SIGKILL）。
 * - サイドカー異常終了/タイムアウト/spawn 失敗でも throw せず空配列を返す
 *   （partial-first: クロール 0 件でも次フェーズは進める）。
 */
export function crawl(
  urls: string[],
  timeoutMs: number,
  opts: CrawlOptions = {},
): Promise<CrawledUrl[]> {
  const resolveSavedPath = opts.resolveSavedPath ?? NO_SAVE;
  const sidecarPath = opts.sidecarPath ?? join(process.cwd(), SIDECAR_REL);
  const python = opts.python ?? "python";

  return new Promise<CrawledUrl[]>((resolve) => {
    const child = spawn(python, [sidecarPath], {
      shell: IS_WIN, // Windows は python.exe / py ランチャを PATH 解決
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (result: CrawledUrl[]): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", () => {
      // spawn 失敗（python 不在等）。停止しないで 0 件として返す。
      clearTimeout(timer);
      finish([]);
    });
    child.on("close", () => {
      clearTimeout(timer);
      if (timedOut) {
        finish([]); // タイムアウトは 0 件（partial-first）
        return;
      }
      void stderr; // 診断は stderr に出るが resume には使わない
      finish(parseSidecarOutput(stdout, resolveSavedPath));
    });

    // URL は改行区切りで stdin 投入（argv クオート回避 / サイドカー契約）。
    child.stdin.on("error", () => {
      /* EPIPE 等は close 側で処理 */
    });
    child.stdin.write(urls.join("\n"));
    child.stdin.end();
  });
}
