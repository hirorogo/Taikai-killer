import { describe, it, expect } from "vitest";
import { partialName } from "../orchestrator/paths.ts";

describe("paths", () => {
  it("partial 命名規約に従う（: を - に正規化）", () => {
    const name = partialName("S5", 0, 1, "2026-06-11T12:00:00Z");
    expect(name).toBe("S5_PARTIAL_W0B1_2026-06-11T12-00-00Z.json");
  });
});
