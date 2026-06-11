import { describe, it, expect } from "vitest";
import {
  validateArtifact,
  validateOrThrow,
  formatFieldErrors,
} from "../orchestrator/validate.ts";
import { validate } from "../orchestrator/schemas.ts";
import type {
  TournamentInfo,
  ScoringRubric,
  Strategy,
  ProjectManifest,
  CodegenResult,
} from "../orchestrator/types.ts";

// ───────── 正常系 ─────────

describe("validateArtifact: 正常系（types.ts 準拠の最小サンプル）", () => {
  it("TournamentInfo は valid", () => {
    const ti: TournamentInfo = {
      name: "demo",
      language: "python",
      run_cmd: "python src/main.py",
      test_cmd: "pytest -q",
      test_source: "provided",
      submission: { format: "zip" },
    };
    const r = validateArtifact("TournamentInfo", ti);
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("ScoringRubric は valid", () => {
    const sr: ScoringRubric = {
      eval_mode: "test",
      metrics: [{ name: "passed_test_ratio", weight: 1, direction: "max" }],
      forbidden: [],
      derived_from: "tournament:demo",
    };
    expect(validateArtifact("ScoringRubric", sr).valid).toBe(true);
  });

  it("Strategy は valid", () => {
    const s: Strategy = { id: "strat0", origin: "requirement", approach: "greedy" };
    expect(validateArtifact("Strategy", s).valid).toBe(true);
  });
});

// ───────── 異常系: 必須欠落 ─────────

describe("validateArtifact: 異常系（必須欠落）", () => {
  it("必須欠落を拒否し、どのフィールドが欠落か message に出す", () => {
    const r = validateArtifact("TournamentInfo", { name: "broken" });
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    // 型名と「必須」「欠落」した実フィールド名が読み取れる
    expect(r.message).toContain("TournamentInfo");
    expect(r.message).toContain("必須フィールド欠落");
    expect(r.message).toContain("language");
  });

  it("CodegenResult の必須欠落（strategy_id 等）を拒否する", () => {
    const r = validateArtifact("CodegenResult", { passed: true } as Partial<CodegenResult>);
    expect(r.valid).toBe(false);
    expect(r.message).toContain("strategy_id");
  });
});

// ───────── 異常系: enum 外 ─────────

describe("validateArtifact: 異常系（enum 外）", () => {
  it("enum 外の origin を拒否し、許容値を message に併記する", () => {
    const r = validateArtifact("Strategy", {
      id: "x",
      origin: "bogus_origin",
      approach: "y",
    });
    expect(r.valid).toBe(false);
    expect(r.message).toContain("許容値外");
    // 正しい enum 値の一例が併記される
    expect(r.message).toContain("requirement");
  });

  it("TournamentInfo の language enum 外を拒否する", () => {
    const r = validateArtifact("TournamentInfo", {
      name: "demo",
      language: "rust",
      run_cmd: "r",
      test_cmd: "t",
      test_source: "provided",
      submission: { format: "zip" },
    });
    expect(r.valid).toBe(false);
  });
});

// ───────── 異常系: 未知フィールド / 型違い ─────────

describe("validateArtifact: 異常系（未知フィールド・型違い）", () => {
  it("additionalProperties を拒否し、どのフィールドが未知か出す", () => {
    const bad: ProjectManifest & { extra_unknown: boolean } = {
      language: "python",
      entrypoint: "src/main.py",
      run_cmd: "r",
      test_cmd: "t",
      timeout_ms: 1,
      extra_unknown: true,
    };
    const r = validateArtifact("ProjectManifest", bad);
    expect(r.valid).toBe(false);
    expect(r.message).toContain("未知のフィールド");
    expect(r.message).toContain("extra_unknown");
  });

  it("未知のスキーマ名は valid=false（schemas.ts に委譲）", () => {
    // @ts-expect-error 故意に未知名を渡す
    const r = validateArtifact("Nope", {});
    expect(r.valid).toBe(false);
  });
});

// ───────── validateOrThrow ─────────

describe("validateOrThrow", () => {
  it("正常データは throw せず payload を絞り込んで返す", () => {
    const s: Strategy = { id: "x", origin: "subject", approach: "z" };
    const got = validateOrThrow("Strategy", s);
    expect(got).toBe(s);
    expect(got.origin).toBe("subject");
  });

  it("不正データは TypeError を投げ、message にフィールド情報を含む", () => {
    expect(() => validateOrThrow("Strategy", { id: "x" })).toThrow(TypeError);
    try {
      validateOrThrow("Strategy", { id: "x" });
    } catch (e) {
      expect((e as Error).message).toContain("Strategy");
      expect((e as Error).message).toContain("必須フィールド欠落");
    }
  });
});

// ───────── 整形ヘルパ / schemas.ts 委譲の一貫性 ─────────

describe("formatFieldErrors", () => {
  it("ajv エラーを重複なくフィールド単位に整形する", () => {
    const r = validate("TournamentInfo", { name: "broken" });
    const lines = formatFieldErrors(r.errors);
    expect(lines.length).toBeGreaterThan(0);
    // 重複していない
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("空配列は空を返す", () => {
    expect(formatFieldErrors([])).toEqual([]);
  });
});

describe("validate へ正しく委譲している", () => {
  it("validateArtifact の valid 判定は schemas.validate と一致する", () => {
    const s: Strategy = { id: "x", origin: "requirement", approach: "y" };
    expect(validateArtifact("Strategy", s).valid).toBe(validate("Strategy", s).valid);
    const bad = { id: "x" };
    expect(validateArtifact("Strategy", bad).valid).toBe(validate("Strategy", bad).valid);
  });
});
