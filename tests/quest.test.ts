import { describe, it, expect } from "vitest";
import { runQuest } from "../orchestrator/quest/runQuest.ts";
import type { QuestAdapter, NumericCandidate } from "../orchestrator/quest/adapter.ts";

/**
 * ダミー数値アダプタ: f(x) = -(x-3)^2 を最大化（最適は x=3、fitness=0）。
 * LLM 非依存・決定的。numericOptimizer 経路（mutateNumeric=true）を通す。
 */
function makeQuadraticAdapter(
  onBuild?: (best: NumericCandidate, dir: string) => void,
): QuestAdapter<NumericCandidate> {
  return {
    questId: "quad-demo",
    paramKeys: ["x"],
    mutateNumeric: true,
    initialCandidate: () => ({ x: 0 }),
    evaluate: async (c) => {
      const x = c["x"] ?? 0;
      return -((x - 3) * (x - 3));
    },
    buildSubmission: (best, dir) => {
      onBuild?.(best, dir);
    },
  };
}

describe("runQuest (numeric)", () => {
  it("ダミー adapter（-(x-3)^2 最大化）で best が 3 近傍に収束する", async () => {
    const res = await runQuest(makeQuadraticAdapter(), {
      seed: 7,
      generations: 500,
      stepScale: 0.3,
    });
    expect(res.best["x"]).toBeCloseTo(3, 1);
    expect(res.bestScore).toBeGreaterThan(-0.01);
  });

  it("seed 固定で完全再現（best/score/評価回数が一致）", async () => {
    const opts = { seed: 99, generations: 200, stepScale: 0.5 } as const;
    const r1 = await runQuest(makeQuadraticAdapter(), opts);
    const r2 = await runQuest(makeQuadraticAdapter(), opts);
    expect(r1.best).toEqual(r2.best);
    expect(r1.bestScore).toBe(r2.bestScore);
    expect(r1.evaluations).toBe(r2.evaluations);
  });

  it("seed が違えば結果が変わる", async () => {
    const base = { generations: 200, stepScale: 0.5 };
    const a = await runQuest(makeQuadraticAdapter(), { ...base, seed: 1 });
    const b = await runQuest(makeQuadraticAdapter(), { ...base, seed: 2 });
    expect(a.best).not.toEqual(b.best);
  });

  it("paramKeys のキーだけを探索し初期値を尊重する", async () => {
    const res = await runQuest(makeQuadraticAdapter(), {
      seed: 3,
      generations: 0, // 初期点のみ評価
    });
    expect(res.best).toEqual({ x: 0 });
    expect(res.evaluations).toBe(1);
  });

  it("evaluations = 初期1 + generations（リスタート無し）", async () => {
    let calls = 0;
    const adapter: QuestAdapter<NumericCandidate> = {
      questId: "count",
      paramKeys: ["x"],
      mutateNumeric: true,
      initialCandidate: () => ({ x: 1 }),
      evaluate: async (c) => {
        calls++;
        const x = c["x"] ?? 0;
        return -(x * x);
      },
      buildSubmission: () => {},
    };
    const res = await runQuest(adapter, { seed: 5, generations: 30, stepScale: 0.1 });
    expect(calls).toBe(31);
    expect(res.evaluations).toBe(31);
  });

  it("多変数を同時に最適化する", async () => {
    // f = -((a-1)^2 + (b+2)^2)、最適 a=1, b=-2。
    const adapter: QuestAdapter<NumericCandidate> = {
      questId: "multi",
      paramKeys: ["a", "b"],
      mutateNumeric: true,
      initialCandidate: () => ({ a: 0, b: 0 }),
      evaluate: async (c) => {
        const a = c["a"] ?? 0;
        const b = c["b"] ?? 0;
        return -((a - 1) * (a - 1) + (b + 2) * (b + 2));
      },
      buildSubmission: () => {},
    };
    const res = await runQuest(adapter, { seed: 11, generations: 800, stepScale: 0.3 });
    expect(res.best["a"]).toBeCloseTo(1, 1);
    expect(res.best["b"]).toBeCloseTo(-2, 1);
  });
});

describe("runQuest submission", () => {
  it("submissionDir 指定時に buildSubmission を最良候補で呼ぶ", async () => {
    let captured: { best: NumericCandidate; dir: string } | null = null;
    const adapter = makeQuadraticAdapter((best, dir) => {
      captured = { best, dir };
    });
    const res = await runQuest(adapter, {
      seed: 7,
      generations: 300,
      stepScale: 0.3,
      submissionDir: "/tmp/quest-out",
    });
    expect(res.submitted).toBe(true);
    expect(captured).not.toBeNull();
    const cap = captured as unknown as { best: NumericCandidate; dir: string };
    expect(cap.dir).toBe("/tmp/quest-out");
    // buildSubmission に渡る best は runQuest が返す best と一致する。
    expect(cap.best).toEqual(res.best);
  });

  it("submissionDir 未指定なら buildSubmission を呼ばない", async () => {
    let called = false;
    const adapter = makeQuadraticAdapter(() => {
      called = true;
    });
    const res = await runQuest(adapter, { seed: 7, generations: 50 });
    expect(called).toBe(false);
    expect(res.submitted).toBe(false);
  });
});

describe("runQuest (generic / non-numeric)", () => {
  it("mutateNumeric 未指定なら初期候補を評価して返す（外形を保つ）", async () => {
    interface StrCand {
      label: string;
    }
    const adapter: QuestAdapter<StrCand> = {
      questId: "generic",
      initialCandidate: () => ({ label: "seed" }),
      evaluate: async (c) => c.label.length,
      buildSubmission: () => {},
    };
    const res = await runQuest(adapter, { seed: 1, generations: 100 });
    expect(res.best).toEqual({ label: "seed" });
    expect(res.bestScore).toBe(4);
    expect(res.evaluations).toBe(1);
  });
});
