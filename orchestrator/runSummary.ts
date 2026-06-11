/**
 * run ディレクトリ要約（純ロジック / 観測用）。
 * 正: docs/architecture.md「S6 の2評価モード（eval_mode）」「データ契約 BenchResult/LeaderboardEntry」、
 *     docs/implementation-status.md §2（test型は passed_test_ratio、battle型は winner=rank1 strategy）。
 *
 * 役割:
 * - 1 run の result.json / events/pipeline.jsonl / outputs/leaderboard.json を
 *   人間可読 & 機械可読な 1 オブジェクトに畳み込む（summarizeRun）。
 * - フェーズ畳み込みは純関数 foldPhases(events) に切り出す（events 1 列 → phase ごとの最終状態）。
 *
 * 方針（dashboard-lite/readers.ts と同じ「観測用に頑健」）:
 * - 読むのは readers.ts（readResult/readEvents/readLeaderboard）と events.ts（readEvents 経由）だけ。
 *   I/O はそこへ委譲し、ここは「読んだ配列/オブジェクトを畳み込む」純変換に寄せる。
 * - 欠落（result 無し / events 無し / 空 run）でも throw せず、undefined / 空配列に倒す。
 * - leaderboard は outputs 横断ファイル。当該 run の run_id 分だけを score 降順で抜き出す。
 */
import { basename, dirname } from "node:path";
import { readResult, readEvents, readLeaderboard, rankLeaderboard } from "../dashboard-lite/readers.ts";
import type { PipelineEvent } from "./events.ts";
import type { PhaseStatus, LeaderboardEntry } from "./types.ts";

/** foldPhases が返す 1 フェーズの畳み込み結果。 */
export interface PhaseFold {
  phase: string; // events の phase 文字列そのまま（"S1".."S6"）
  status: PhaseStatus | "running"; // 最終状態（後述の優先順位で確定）
  ts: string; // 状態を確定させたイベントの ts（最後の Completed/Failed、無ければ最初の Started）
}

/** summarizeRun の戻り（機械可読サマリ）。 */
export interface RunDigest {
  runId: string; // run dir 名（= run_id 規約: {ISO8601}-{hash}-{slug}）
  evalMode: "test" | "battle" | undefined; // result.json の eval_mode（result 欠落時 undefined）
  passed?: boolean; // test 型のみ: passed_test_ratio === 1（全通過か）
  ratio?: number; // test 型のみ: passed_test_ratio（一次指標）
  winner?: string; // battle 型のみ: rank 1 の strategy_id（勝者）
  phases: PhaseFold[]; // events 畳み込み（phase 昇順）
  leaderboardTop: LeaderboardEntry[]; // 当該 run の leaderboard 上位（score 降順）
}

/** status の優先度（悪い方/確定済みを勝たせる）。error > partial > ok > running。 */
const STATUS_RANK: Record<PhaseFold["status"], number> = {
  running: 0,
  ok: 1,
  partial: 2,
  error: 3,
};

/** 集約 status は「より確定的で悪い方」を採用（partial / error の混在を見落とさない）。 */
function worse(a: PhaseFold["status"], b: PhaseFold["status"]): PhaseFold["status"] {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/**
 * events 列を phase 単位の最終状態へ畳み込む純関数（テスト対象）。
 *
 * 契約:
 * - phase を持つイベント（PhaseStarted / PhaseCompleted / PhaseFailed）のみ対象。
 *   PipelineStarted / CircuitBreakerTripped / BudgetExceeded は無視。
 * - 同一 phase に複数 worker/batch のイベントが来ても 1 行へ畳み込む。
 * - status は: Started のみ → "running"、PhaseCompleted の status（ok/partial/error）を反映、
 *   PhaseFailed → "error"。複数あれば worse で確定的かつ悪い方を採用。
 * - ts は「状態を確定させたイベント」の時刻: Completed/Failed が来ていれば最後のその ts、
 *   まだ running なら最初の Started の ts（観測の起点）。ts 欠落は空文字に倒す。
 * - 出力は phase 文字列の昇順で安定ソート（"S1".."S6"）。
 * - events 空なら空配列。
 */
export function foldPhases(events: readonly PipelineEvent[]): PhaseFold[] {
  const rows = new Map<string, PhaseFold>();
  // 確定イベント（Completed/Failed）を受けたかを phase ごとに覚え、ts の採否を切替える。
  const settled = new Set<string>();

  for (const ev of events) {
    if (ev.type === "PhaseStarted" || ev.type === "PhaseCompleted" || ev.type === "PhaseFailed") {
      const phase = ev.phase;
      const ts = ev.ts ?? "";
      let row = rows.get(phase);
      if (row === undefined) {
        row = { phase, status: "running", ts: "" };
        rows.set(phase, row);
      }

      if (ev.type === "PhaseStarted") {
        // まだ確定イベントが無い間だけ、最初の Started の ts を観測起点として保持。
        if (!settled.has(phase) && row.ts === "") row.ts = ts;
        // status は running を下限に（既に ok/partial/error なら据え置き）。
        row.status = worse(row.status, "running");
      } else if (ev.type === "PhaseCompleted") {
        const s: PhaseFold["status"] =
          ev.status === "partial" ? "partial" : ev.status === "error" ? "error" : "ok";
        row.status = worse(row.status, s);
        row.ts = ts; // 最後の確定イベントの ts で上書き
        settled.add(phase);
      } else {
        row.status = worse(row.status, "error");
        row.ts = ts;
        settled.add(phase);
      }
    }
  }

  return [...rows.values()].sort((a, b) => (a.phase < b.phase ? -1 : a.phase > b.phase ? 1 : 0));
}

/**
 * outputs/leaderboard.json から当該 run（run_id 一致）の上位行を score 降順で返す純ヘルパ。
 * - leaderboard は run 横断ファイルなので run_id でフィルタしてから rankLeaderboard で並べる。
 * - rankLeaderboard は入力を破壊せず score 降順（非数 score は 0 扱い）。
 */
function leaderboardTopForRun(outputsDir: string, runId: string, limit: number): LeaderboardEntry[] {
  const all = readLeaderboard(outputsDir);
  const mine = all.filter((e) => e.run_id === runId);
  return rankLeaderboard(mine)
    .slice(0, limit)
    .map((r) => r.entry);
}

/**
 * 1 run ディレクトリを要約する（観測用 / 純ロジック）。
 *
 * 契約:
 * - runId は runDir の basename（run_id 規約）。
 * - result.json があれば eval_mode を採り、モード別に一次指標を反映:
 *   - "test": ratio = passed_test_ratio、passed = (ratio === 1)（全通過のみ true）。
 *   - "battle": winner = result.strategy_id（result は rank 1 の勝者行）。
 *     winner が空/欠落なら leaderboard 先頭の strategy_id にフォールバック。
 * - result.json が無ければ evalMode=undefined、passed/ratio/winner は付与しない
 *   （exactOptionalPropertyTypes: undefined を載せず key 自体を省く）。
 * - phases は events/pipeline.jsonl を foldPhases で畳み込み（events 無し → 空配列）。
 * - leaderboardTop は親 outputs の leaderboard.json から当該 run 分を score 降順で（既定 3 件）。
 * - 欠落/壊れは throw せず空/undefined に倒す（観測用ダッシュボードを落とさない）。
 */
export function summarizeRun(runDir: string, opts?: { leaderboardLimit?: number }): RunDigest {
  const runId = basename(runDir);
  const outputsDir = dirname(runDir); // run dir は outputs/{run} 規約 → 親が outputs
  const limit = opts?.leaderboardLimit ?? 3;

  const result = readResult(runDir);
  const phases = foldPhases(readEvents(runDir));
  const leaderboardTop = leaderboardTopForRun(outputsDir, runId, limit);

  const digest: RunDigest = {
    runId,
    evalMode: result?.eval_mode,
    phases,
    leaderboardTop,
  };

  if (result !== null) {
    if (result.eval_mode === "test") {
      const ratio = typeof result.passed_test_ratio === "number" ? result.passed_test_ratio : undefined;
      if (ratio !== undefined) {
        digest.ratio = ratio;
        digest.passed = ratio === 1;
      }
    } else if (result.eval_mode === "battle") {
      const winner =
        typeof result.strategy_id === "string" && result.strategy_id !== ""
          ? result.strategy_id
          : leaderboardTop[0]?.strategy_id;
      if (winner !== undefined && winner !== "") digest.winner = winner;
    }
  }

  return digest;
}
