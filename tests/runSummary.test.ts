/**
 * orchestrator/runSummary.ts の純ロジックを tmpdir で検証する（外部プロセス/ネット非依存）。
 * - foldPhases: events → phase 畳み込み（running / ok / partial / error の確定と ts 採否）。
 * - summarizeRun: result 反映（test の ratio/passed・battle の winner）/ leaderboard 抽出 / 空 run。
 * outputs パス規約（orchestrator/paths.ts）に沿った構造を tmpdir に作って読む。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldPhases, summarizeRun } from "../orchestrator/runSummary.ts";
import type { PipelineEvent } from "../orchestrator/events.ts";
import type { BenchResult, LeaderboardEntry } from "../orchestrator/types.ts";

// ───────── events ヘルパ（ts を明示して畳み込みの ts 採否を検証可能に） ─────────

const started = (phase: string, ts: string): PipelineEvent => ({ type: "PhaseStarted", phase, ts });
const completed = (
  phase: string,
  status: "ok" | "partial" | "error",
  ts: string,
): PipelineEvent => ({ type: "PhaseCompleted", phase, status, ts });
const failed = (phase: string, ts: string): PipelineEvent => ({
  type: "PhaseFailed",
  phase,
  error: "E_CODE_TEST",
  ts,
});

/** outputs/{run}/ を最小構成で作るヘルパ。 */
function makeRun(
  outputsDir: string,
  id: string,
  opts: { result?: BenchResult | string; events?: PipelineEvent[] } = {},
): string {
  const dir = join(outputsDir, id);
  mkdirSync(dir, { recursive: true });
  if (opts.result !== undefined) {
    const body = typeof opts.result === "string" ? opts.result : JSON.stringify(opts.result);
    writeFileSync(join(dir, "result.json"), body, "utf8");
  }
  if (opts.events !== undefined) {
    mkdirSync(join(dir, "events"), { recursive: true });
    const lines = opts.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(dir, "events", "pipeline.jsonl"), lines, "utf8");
  }
  return dir;
}

function writeLeaderboard(outputsDir: string, entries: LeaderboardEntry[]): void {
  writeFileSync(join(outputsDir, "leaderboard.json"), JSON.stringify(entries), "utf8");
}

const testResult: BenchResult = {
  result_id: "r1",
  strategy_id: "S3-001",
  rubric_ref: "toy-fizzbuzz-rules",
  eval_mode: "test",
  score: 1,
  rank: 1,
  metrics: { passed_test_ratio: 1 },
  passed_test_ratio: 1,
  threshold: [],
};

const battleResult: BenchResult = {
  result_id: "janken-run:beat-last",
  strategy_id: "beat-last",
  rubric_ref: "toy-janken-rules",
  eval_mode: "battle",
  score: 0.475,
  rank: 1,
  metrics: { win_rate: 0.475 },
  win_rate: 0.475,
  threshold: [],
};

const lbEntry = (run_id: string, strategy_id: string, score: number): LeaderboardEntry => ({
  run_id,
  strategy_id,
  rubric_ref: "toy-rules",
  score,
  passed_test_ratio: score,
  result_ref: `outputs/${run_id}/result.json`,
  ts: "2026-06-11T00:00:00.000Z",
});

describe("foldPhases (events → phase 畳み込み・純関数)", () => {
  it("events 空なら空配列", () => {
    expect(foldPhases([])).toEqual([]);
  });

  it("Started のみは running（ts は最初の Started）", () => {
    const rows = foldPhases([started("S3", "t1"), started("S3", "t2")]);
    expect(rows).toEqual([{ phase: "S3", status: "running", ts: "t1" }]);
  });

  it("Started→Completed(ok) は ok（ts は Completed で上書き）", () => {
    const rows = foldPhases([started("S3", "t1"), completed("S3", "ok", "t2")]);
    expect(rows).toEqual([{ phase: "S3", status: "ok", ts: "t2" }]);
  });

  it("複数 worker で partial が混ざれば partial を採用（悪い方優先）", () => {
    const rows = foldPhases([
      started("S5", "t1"),
      started("S5", "t2"),
      completed("S5", "ok", "t3"),
      completed("S5", "partial", "t4"),
    ]);
    expect(rows).toEqual([{ phase: "S5", status: "partial", ts: "t4" }]);
  });

  it("PhaseFailed は error（partial より悪い）", () => {
    const rows = foldPhases([
      started("S5", "t1"),
      completed("S5", "partial", "t2"),
      failed("S5", "t3"),
    ]);
    expect(rows).toEqual([{ phase: "S5", status: "error", ts: "t3" }]);
  });

  it("複数フェーズは phase 昇順で安定ソート", () => {
    const rows = foldPhases([
      started("S6", "t3"),
      completed("S6", "ok", "t4"),
      started("S1", "t1"),
      completed("S1", "ok", "t2"),
    ]);
    expect(rows.map((r) => r.phase)).toEqual(["S1", "S6"]);
  });

  it("phase を持たないイベント（PipelineStarted 等）は無視", () => {
    const rows = foldPhases([
      { type: "PipelineStarted", run_id: "x", ts: "t0" },
      { type: "BudgetExceeded", budget_usd: 1, spent_usd: 2, ts: "t1" },
      started("S3", "t2"),
      completed("S3", "ok", "t3"),
    ]);
    expect(rows).toEqual([{ phase: "S3", status: "ok", ts: "t3" }]);
  });

  it("ts 欠落は空文字に倒す（落とさない）", () => {
    const ev = { type: "PhaseStarted", phase: "S3" } as unknown as PipelineEvent;
    const rows = foldPhases([ev]);
    expect(rows).toEqual([{ phase: "S3", status: "running", ts: "" }]);
  });
});

describe("summarizeRun (run 要約)", () => {
  let outputs: string;
  beforeEach(() => {
    outputs = mkdtempSync(join(tmpdir(), "taikai-runsummary-"));
  });
  afterEach(() => {
    rmSync(outputs, { recursive: true, force: true });
  });

  it("空 run（result/events 無し）: evalMode undefined・phases/leaderboardTop 空・passed等なし", () => {
    const dir = makeRun(outputs, "empty-run");
    const d = summarizeRun(dir);
    expect(d.runId).toBe("empty-run");
    expect(d.evalMode).toBeUndefined();
    expect(d.phases).toEqual([]);
    expect(d.leaderboardTop).toEqual([]);
    expect("passed" in d).toBe(false);
    expect("ratio" in d).toBe(false);
    expect("winner" in d).toBe(false);
  });

  it("test 型: ratio=passed_test_ratio・passed=(ratio===1)", () => {
    const dir = makeRun(outputs, "dev-run", { result: testResult });
    const d = summarizeRun(dir);
    expect(d.evalMode).toBe("test");
    expect(d.ratio).toBe(1);
    expect(d.passed).toBe(true);
    expect("winner" in d).toBe(false);
  });

  it("test 型: 部分通過は passed=false", () => {
    const partial: BenchResult = { ...testResult, passed_test_ratio: 0.6, score: 0.6 };
    const dir = makeRun(outputs, "part-run", { result: partial });
    const d = summarizeRun(dir);
    expect(d.ratio).toBe(0.6);
    expect(d.passed).toBe(false);
  });

  it("battle 型: winner=result.strategy_id（rank1 勝者）", () => {
    const dir = makeRun(outputs, "janken-run", { result: battleResult });
    const d = summarizeRun(dir);
    expect(d.evalMode).toBe("battle");
    expect(d.winner).toBe("beat-last");
    expect("ratio" in d).toBe(false);
    expect("passed" in d).toBe(false);
  });

  it("events を foldPhases で反映", () => {
    const dir = makeRun(outputs, "ev-run", {
      result: testResult,
      events: [started("S3", "t1"), completed("S3", "ok", "t2"), started("S5", "t3")],
    });
    const d = summarizeRun(dir);
    expect(d.phases).toEqual([
      { phase: "S3", status: "ok", ts: "t2" },
      { phase: "S5", status: "running", ts: "t3" },
    ]);
  });

  it("leaderboardTop は当該 run のみ score 降順（既定3件）", () => {
    const dir = makeRun(outputs, "dev-run", { result: testResult });
    writeLeaderboard(outputs, [
      lbEntry("dev-run", "a", 0.5),
      lbEntry("other-run", "z", 1.0), // 別 run は除外
      lbEntry("dev-run", "b", 0.9),
      lbEntry("dev-run", "c", 0.1),
      lbEntry("dev-run", "d", 0.7),
    ]);
    const d = summarizeRun(dir);
    expect(d.leaderboardTop.map((e) => e.strategy_id)).toEqual(["b", "d", "a"]);
  });

  it("壊れた result.json は throw せず evalMode undefined に倒す", () => {
    const dir = makeRun(outputs, "broken-run", { result: "{not json" });
    const d = summarizeRun(dir);
    expect(d.evalMode).toBeUndefined();
    expect("passed" in d).toBe(false);
  });

  it("battle 型で strategy_id が空なら leaderboard 先頭にフォールバック", () => {
    const dir = makeRun(outputs, "fb-run", { result: { ...battleResult, strategy_id: "" } });
    writeLeaderboard(outputs, [lbEntry("fb-run", "fallback-strat", 0.9)]);
    const d = summarizeRun(dir);
    expect(d.winner).toBe("fallback-strat");
  });
});
