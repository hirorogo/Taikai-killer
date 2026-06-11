/**
 * dashboardFull の表示派生ロジック（dashboard-lite/readers.ts の純関数）を検証する。
 * 対象: buildPhaseTimeline（events → S1..S6 フェーズ進捗）と rankLeaderboard（score 降順 + バー幅）。
 * server は起動しない・ファイル I/O 非依存（events 配列 / leaderboard 配列を直接渡す純ロジック）。
 */
import { describe, it, expect } from "vitest";
import { buildPhaseTimeline, rankLeaderboard } from "../dashboard-lite/readers.ts";
import type { PipelineEvent } from "../orchestrator/events.ts";
import type { LeaderboardEntry } from "../orchestrator/types.ts";

/** events を簡潔に組むためのヘルパ（ts は単調増加の固定値）。 */
function started(phase: string, ts: string, worker?: number): PipelineEvent {
  return worker === undefined
    ? { type: "PhaseStarted", phase, ts }
    : { type: "PhaseStarted", phase, ts, worker };
}
function completed(
  phase: string,
  status: "ok" | "partial" | "error",
  ts: string,
): PipelineEvent {
  return { type: "PhaseCompleted", phase, status, ts };
}
function failed(phase: string, error: string, ts: string): PipelineEvent {
  return { type: "PhaseFailed", phase, error, ts };
}

describe("buildPhaseTimeline (events → S1..S6 フェーズ進捗)", () => {
  it("events が空なら空配列", () => {
    expect(buildPhaseTimeline([])).toEqual([]);
  });

  it("phase を持たないイベント（PipelineStarted 等）は無視する", () => {
    const evs: PipelineEvent[] = [
      { type: "PipelineStarted", run_id: "r1", ts: "t0" },
      { type: "CircuitBreakerTripped", reason: "total_retries", count: 20, threshold: 20, ts: "t9" },
    ];
    expect(buildPhaseTimeline(evs)).toEqual([]);
  });

  it("Started のみのフェーズは running 扱い・startedTs を持つ", () => {
    const rows = buildPhaseTimeline([started("S1", "t1")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phase).toBe("S1");
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.startedTs).toBe("t1");
    expect(rows[0]?.completedTs).toBeUndefined();
    expect(rows[0]?.startedCount).toBe(1);
  });

  it("Started→Completed(ok) で ok・completedTs を反映", () => {
    const rows = buildPhaseTimeline([started("S3", "t1"), completed("S3", "ok", "t2")]);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.startedTs).toBe("t1");
    expect(rows[0]?.completedTs).toBe("t2");
    expect(rows[0]?.completedCount).toBe(1);
  });

  it("PhaseFailed は error・failedCount を立てる", () => {
    const rows = buildPhaseTimeline([started("S5", "t1"), failed("S5", "E_CODE_TEST", "t2")]);
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.failedCount).toBe(1);
    expect(rows[0]?.completedTs).toBe("t2");
  });

  it("複数 worker の Started/Completed を 1 行に畳み込みカウントを残す", () => {
    const rows = buildPhaseTimeline([
      started("S5", "t1", 0),
      started("S5", "t1", 1),
      completed("S5", "ok", "t3"),
      completed("S5", "ok", "t4"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startedCount).toBe(2);
    expect(rows[0]?.completedCount).toBe(2);
    expect(rows[0]?.startedTs).toBe("t1"); // 最初の Started
    expect(rows[0]?.completedTs).toBe("t4"); // 最後の Completed
    expect(rows[0]?.status).toBe("ok");
  });

  it("ok/partial 混在は worseStatus で partial を採用（部分完了を見落とさない）", () => {
    const rows = buildPhaseTimeline([
      started("S5", "t1"),
      completed("S5", "ok", "t2"),
      completed("S5", "partial", "t3"),
    ]);
    expect(rows[0]?.status).toBe("partial");
  });

  it("partial と error 混在は error を採用（最悪を勝たせる）", () => {
    const rows = buildPhaseTimeline([
      started("S5", "t1"),
      completed("S5", "partial", "t2"),
      failed("S5", "E_CODE_TEST", "t3"),
    ]);
    expect(rows[0]?.status).toBe("error");
  });

  it("複数フェーズは phase 文字列の昇順で安定ソート（S1..S6）", () => {
    const rows = buildPhaseTimeline([
      started("S6", "t5"),
      started("S1", "t1"),
      completed("S1", "ok", "t2"),
      started("S3", "t3"),
    ]);
    expect(rows.map((r) => r.phase)).toEqual(["S1", "S3", "S6"]);
    expect(rows[0]?.status).toBe("ok"); // S1
    expect(rows[1]?.status).toBe("running"); // S3
    expect(rows[2]?.status).toBe("running"); // S6
  });

  it("ts 欠落イベントでも落とさない（ts は空文字に倒す）", () => {
    const evs = [
      { type: "PhaseStarted", phase: "S1" } as unknown as PipelineEvent,
    ];
    const rows = buildPhaseTimeline(evs);
    expect(rows[0]?.phase).toBe("S1");
    expect(rows[0]?.startedTs).toBe("");
    expect(rows[0]?.status).toBe("running");
  });
});

describe("rankLeaderboard (score 降順 + バー幅)", () => {
  function entry(run_id: string, score: number): LeaderboardEntry {
    return {
      run_id,
      strategy_id: "S3-" + run_id,
      rubric_ref: "toy-rules",
      score,
      passed_test_ratio: 1,
      result_ref: "outputs/" + run_id + "/result.json",
      ts: "2026-06-11T12:00:00Z",
    };
  }

  it("空配列なら空配列", () => {
    expect(rankLeaderboard([])).toEqual([]);
  });

  it("score 降順に並べ rank を 1 始まりで振る", () => {
    const ranked = rankLeaderboard([entry("a", 1), entry("b", 9), entry("c", 5)]);
    expect(ranked.map((r) => r.entry.run_id)).toEqual(["b", "c", "a"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("barPct は max(score) を 100% とした相対幅", () => {
    const ranked = rankLeaderboard([entry("a", 10), entry("b", 5), entry("c", 0)]);
    expect(ranked[0]?.barPct).toBe(100);
    expect(ranked[1]?.barPct).toBe(50);
    expect(ranked[2]?.barPct).toBe(0);
  });

  it("全 score が 0 のとき barPct は全行 0（ゼロ除算しない）", () => {
    const ranked = rankLeaderboard([entry("a", 0), entry("b", 0)]);
    expect(ranked.map((r) => r.barPct)).toEqual([0, 0]);
  });

  it("score 欠落/非数は 0 として扱う", () => {
    const broken = { ...entry("x", 0) } as LeaderboardEntry;
    // @ts-expect-error: 観測データが壊れているケース（score が数値でない）を再現
    broken.score = undefined;
    const ranked = rankLeaderboard([entry("a", 4), broken]);
    expect(ranked[0]?.entry.run_id).toBe("a");
    expect(ranked[1]?.entry.run_id).toBe("x");
    expect(ranked[1]?.barPct).toBe(0);
  });

  it("同点は元の配列順を保つ（安定ソート）", () => {
    const ranked = rankLeaderboard([entry("first", 5), entry("second", 5), entry("third", 5)]);
    expect(ranked.map((r) => r.entry.run_id)).toEqual(["first", "second", "third"]);
    expect(ranked.every((r) => r.barPct === 100)).toBe(true);
  });

  it("入力配列を破壊しない（コピーしてソート）", () => {
    const input: LeaderboardEntry[] = [entry("a", 1), entry("b", 9)];
    const snapshot = input.map((e) => e.run_id);
    rankLeaderboard(input);
    expect(input.map((e) => e.run_id)).toEqual(snapshot);
  });
});
