/**
 * dashboard-lite/readers.ts の純ロジックを tmpdir で検証する（server は起動しない）。
 * 外部プロセス/ネット非依存。outputs パス規約（paths.ts）に沿った構造を作って読む。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRuns,
  readResult,
  readLeaderboard,
  readEvents,
} from "../dashboard-lite/readers.ts";
import type { BenchResult, LeaderboardEntry } from "../orchestrator/types.ts";

/** outputs/{run}/ を最小構成で作るヘルパ。 */
function makeRun(
  outputsDir: string,
  id: string,
  opts: { result?: BenchResult | string; events?: string[] } = {},
): string {
  const dir = join(outputsDir, id);
  mkdirSync(dir, { recursive: true });
  if (opts.result !== undefined) {
    const body = typeof opts.result === "string" ? opts.result : JSON.stringify(opts.result);
    writeFileSync(join(dir, "result.json"), body, "utf8");
  }
  if (opts.events !== undefined) {
    mkdirSync(join(dir, "events"), { recursive: true });
    writeFileSync(join(dir, "events", "pipeline.jsonl"), opts.events.join("\n") + "\n", "utf8");
  }
  return dir;
}

const sampleResult: BenchResult = {
  result_id: "r1",
  strategy_id: "S3-001",
  rubric_ref: "toy-rules",
  eval_mode: "test",
  score: 1,
  rank: 1,
  metrics: { passed_test_ratio: 1 },
  passed_test_ratio: 1,
  threshold: [],
};

describe("dashboard-lite readers (read-only 純ロジック)", () => {
  let outputs: string;

  beforeEach(() => {
    outputs = mkdtempSync(join(tmpdir(), "taikai-dashlite-"));
  });
  afterEach(() => {
    rmSync(outputs, { recursive: true, force: true });
  });

  describe("listRuns", () => {
    it("outputs が無ければ空配列", () => {
      expect(listRuns(join(outputs, "missing"))).toEqual([]);
    });

    it("run dir を列挙し、result/events の有無を反映する", () => {
      makeRun(outputs, "run-a", { result: sampleResult, events: ['{"type":"PipelineStarted"}'] });
      makeRun(outputs, "run-b", {}); // result も events も無い

      const runs = listRuns(outputs);
      const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
      expect(Object.keys(byId).sort()).toEqual(["run-a", "run-b"]);
      expect(byId["run-a"]?.hasResult).toBe(true);
      expect(byId["run-a"]?.hasEvents).toBe(true);
      expect(byId["run-b"]?.hasResult).toBe(false);
      expect(byId["run-b"]?.hasEvents).toBe(false);
    });

    it("ファイル（leaderboard.json / .gitkeep）やドットエントリは除外する", () => {
      makeRun(outputs, "run-a", { result: sampleResult });
      writeFileSync(join(outputs, "leaderboard.json"), "[]", "utf8");
      writeFileSync(join(outputs, ".gitkeep"), "", "utf8");
      mkdirSync(join(outputs, ".taikai"), { recursive: true });

      const ids = listRuns(outputs).map((r) => r.id);
      expect(ids).toEqual(["run-a"]);
    });

    it("mtime の新しい run を先頭にソートする", () => {
      makeRun(outputs, "old-run", { result: sampleResult });
      makeRun(outputs, "new-run", { result: sampleResult });
      // old-run を過去時刻に、new-run を未来寄りにして順序を確定させる
      const past = new Date("2020-01-01T00:00:00Z");
      const future = new Date("2030-01-01T00:00:00Z");
      utimesSync(join(outputs, "old-run"), past, past);
      utimesSync(join(outputs, "new-run"), future, future);

      const ids = listRuns(outputs).map((r) => r.id);
      expect(ids).toEqual(["new-run", "old-run"]);
    });
  });

  describe("readResult", () => {
    it("result.json を BenchResult として読む", () => {
      const dir = makeRun(outputs, "run-a", { result: sampleResult });
      const r = readResult(dir);
      expect(r?.result_id).toBe("r1");
      expect(r?.score).toBe(1);
    });

    it("result.json が無ければ null", () => {
      const dir = makeRun(outputs, "run-a", {});
      expect(readResult(dir)).toBeNull();
    });

    it("壊れた JSON は throw せず null", () => {
      const dir = makeRun(outputs, "run-a", { result: "{not json" });
      expect(readResult(dir)).toBeNull();
    });
  });

  describe("readLeaderboard", () => {
    it("leaderboard.json が無ければ空配列", () => {
      expect(readLeaderboard(outputs)).toEqual([]);
    });

    it("配列をそのまま返す", () => {
      const entries: LeaderboardEntry[] = [
        {
          run_id: "run-a",
          strategy_id: "S3-001",
          rubric_ref: "toy-rules",
          score: 1,
          passed_test_ratio: 1,
          result_ref: "outputs/run-a/result.json",
          ts: "2026-06-11T12:00:00Z",
        },
      ];
      writeFileSync(join(outputs, "leaderboard.json"), JSON.stringify(entries), "utf8");
      const got = readLeaderboard(outputs);
      expect(got).toHaveLength(1);
      expect(got[0]?.run_id).toBe("run-a");
    });

    it("壊れた JSON / 配列でない JSON は空配列に倒す", () => {
      writeFileSync(join(outputs, "leaderboard.json"), "{not json", "utf8");
      expect(readLeaderboard(outputs)).toEqual([]);
      writeFileSync(join(outputs, "leaderboard.json"), '{"a":1}', "utf8");
      expect(readLeaderboard(outputs)).toEqual([]);
    });
  });

  describe("readEvents", () => {
    it("events が無ければ空配列", () => {
      const dir = makeRun(outputs, "run-a", {});
      expect(readEvents(dir)).toEqual([]);
    });

    it("pipeline.jsonl をパースして順序保存する", () => {
      const dir = makeRun(outputs, "run-a", {
        events: [
          '{"type":"PipelineStarted","run_id":"run-a","ts":"2026-06-11T13:00:00Z"}',
          '{"type":"PhaseCompleted","phase":"S3","status":"ok","ts":"2026-06-11T13:01:00Z"}',
        ],
      });
      const evs = readEvents(dir);
      expect(evs.map((e) => e.type)).toEqual(["PipelineStarted", "PhaseCompleted"]);
    });

    it("壊れた行はスキップして読めるものだけ返す", () => {
      const dir = makeRun(outputs, "run-a", {
        events: ['{"type":"PhaseFailed","phase":"S5","error":"E_CODE_TEST","ts":"2026-06-11T13:00:00Z"}'],
      });
      appendFileSync(join(dir, "events", "pipeline.jsonl"), "{partial broken\n", "utf8");
      appendFileSync(
        join(dir, "events", "pipeline.jsonl"),
        '{"type":"PhaseCompleted","phase":"S6","status":"ok","ts":"2026-06-11T13:02:00Z"}\n',
        "utf8",
      );
      const evs = readEvents(dir);
      expect(evs.map((e) => e.type)).toEqual(["PhaseFailed", "PhaseCompleted"]);
    });
  });
});
