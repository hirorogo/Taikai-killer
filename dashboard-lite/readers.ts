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
import type { BenchResult, LeaderboardEntry, PhaseStatus } from "../orchestrator/types.ts";
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
// ───────── dashboardFull 用の表示派生ロジック（純関数・テスト対象） ─────────
//
// 方針: ここは「events / leaderboard を**表示しやすい形に整える**」だけの純変換。
// I/O は持たず（readEvents/readLeaderboard が読んだ配列を受け取る）、index.html の
// JS と同じ計算を server 側でも検証できるようにする（XSS とは独立の純ロジック層）。

/** タイムライン上の 1 フェーズの集約状態（S1..S6 の進捗カード1枚分）。 */
export interface PhaseTimelineRow {
  phase: string; // "S1".."S6"（events の phase 文字列をそのまま使う）
  startedTs: string | undefined; // 最初の PhaseStarted の ts（無ければ undefined）
  completedTs: string | undefined; // 最後の PhaseCompleted/PhaseFailed の ts
  status: "pending" | "running" | "ok" | "partial" | "error"; // 集約状態
  startedCount: number; // PhaseStarted の回数（worker/batch 並列で複数あり得る）
  completedCount: number; // PhaseCompleted の回数
  failedCount: number; // PhaseFailed の回数
}

/** events を時系列に保ったまま、phase 単位へ畳み込むための内部正規化エントリ。 */
interface PhaseSignal {
  phase: string;
  kind: "started" | "completed" | "failed";
  ts: string;
  status?: PhaseStatus; // PhaseCompleted のみ持つ（ok/partial/error）
}

/** PhaseStarted/PhaseCompleted/PhaseFailed だけを時系列順に抽出する。
 * - phase を持たないイベント（PipelineStarted 等）は無視。
 * - ts 欠落は空文字に倒す（ソートで先頭に来るが落とさない）。 */
function phaseSignals(events: readonly PipelineEvent[]): PhaseSignal[] {
  const out: PhaseSignal[] = [];
  for (const ev of events) {
    if (ev.type === "PhaseStarted") {
      out.push({ phase: ev.phase, kind: "started", ts: ev.ts ?? "" });
    } else if (ev.type === "PhaseCompleted") {
      out.push({ phase: ev.phase, kind: "completed", ts: ev.ts ?? "", status: ev.status });
    } else if (ev.type === "PhaseFailed") {
      out.push({ phase: ev.phase, kind: "failed", ts: ev.ts ?? "" });
    }
  }
  return out;
}

/** 集約ステータスの優先度（悪い方を勝たせて表示する）。error > partial > ok > running > pending。 */
function worseStatus(
  a: PhaseTimelineRow["status"],
  b: PhaseTimelineRow["status"],
): PhaseTimelineRow["status"] {
  const rank: Record<PhaseTimelineRow["status"], number> = {
    pending: 0,
    running: 1,
    ok: 2,
    partial: 3,
    error: 4,
  };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * events 列から S1..S6 のフェーズ進捗タイムラインを組み立てる純関数（dashboardFull 中央パネル）。
 *
 * 契約（テスト対象）:
 * - 出力は **events に出現したフェーズの phase 文字列順（昇順）** で安定ソート（"S1".."S6"）。
 * - 1 フェーズに複数 worker/batch の Started/Completed が来ても 1 行に畳み込む（カウントで多重度を残す）。
 * - status は集約: Completed/Failed が無く Started のみ → "running"、
 *   PhaseFailed があれば "error"、PhaseCompleted の status を ok/partial/error として反映、
 *   複数あれば worseStatus で悪い方を採用（partial 混在を見落とさない）。
 * - startedTs は最初の Started、completedTs は最後の Completed/Failed の ts。
 * - phase を持たないイベントは無視（PipelineStarted/CircuitBreakerTripped/BudgetExceeded）。
 * - events が空なら空配列（呼び出し側で「まだイベントなし」を表示）。
 */
export function buildPhaseTimeline(events: readonly PipelineEvent[]): PhaseTimelineRow[] {
  const rows = new Map<string, PhaseTimelineRow>();
  for (const sig of phaseSignals(events)) {
    let row = rows.get(sig.phase);
    if (row === undefined) {
      row = {
        phase: sig.phase,
        startedTs: undefined,
        completedTs: undefined,
        status: "pending",
        startedCount: 0,
        completedCount: 0,
        failedCount: 0,
      };
      rows.set(sig.phase, row);
    }
    if (sig.kind === "started") {
      row.startedCount += 1;
      if (row.startedTs === undefined) row.startedTs = sig.ts;
      if (row.status === "pending") row.status = "running";
    } else if (sig.kind === "completed") {
      row.completedCount += 1;
      row.completedTs = sig.ts;
      const s: PhaseTimelineRow["status"] =
        sig.status === "partial" ? "partial" : sig.status === "error" ? "error" : "ok";
      row.status = worseStatus(row.status === "pending" ? "running" : row.status, s);
    } else {
      row.failedCount += 1;
      row.completedTs = sig.ts;
      row.status = worseStatus(row.status, "error");
    }
  }
  return [...rows.values()].sort((a, b) =>
    a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0,
  );
}

/** leaderboard 表示用の 1 行（score 降順 + バー幅 %）。 */
export interface RankedEntry {
  entry: LeaderboardEntry;
  rank: number; // 1 始まりの表示順位（同点は出現順で連番）
  barPct: number; // 0..100。最大 score を 100% とした相対幅（全て <=0 のときは 0）
}

/**
 * leaderboard を score 降順に並べ、バー幅（最大値比の %）を付与する純関数（dashboardFull 右パネル）。
 *
 * 契約（テスト対象）:
 * - score 降順で安定ソート（同点は元の配列順を保つ＝Array.prototype.sort は安定）。
 * - score 欠落/非数は 0 として扱う（観測用に頑健）。
 * - barPct は max(score) を 100 とした 0..100 の相対幅。max<=0（全て 0/負）のとき全行 0。
 * - rank は 1 始まりの表示順位（同点でも連番、tie 表示は UI 側の判断に委ねる）。
 * - 入力は破壊しない（コピーしてソート）。
 */
export function rankLeaderboard(entries: readonly LeaderboardEntry[]): RankedEntry[] {
  const scoreOf = (e: LeaderboardEntry): number =>
    typeof e.score === "number" && Number.isFinite(e.score) ? e.score : 0;
  const sorted = [...entries].sort((a, b) => scoreOf(b) - scoreOf(a));
  const max = sorted.reduce((m, e) => Math.max(m, scoreOf(e)), 0);
  return sorted.map((entry, i) => ({
    entry,
    rank: i + 1,
    barPct: max > 0 ? Math.max(0, Math.min(100, (scoreOf(entry) / max) * 100)) : 0,
  }));
}

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
