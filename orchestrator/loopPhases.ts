/**
 * ループに差し込む S2/S4 フェーズの「任意・graceful」実装（docs S1->S6 完全形への部品）。
 *
 * 位置づけ（docs/architecture.md L115-124 / mvp-vertical-slice.md「S2/S4 は薄くスキップ可」）:
 * - S2 外部知見: DEF/SUB から検索ワード→クロール→知見。ここでは TournamentInfo に
 *   source_url 等があれば crawl.ts に委譲して短い「知見ダイジェスト」を作り S3 に渡す。
 * - S4 要件精緻化: S3 戦略ごとに「この戦略で解くための仕様の曖昧点・エッジ」を 2-3 点に
 *   絞って spec に前置する（戦略特化の要件定義_*.json の MVP 軽量版）。
 *
 * 設計方針（CLAUDE.md「単一ワーカーの失敗でループを止めない」/ crawl.ts・s2.ts のスタイル）:
 * - 両関数とも graceful: ネット/外部/LLM の失敗で throw せず、スキップ相当の安全値を返す
 *   （gatherKnowledge は空文字、refineRequirements は素の spec）。ループを止めない。
 * - 純ロジック（formatKnowledge / mergeRefinement）を named export し vitest でテストする。
 *   spawn（crawl）/ subprocess（runCLISubprocess）はテスト外（副作用関数に隔離）。
 * - 共有 .ts（crawl.ts / s2.ts / runtimeRegistry.ts / types.ts）は読むだけ・改変しない。
 *
 * runner への配線はこのファイルでは行わない（共有 runner は触らない）:
 *   → runLoop の round ループ内で、generateStrategies（S3）呼び出しの前に gatherKnowledge を
 *     一度走らせて digest を得て spec に前置し、各戦略の implementStrategyTest（S5）の前に
 *     refineRequirements(spec, strat.approach, ...) で spec を精緻化して渡す。
 *   （配線は担当者が後で行う。ここは部品の提供に徹する。）
 */
import { join } from "node:path";
import { crawl } from "./crawl.ts";
import { tokenize, dedupeUrls, resolveKnowledgePath, saveKnowledge } from "./s2.ts";
import { runCLISubprocess } from "./runtimeRegistry.ts";
import type { TournamentInfo } from "./types.ts";
import type { CrawledUrl } from "./types.ts";
import type { GenerateInput, GenerateOutput } from "./runtimeRegistry.ts";

// ───────── (1) S2: gatherKnowledge ─────────

/** gatherKnowledge のオプション（テスト/差し替え用フック）。 */
export interface GatherKnowledgeOptions {
  /** crawl のハード timeout（ms）。既定 60_000。 */
  timeoutMs?: number;
  /** crawl を差し替えるフック（テスト用。既定は crawl.ts の crawl）。 */
  crawlFn?: typeof crawl;
  /** ダイジェストに含める知見の最大件数（既定 5）。 */
  maxItems?: number;
  /** ダイジェスト 1 行のタイトル切り詰め長（既定 200）。本文抜粋ではない（命名は titleMaxChars 系）。 */
  titleMaxChars?: number;
  /**
   * crawl に渡す保存先リゾルバの差し替え口（テスト/配線用）。
   * 未指定なら既定で runDir/knowledge 配下に本文を保存して saved_path を確定する
   * （これを渡さないと既定 crawl は NO_SAVE で saved_path 空＝ダイジェスト恒久 no-op になる）。
   */
  resolveSavedPath?: (rec: { url: string; title: string; text: string }, index: number) => string;
}

/**
 * クロール結果（CrawledUrl[]）から S3 に渡す短いダイジェスト文字列を整形（純ロジック・テスト対象）。
 *
 * - saved_path が空（取得失敗/本文なし）のレコードは捨てる（知見として使えない）。
 * - title を主見出しに、url を出典として箇条書きにする。本文は別保存（slim）なので
 *   ここでは title から代表トークンを少数添えて「何の知見か」を S3 に示す（INDEX 不要の軽量版）。
 * - 上限 maxItems 件まで（決定論的に入力順）。0 件なら空文字（＝知見なし＝スキップ相当）。
 * - titleMaxChars はタイトルが長い場合の切り詰め長（本文抜粋は未実装。旧名 excerptChars は
 *   「本文抜粋」を示唆して紛らわしいので titleMaxChars に改名。後方互換で excerptChars も受ける）。
 *
 * 返り値は S3 プロンプトに前置できる短いテキスト（空なら呼び側で前置しない）。
 */
export function formatKnowledge(
  crawled: readonly CrawledUrl[],
  opts: { maxItems?: number; titleMaxChars?: number; excerptChars?: number } = {},
): string {
  const maxItems = opts.maxItems ?? 5;
  const titleMaxChars = opts.titleMaxChars ?? opts.excerptChars ?? 200;

  const usable = crawled.filter((c) => c.saved_path.length > 0);
  if (usable.length === 0) return "";

  const lines: string[] = [];
  for (const c of usable.slice(0, maxItems)) {
    const title = (c.title ?? "").trim().slice(0, titleMaxChars) || "(無題)";
    // title から代表トークンを少数添える（重複排除・出現順、最大5語）。
    const tags = uniqueTokens(tokenize(title), 5);
    const tagStr = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
    lines.push(`- ${title} <${c.url}>${tagStr}`);
  }
  return `## 外部知見ダイジェスト（S2 / 戦略立案の参考。鵜呑みにしない）\n${lines.join("\n")}`;
}

/** トークン列から出現順で重複排除し先頭 n 件（純ヘルパ）。 */
function uniqueTokens(tokens: readonly string[], n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * TournamentInfo からクロール対象 URL 候補を抽出（純ロジック・テスト対象）。
 * - source_url があれば採用。dedupe（s2.ts に委譲）して決定論的に返す。
 * - URL が一つも無ければ空配列（＝S2 スキップ）。将来 検索ワード由来 URL もここに合流。
 */
export function knowledgeSeedUrls(ti: TournamentInfo): string[] {
  const seeds: string[] = [];
  if (typeof ti.source_url === "string" && ti.source_url.trim().length > 0) {
    seeds.push(ti.source_url.trim());
  }
  return dedupeUrls(seeds);
}

/**
 * S2 外部知見フェーズ（副作用あり・graceful）。
 *
 * - TournamentInfo に source_url（将来は検索ワード由来 URL も）があれば crawl.ts に委譲して
 *   知見を集め、formatKnowledge で S3 に渡す短いダイジェスト文字列を返す。
 * - 知見源が無ければ空文字を返す（スキップ）。
 * - ネット/外部失敗（crawl が 0 件 / spawn 失敗 / 例外）でも throw せず空文字を返す（graceful）。
 *   crawl() 自体が partial-first で throw しない設計だが、念のため try/catch で全体を包む。
 *
 * runDir で saved_path を「この run の knowledge 配下」に確定する。crawl 既定の resolveSavedPath
 * は NO_SAVE（→ saved_path 空）なので、ここで明示リゾルバを渡さないと formatKnowledge の採用ゲート
 * （saved_path 非空）に全件落ちてダイジェストが恒久 no-op になる。よって既定で saveKnowledge を
 * 渡して本文を保存し saved_path を確定する（差し替えは opts.resolveSavedPath）。
 */
export async function gatherKnowledge(
  runDir: string,
  ti: TournamentInfo,
  opts: GatherKnowledgeOptions = {},
): Promise<string> {
  try {
    const urls = knowledgeSeedUrls(ti);
    if (urls.length === 0) return ""; // 知見源なし → スキップ。

    const doCrawl = opts.crawlFn ?? crawl;
    const timeoutMs = opts.timeoutMs ?? 60_000;

    // 既定リゾルバ: runDir/knowledge 配下に本文を保存し、成功時のみ確定パスを返す
    // （本文空は保存せず "" → saved_path 空＝ダイジェスト不採用。s2.ts と同方針）。
    const knowledgeDir = join(runDir, "knowledge");
    const resolveSavedPath =
      opts.resolveSavedPath ??
      ((rec: { url: string; title: string; text: string }, i: number): string => {
        const text = rec.text ?? "";
        if (text.trim().length === 0) return "";
        const target = resolveKnowledgePath(knowledgeDir, rec.url, i);
        return saveKnowledge(knowledgeDir, target, text);
      });

    const crawled = await doCrawl(urls, timeoutMs, { resolveSavedPath });

    const fmtOpts: { maxItems?: number; titleMaxChars?: number } = {};
    if (opts.maxItems !== undefined) fmtOpts.maxItems = opts.maxItems;
    if (opts.titleMaxChars !== undefined) fmtOpts.titleMaxChars = opts.titleMaxChars;
    return formatKnowledge(crawled, fmtOpts);
  } catch {
    // ネット/外部失敗は知見なし扱い（graceful: ループを止めない）。
    return "";
  }
}

// ───────── (2) S4: refineRequirements ─────────

/** S4 をスキップする環境変数（CLAUDE.md「env で薄くスキップ可」）。 */
export const SKIP_S4_ENV = "TAIKAI_SKIP_S4";

/** runCLISubprocess 互換の最小シグネチャ（テストでスタブ可能にするため）。 */
export type CLIRunner = typeof runCLISubprocess;

/** refineRequirements のオプション。 */
export interface RefineOptions {
  /** LLM 呼び出しのハード timeout（ms）。既定 60_000。 */
  timeoutMs?: number;
  /** runCLISubprocess を差し替えるフック（テスト用。既定は runtimeRegistry の実体）。 */
  runner?: CLIRunner;
  /** 使用モデル（既定 "claude"）。 */
  model?: "claude" | "gemini";
}

/**
 * LLM が返した「曖昧点・エッジ」テキストを spec にマージする（純ロジック・テスト対象）。
 *
 * - refinement が空（trim 長 0）なら spec をそのまま返す（精緻化なし＝安全側）。
 * - refinement があれば spec の末尾に戦略特化の精緻化ブロックを前付き見出しで足す。
 *   strategyApproach は何の戦略向けの精緻化かを示すヘッダに使う（長すぎは切り詰め）。
 * - spec は決して捨てない（精緻化は spec への追記であって置換ではない＝情報を失わない）。
 */
export function mergeRefinement(
  spec: string,
  refinement: string,
  strategyApproach: string,
): string {
  const r = refinement.trim();
  if (r.length === 0) return spec;
  const head = strategyApproach.trim().slice(0, 80);
  const headStr = head.length > 0 ? `（戦略: ${head}）` : "";
  return `${spec}\n\n## 要件精緻化（S4 / この戦略で解くための曖昧点・エッジ）${headStr}\n${r}`;
}

/** S4 プロンプト本文を組み立てる（純ロジック・テスト対象。指示文は静的、穴埋めのみ）。 */
export function buildRefinePrompt(spec: string, strategyApproach: string): string {
  return `あなたは S4 要件精緻化担当。下記の戦略でこの課題を解くために、仕様の曖昧点・見落としやすいエッジケースを **2〜3 点だけ** に絞って日本語の箇条書きで挙げよ。
コードは書かない。仕様にない新ルールを発明しない（既存仕様の曖昧さの明確化のみ）。各点 1〜2 文。

## 課題仕様
${spec}

## 戦略
${strategyApproach}

出力は「- 」始まりの箇条書き 2〜3 行のみ。前置き・後置きの地の文は書かない。`;
}

/**
 * S4 軽量要件精緻化（副作用あり・graceful）。
 *
 * - env TAIKAI_SKIP_S4=1 なら LLM を呼ばず spec をそのまま返す（薄くスキップ）。
 * - そうでなければ runCLISubprocess で「この戦略で解くための曖昧点・エッジを 2-3 点に絞れ」を
 *   1 回だけ問い、mergeRefinement で spec に追記して返す。
 * - allowedTools: [] を明示（CLAUDE.md「フェーズ別にツール許可を絞る＝集中力ガード」）。S4 は
 *   コードを書かない純 Q&A なので全ツール無効を契約化する（未指定だと runner 実装依存になる）。
 * - LLM 失敗（emptyResult / 例外 / 空テキスト）なら spec をそのまま返す（graceful・ループを止めない）。
 *   再試行はしない（1 回のみ＝S5 の D22 ループの足を引っ張らない軽量フェーズ）。
 */
export async function refineRequirements(
  spec: string,
  strategyApproach: string,
  opts: RefineOptions = {},
): Promise<string> {
  if (process.env[SKIP_S4_ENV] === "1") return spec; // 明示スキップ。

  const runner = opts.runner ?? runCLISubprocess;
  const model = opts.model ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // 純生成フェーズ: コードを書かないので全ツール無効を契約化（集中力ガード）。
  const input: GenerateInput = {
    prompt: buildRefinePrompt(spec, strategyApproach),
    timeoutMs,
    allowedTools: [],
  };

  let out: GenerateOutput;
  try {
    out = await runner(model, input);
  } catch {
    return spec; // LLM 呼び出し例外 → 精緻化なし（graceful）。
  }
  if (out.emptyResult) return spec; // returncode 0 でも実質空 → 精緻化なし。
  return mergeRefinement(spec, out.text, strategyApproach);
}
