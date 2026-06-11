import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEvent,
  readEvents,
  pipelineLogPath,
  pipelineStarted,
  phaseStarted,
  phaseCompleted,
  phaseFailed,
  circuitBreakerTripped,
  budgetExceeded,
} from "../orchestrator/events.ts";
import { eventsDir } from "../orchestrator/paths.ts";
import { CB } from "../orchestrator/config.ts";

describe("events (append-only / D9)", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "taikai-events-"));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("events/pipeline.jsonl に書き、events ディレクトリを自動生成する", () => {
    expect(existsSync(eventsDir(runDir))).toBe(false);
    const ev = pipelineStarted(runDir, "run-abc");
    expect(existsSync(pipelineLogPath(runDir))).toBe(true);
    expect(ev.type).toBe("PipelineStarted");
    if (ev.type === "PipelineStarted") expect(ev.run_id).toBe("run-abc");
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO8601 注入
  });

  it("純追記: 1イベント=1行 JSON で順序保存される", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    appendEvent(runDir, { type: "PhaseStarted", phase: "S1" });
    appendEvent(runDir, { type: "PhaseCompleted", phase: "S1", status: "ok" });

    const raw = readFileSync(pipelineLogPath(runDir), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(3);
    // 各行が独立した有効 JSON（jsonl 契約）
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("readEvents は監査用に追記順で読み戻す", () => {
    pipelineStarted(runDir, "r1");
    phaseStarted(runDir, "S3", { worker: 0, batch: 2 });
    phaseCompleted(runDir, "S3", "partial", { worker: 0, batch: 2 });

    const evs = readEvents(runDir);
    expect(evs.map((e) => e.type)).toEqual([
      "PipelineStarted",
      "PhaseStarted",
      "PhaseCompleted",
    ]);
    const started = evs[1];
    expect(started?.type).toBe("PhaseStarted");
    if (started?.type === "PhaseStarted") {
      expect(started.phase).toBe("S3");
      expect(started.worker).toBe(0);
      expect(started.batch).toBe(2);
    }
  });

  it("ログ未作成なら readEvents は空配列", () => {
    expect(readEvents(runDir)).toEqual([]);
  });

  it("壊れた行はスキップして読めるものだけ返す（監査の頑健性）", () => {
    appendEvent(runDir, { type: "PhaseFailed", phase: "S5", error: "E_CODE_TEST" });
    // 部分書き込み相当の壊れた行を直接足す
    appendFileSync(pipelineLogPath(runDir), "{not valid json\n", "utf8");
    appendEvent(runDir, { type: "PhaseCompleted", phase: "S6", status: "ok" });

    const evs = readEvents(runDir);
    expect(evs.length).toBe(2);
    expect(evs.map((e) => e.type)).toEqual(["PhaseFailed", "PhaseCompleted"]);
  });

  it("meta 未指定なら worker/batch を欠落させる（exactOptionalPropertyTypes）", () => {
    phaseStarted(runDir, "S1");
    const ev = readEvents(runDir)[0];
    expect(ev?.type).toBe("PhaseStarted");
    if (ev?.type === "PhaseStarted") {
      expect("worker" in ev).toBe(false);
      expect("batch" in ev).toBe(false);
    }
  });

  it("phaseFailed は error 分類コードを保持する", () => {
    phaseFailed(runDir, "S3", "E_LLM_COMM");
    const ev = readEvents(runDir)[0];
    expect(ev?.type).toBe("PhaseFailed");
    if (ev?.type === "PhaseFailed") {
      expect(ev.phase).toBe("S3");
      expect(ev.error).toBe("E_LLM_COMM");
    }
  });

  it("CircuitBreakerTripped は reason から CB 閾値(5/20/3)を解決する", () => {
    circuitBreakerTripped(runDir, "consecutive_failures", 5);
    circuitBreakerTripped(runDir, "total_retries", 20);
    circuitBreakerTripped(runDir, "consecutive_empty_results", 3);

    const evs = readEvents(runDir);
    const thresholds = evs.map((e) =>
      e.type === "CircuitBreakerTripped" ? e.threshold : -1,
    );
    expect(thresholds).toEqual([
      CB.consecutiveFailures,
      CB.totalRetries,
      CB.consecutiveEmptyResults,
    ]);
    expect(thresholds).toEqual([5, 20, 3]);
  });

  it("BudgetExceeded は budget_usd / spent_usd を保持する（D5 指定時のみ）", () => {
    budgetExceeded(runDir, 10, 12.5);
    const ev = readEvents(runDir)[0];
    expect(ev?.type).toBe("BudgetExceeded");
    if (ev?.type === "BudgetExceeded") {
      expect(ev.budget_usd).toBe(10);
      expect(ev.spent_usd).toBe(12.5);
    }
  });
});
