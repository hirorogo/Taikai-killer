import { describe, it, expect } from "vitest";
import { loadSchemas, validate, assertValid, runSelfcheck } from "../orchestrator/schemas.ts";
import type {
  Provenance,
  TournamentInfo,
  ScoringRubric,
  Strategy,
  CodeAttempt,
  CodegenResult,
  BenchResult,
  LeaderboardEntry,
  ProjectManifest,
} from "../orchestrator/types.ts";

const provenance: Provenance = {
  produced_by: "S3",
  derived_from: ["rubric:r1"],
  timestamp: "2026-06-11T12:00:00Z",
};

describe("schemas: loadSchemas", () => {
  it("二重ロードしても落ちない（冪等）", () => {
    expect(() => {
      loadSchemas();
      loadSchemas();
    }).not.toThrow();
  });
});

describe("schemas: 正常系（types.ts 準拠の最小サンプルは全て valid）", () => {
  it("Provenance", () => {
    expect(validate("Provenance", provenance).valid).toBe(true);
  });

  it("TournamentInfo", () => {
    const ti: TournamentInfo = {
      name: "demo",
      language: "python",
      run_cmd: "python src/main.py",
      test_cmd: "pytest -q",
      test_source: "provided",
      submission: { format: "zip" },
    };
    expect(validate("TournamentInfo", ti).valid).toBe(true);
  });

  it("ScoringRubric", () => {
    const r: ScoringRubric = {
      eval_mode: "test",
      metrics: [{ name: "passed_test_ratio", weight: 1, direction: "max" }],
      forbidden: [],
      derived_from: "tournament:demo",
    };
    expect(validate("ScoringRubric", r).valid).toBe(true);
  });

  it("Strategy", () => {
    const s: Strategy = { id: "strat0", origin: "requirement", approach: "greedy" };
    expect(validate("Strategy", s).valid).toBe(true);
  });

  it("CodeAttempt", () => {
    const a: CodeAttempt = {
      attempt: 1,
      code_ref: "src/main.py",
      passed_anchor_ids: [],
      newly_passed_ids: ["all"],
      regressed: false,
    };
    expect(validate("CodeAttempt", a).valid).toBe(true);
  });

  it("CodegenResult", () => {
    const c: CodegenResult = {
      strategy_id: "strat0",
      passed: true,
      attempts: 1,
      feedbackHistory: ["PASS"],
    };
    expect(validate("CodegenResult", c).valid).toBe(true);
  });

  it("BenchResult", () => {
    const b: BenchResult = {
      result_id: "run-1",
      strategy_id: "strat0",
      rubric_ref: "tournament:demo",
      eval_mode: "test",
      score: 1,
      rank: 1,
      metrics: { passed_test_ratio: 1 },
      passed_test_ratio: 1,
      threshold: [],
    };
    expect(validate("BenchResult", b).valid).toBe(true);
  });

  it("LeaderboardEntry", () => {
    const l: LeaderboardEntry = {
      run_id: "run-1",
      strategy_id: "strat0",
      rubric_ref: "tournament:demo",
      score: 1,
      passed_test_ratio: 1,
      result_ref: "outputs/run-1/result.json",
      ts: "2026-06-11T12:00:00Z",
    };
    expect(validate("LeaderboardEntry", l).valid).toBe(true);
  });

  it("ProjectManifest", () => {
    const m: ProjectManifest = {
      language: "python",
      entrypoint: "src/main.py",
      run_cmd: "python src/main.py",
      test_cmd: "pytest -q",
      timeout_ms: 60000,
    };
    expect(validate("ProjectManifest", m).valid).toBe(true);
  });

  it("PhaseArtifact（payload は任意型）", () => {
    const art = {
      id: "S3:0.0",
      phase: "S3",
      worker: 0,
      batch: 0,
      timestamp: "2026-06-11T12:00:00Z",
      schema_version: "0",
      status: "ok",
      provenance,
      payload: { whatever: 1 },
    };
    expect(validate("PhaseArtifact", art).valid).toBe(true);
  });
});

describe("schemas: 異常系（不一致は弾き、詳細エラーを返す）", () => {
  it("必須欠落を拒否する", () => {
    const r = validate("TournamentInfo", { name: "broken" });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.message).toContain("TournamentInfo");
  });

  it("enum 外の値を拒否する", () => {
    const r = validate("Strategy", { id: "x", origin: "bogus_origin", approach: "y" });
    expect(r.valid).toBe(false);
  });

  it("additionalProperties を拒否する（型の取りこぼし検出）", () => {
    const r = validate("ProjectManifest", {
      language: "python",
      entrypoint: "src/main.py",
      run_cmd: "r",
      test_cmd: "t",
      timeout_ms: 1,
      extra_unknown: true,
    });
    expect(r.valid).toBe(false);
  });

  it("型違いを拒否する（worker は number）", () => {
    const r = validate("PhaseArtifact", {
      id: "x",
      phase: "S3",
      worker: "zero",
      batch: 0,
      timestamp: "t",
      schema_version: "0",
      status: "ok",
      provenance,
      payload: {},
    });
    expect(r.valid).toBe(false);
  });

  it("未知のスキーマ名は valid=false を返す", () => {
    // @ts-expect-error 故意に未知名を渡す
    const r = validate("Nope", {});
    expect(r.valid).toBe(false);
  });
});

describe("schemas: assertValid", () => {
  it("不正データで throw する", () => {
    expect(() => assertValid("Strategy", { id: "x" })).toThrow();
  });
  it("正常データでは throw しない", () => {
    expect(() =>
      assertValid("Strategy", { id: "x", origin: "subject", approach: "z" }),
    ).not.toThrow();
  });
});

describe("schemas: runSelfcheck", () => {
  it("同梱サンプルは全て通り true を返す", () => {
    expect(runSelfcheck()).toBe(true);
  });
});
