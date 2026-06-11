import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { partialsDir, partialName } from "../orchestrator/paths.ts";
import { scanCompleted, isDone } from "../orchestrator/resume.ts";
import type { PhaseArtifact } from "../orchestrator/types.ts";

/** 指定 {phase,worker,batch,status} の partial を runDir に書く小道具。 */
function writePartial(
  runDir: string,
  phase: string,
  worker: number,
  batch: number,
  status: PhaseArtifact<unknown>["status"],
  iso: string,
): void {
  const art: PhaseArtifact<unknown> = {
    id: `${phase}:${worker}.${batch}`,
    phase,
    worker,
    batch,
    timestamp: iso,
    schema_version: "0",
    status,
    provenance: { produced_by: phase, derived_from: [], timestamp: iso },
    payload: {},
  };
  writeFileSync(
    join(partialsDir(runDir), partialName(phase, worker, batch, iso)),
    JSON.stringify(art),
    "utf8",
  );
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "taikai-resume-"));
  mkdirSync(partialsDir(runDir), { recursive: true });
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("scanCompleted", () => {
  it("partials が無ければ空配列（初回起動）", () => {
    rmSync(partialsDir(runDir), { recursive: true, force: true });
    expect(scanCompleted(runDir, "S5")).toEqual([]);
  });

  it("status ok/partial を完了として返し、worker→batch 昇順", () => {
    writePartial(runDir, "S5", 0, 1, "ok", "2026-06-11T12:00:00Z");
    writePartial(runDir, "S5", 1, 0, "partial", "2026-06-11T12:00:01Z");
    writePartial(runDir, "S5", 0, 0, "ok", "2026-06-11T12:00:02Z");

    const got = scanCompleted(runDir, "S5");
    expect(got.map((c) => [c.worker, c.batch])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
    expect(got[0]!.id).toBe("S5:0.0");
  });

  it("status error は未完扱いで除外（次起動で再試行可能に）", () => {
    writePartial(runDir, "S5", 0, 0, "error", "2026-06-11T12:00:00Z");
    expect(scanCompleted(runDir, "S5")).toEqual([]);
  });

  it("同一 {worker,batch} が error→ok と複数あれば完了に昇格", () => {
    writePartial(runDir, "S5", 0, 0, "error", "2026-06-11T12:00:00Z");
    writePartial(runDir, "S5", 0, 0, "ok", "2026-06-11T12:00:05Z");

    const got = scanCompleted(runDir, "S5");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ worker: 0, batch: 0 });
  });

  it("phase が違う partial は無視（完全一致ガード）", () => {
    writePartial(runDir, "S3", 0, 0, "ok", "2026-06-11T12:00:00Z");
    writePartial(runDir, "S5", 0, 0, "ok", "2026-06-11T12:00:01Z");

    expect(scanCompleted(runDir, "S5")).toHaveLength(1);
    expect(scanCompleted(runDir, "S3")).toHaveLength(1);
  });

  it("壊れた JSON の partial は未完扱い（取りこぼし防止）", () => {
    writeFileSync(
      join(partialsDir(runDir), partialName("S5", 0, 0, "2026-06-11T12:00:00Z")),
      "{ this is not json",
      "utf8",
    );
    expect(scanCompleted(runDir, "S5")).toEqual([]);
  });

  it("partial 命名規約外のファイルは無視", () => {
    writeFileSync(join(partialsDir(runDir), "README.txt"), "noise", "utf8");
    writeFileSync(join(partialsDir(runDir), "S5_QUEUE_W0.json"), "{}", "utf8");
    expect(scanCompleted(runDir, "S5")).toEqual([]);
  });
});

describe("isDone", () => {
  it("完了済み {worker,batch} に true", () => {
    writePartial(runDir, "S5", 2, 3, "ok", "2026-06-11T12:00:00Z");
    expect(isDone(runDir, "S5", 2, 3)).toBe(true);
  });

  it("未完/error/別キーには false", () => {
    writePartial(runDir, "S5", 0, 0, "error", "2026-06-11T12:00:00Z");
    expect(isDone(runDir, "S5", 0, 0)).toBe(false);
    expect(isDone(runDir, "S5", 9, 9)).toBe(false);
  });
});
