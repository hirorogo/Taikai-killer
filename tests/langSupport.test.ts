import { describe, it, expect } from "vitest";
import { langProfile, SUPPORTED_LANGUAGES } from "../orchestrator/langSupport.ts";
import type { LangProfile } from "../orchestrator/langSupport.ts";
import type { TargetLanguage } from "../orchestrator/types.ts";

describe("langProfile: 3言語の entrypoint", () => {
  it("python → src/main.py", () => {
    expect(langProfile("python").entrypoint).toBe("src/main.py");
  });
  it("node → src/main.js", () => {
    expect(langProfile("node").entrypoint).toBe("src/main.js");
  });
  it("ts → src/main.ts", () => {
    expect(langProfile("ts").entrypoint).toBe("src/main.ts");
  });
});

describe("langProfile: defaultRunCmd は entrypoint を含む", () => {
  it("python", () => {
    expect(langProfile("python").defaultRunCmd).toBe("python src/main.py");
  });
  it("node", () => {
    expect(langProfile("node").defaultRunCmd).toBe("node src/main.js");
  });
  it("ts", () => {
    expect(langProfile("ts").defaultRunCmd).toBe("npx tsx src/main.ts");
  });
});

describe("langProfile: defaultTestCmdHint は各言語のテスト最小例", () => {
  it("node: node tests/test.js", () => {
    expect(langProfile("node").defaultTestCmdHint).toBe("node tests/test.js");
  });
  it("ts: npx tsx tests/test.ts", () => {
    expect(langProfile("ts").defaultTestCmdHint).toBe("npx tsx tests/test.ts");
  });
  it("python: python tests/test.py", () => {
    expect(langProfile("python").defaultTestCmdHint).toBe("python tests/test.py");
  });
});

describe("langProfile: fenceHint（コードフェンス言語名）", () => {
  it("python → python", () => {
    expect(langProfile("python").fenceHint).toBe("python");
  });
  it("node → js", () => {
    expect(langProfile("node").fenceHint).toBe("js");
  });
  it("ts → ts", () => {
    expect(langProfile("ts").fenceHint).toBe("ts");
  });
});

describe("langProfile: 不変性・自己整合", () => {
  it("language フィールドは入力 language と一致", () => {
    for (const lang of ["python", "node", "ts"] as const) {
      expect(langProfile(lang).language).toBe(lang);
    }
  });

  it("返り値はコピー（破壊しても次回呼び出しに影響しない）", () => {
    const p1 = langProfile("python");
    p1.entrypoint = "hacked";
    const p2 = langProfile("python");
    expect(p2.entrypoint).toBe("src/main.py");
  });

  it("全フィールドが非空文字列", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const p: LangProfile = langProfile(lang);
      expect(p.entrypoint.length).toBeGreaterThan(0);
      expect(p.defaultRunCmd.length).toBeGreaterThan(0);
      expect(p.defaultTestCmdHint.length).toBeGreaterThan(0);
      expect(p.fenceHint.length).toBeGreaterThan(0);
    }
  });
});

describe("SUPPORTED_LANGUAGES", () => {
  it("3言語ちょうど（python/node/ts）", () => {
    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(["node", "python", "ts"]);
  });

  it("各 entrypoint は互いに異なる", () => {
    const eps = SUPPORTED_LANGUAGES.map((l) => langProfile(l).entrypoint);
    expect(new Set(eps).size).toBe(eps.length);
  });
});

describe("langProfile: 未知言語は決定的に失敗（no hardcoded defaults）", () => {
  it("サポート外は throw", () => {
    expect(() => langProfile("ruby" as unknown as TargetLanguage)).toThrow(/unsupported/);
  });
});
