/**
 * dashboard-lite の純ロジック層（依存ゼロ・テスト対象）。
 * 「ウェブダッシュボードは参考用(vendor speca)しか無い」ため、自前の最小 read-only
 * ダッシュボードを node 標準のみで作る（docs/architecture.md / decisions.md D31）。
 *
 * 方針:
 * - outputs パス規約は orchestrator/paths.ts に従う（run dir / result.json / leaderboard.json）。
 * - events の読み戻しは orchestrator/events.ts の readEvents を**再利用**（壊れ行スキップを二重実装しない / D9）。
 * - すべて read-only。書き込み・外部プロセス・ネットへは一切触れない（server.ts が薄く呼ぶだけ）。
 * - 存在しない/壊れたファイルは throw せず空に倒す（ダッシュボードは観測用で、欠落で落とさない）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resultPath } from "../orchestrator/paths.ts";
import { readEvents as readPipelineEvents, pipelineLogPath } from "../orchestrator/events.ts";
import type { BenchResult, LeaderboardEntry } from "../orchestrator/types.ts";
import type { PipelineEvent } from "../orchestrator/events.ts";

/** 1 run の一覧表示用サマリ（重い payload は読まず軽量メタのみ）。 */
export interface RunSummary {
  id: string; // run dir 名（= run_id 規約: {ISO8601}-{hash}-{slug}）
  dir: string; // 絶対パス（server が個別 API で再利用）
  hasResult: boolean; // result.json が存在するか
  hasEvents: boolean; // events/pipeline.jsonl が存在するか
  mtimeMs: number; // run dir の最終更新（新しい順ソート用）
}

/** outputs 直下の run dir を列挙する（新しい順）。
 * - outputs が無ければ空配列。
 * - ファイル（leaderboard.json / .gitkeep）やドットディレクトリは除外。
 * - 1件の statSync 失敗で全体を落とさない（best-effort 観測）。
 */
export function listRuns(outputsDir: string): RunSummary[] {
  if (!existsSync(outputsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(outputsDir);
  } catch {
    return [];
  }
  const out: RunSummary[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // .gitkeep / .taikai 等
    const dir = join(outputsDir, name);
    let mtimeMs = 0;
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue; // leaderboard.json などのファイルは除外
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    out.push({
      id: name,
      dir,
      hasResult: existsSync(resultPath(dir)),
      hasEvents: existsSync(join(dir, "events", "pipeline.jsonl")),
      mtimeMs,
    });
  }
  // 新しい run を上に（同 mtime は id の辞書順で安定化）
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** run dir の result.json を読む。無ければ null、壊れていても throw せず null。 */
export function readResult(runDir: string): BenchResult | null {
  const path = resultPath(runDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BenchResult;
  } catch {
    return null;
  }
}

/** outputs/leaderboard.json を読む。無ければ空配列、壊れていても空配列（観測用に頑健）。
 * 配列でない JSON が来た場合も空に倒す。 */
export function readLeaderboard(outputsDir: string): LeaderboardEntry[] {
  const path = join(outputsDir, "leaderboard.json");
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as LeaderboardEntry[]) : [];
  } catch {
    return [];
  }
}

/** run dir の events/pipeline.jsonl をパースする（壊れ行スキップ）。
 * 実体は orchestrator/events.ts の readEvents（D9: append-only ログの監査読み戻し）。 */
export function readEvents(runDir: string): PipelineEvent[] {
  return readPipelineEvents(runDir);
}

/** readEventsSince の戻り（新イベント＋次回読み出し開始バイトオフセット）。
 * SSE tail のカーソル: クライアントは offset を保持し次の問い合わせに渡す。 */
export interface EventsSince {
  events: PipelineEvent[]; // offset 以降に出現した新イベント（壊れ行はスキップ）
  offset: number; // 次回 readEventsSince に渡すべきバイトオフセット（= 完結行までの消費量）
}

/**
 * 指定バイトオフセット以降の **新イベント** を返す純関数（SSE tail のコア）。
 * append-only な pipeline.jsonl を前提に、前回返した offset から増えた分だけをパースする。
 *
 * 契約（テスト対象）:
 * - offset はバイト単位（jsonl は append-only なので「読み終えた長さ」が安定したカーソルになる）。
 * - 末尾が改行で終わっていない＝書き込み途中の部分行は **採用しない**（次回 append で完結してから返す）。
 *   そのため offset は「最後の改行の直後」まで（完結した行の総バイト数）しか進めない。
 * - 壊れた行（JSON.parse 失敗）は events から除外するが、行としては消費済みなので offset は前進させる
 *   （events.ts/readEvents と同じ「読めるものだけ返す」頑健性）。
 * - ファイルが無い / offset がファイル長以上（新規追記なし）なら events 空・offset はファイル長に正規化。
 * - offset が負/NaN は 0 にクランプ（不正カーソルでも落とさない）。
 *
 * 注意: ファイルが途中で短くなる（切詰め）ケースは append-only 前提では起きないため扱わない
 * （万一 offset > size でも events 空・offset=size に倒して安全側）。
 */
export function readEventsSince(runDir: string, offset: number): EventsSince {
  const path = pipelineLogPath(runDir);
  if (!existsSync(path)) {
    return { events: [], offset: 0 };
  }
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    return { events: [], offset: Number.isFinite(offset) && offset > 0 ? offset : 0 };
  }
  const size = raw.length;
  // 不正カーソルを [0, size] にクランプ（append-only 前提: 巻き戻り/切詰めは安全側に倒す）。
  const start = Number.isFinite(offset) ? Math.min(Math.max(0, Math.floor(offset)), size) : 0;

  // 完結行のみ採用するため、最後の改行位置までを「消費可能領域」とする。
  const lastNl = raw.lastIndexOf(0x0a); // "\n"
  if (lastNl < start) {
    // start 以降に完結した行が無い（部分行のみ）→ 何も返さず offset 据え置き。
    return { events: [], offset: start };
  }
  const consumedEnd = lastNl + 1; // 最後の改行の直後まで消費する
  const slice = raw.subarray(start, consumedEnd).toString("utf8");
  const events: PipelineEvent[] = [];
  for (const line of slice.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PipelineEvent);
    } catch {
      // 壊れ行はスキップ（行は消費済みなので offset は前進させる）。
    }
  }
  return { events, offset: consumedEnd };
}
