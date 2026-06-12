import { describe, it, expect } from "vitest";
import { populationGA } from "../orchestrator/quest/populationGA.ts";
import type { GACandidate } from "../orchestrator/quest/populationGA.ts";

/**
 * ダミー評価器: f(x) = -(x-3)^2 を最大化（最適は x=3、fitness=0）。
 * LLM 非依存・決定的（Date.now / Math.random に触れない）。
 */
const evalQuadratic = async (c: GACandidate): Promise<number> => {
  const x = c["x"] ?? 0;
  return -((x - 3) * (x - 3));
};

describe("populationGA", () => {
  it("(x-3)^2 最小化ダミーで best が 3 近傍に収束する（max 方向）", async () => {
    const res = await populationGA(evalQuadratic, {
      seed: 7,
      generations: 40,
      popSize: 20,
      initial: { x: 0 },
    });
    expect(res.best["x"]).toBeCloseTo(3, 1);
    expect(res.bestScore).toBeGreaterThan(-0.01);
  });

  it("seed 固定で完全再現（best/score/history が一致）", async () => {
    const opts = {
      seed: 99,
      generations: 25,
      popSize: 16,
      initial: { x: -5 },
    } as const;
    const r1 = await populationGA(evalQuadratic, opts);
    const r2 = await populationGA(evalQuadratic, opts);
    expect(r1.best).toEqual(r2.best);
    expect(r1.bestScore).toBe(r2.bestScore);
    expect(r1.history).toEqual(r2.history);
    expect(r1.evaluations).toBe(r2.evaluations);
  });

  it("seed が違えば探索経路が変わる", async () => {
    const base = { generations: 25, popSize: 16, initial: { x: -5 } };
    const a = await populationGA(evalQuadratic, { ...base, seed: 1 });
    const b = await populationGA(evalQuadratic, { ...base, seed: 2 });
    expect(a.history).not.toEqual(b.history);
  });

  it("評価回数 = popSize × (generations + 1)（実呼び出しと一致）", async () => {
    let calls = 0;
    const counting = async (c: GACandidate): Promise<number> => {
      calls++;
      const x = c["x"] ?? 0;
      return -(x * x);
    };
    const popSize = 12;
    const generations = 7;
    const res = await populationGA(counting, {
      seed: 5,
      generations,
      popSize,
      initial: { x: 1 },
    });
    const expected = popSize * (generations + 1);
    expect(calls).toBe(expected);
    expect(res.evaluations).toBe(expected);
  });

  it("popSize / generations を変えると評価回数の公式が成り立つ", async () => {
    const r1 = await populationGA(evalQuadratic, {
      seed: 3,
      generations: 5,
      popSize: 10,
      initial: { x: 0 },
    });
    const r2 = await populationGA(evalQuadratic, {
      seed: 3,
      generations: 10,
      popSize: 8,
      initial: { x: 0 },
    });
    expect(r1.evaluations).toBe(10 * (5 + 1));
    expect(r2.evaluations).toBe(8 * (10 + 1));
  });

  it("generations=0 は初期個体群のみ評価して最良を返す", async () => {
    const res = await populationGA(evalQuadratic, {
      seed: 1,
      generations: 0,
      popSize: 6,
      initial: { x: 2 },
    });
    expect(res.evaluations).toBe(6);
    expect(res.history).toHaveLength(1);
    expect(res.history[0]?.generation).toBe(0);
    // 初期個体群には initial（x=2）が必ず含まれるので best はそれ以上に良い。
    // f(2) = -1 なので bestScore >= -1。
    expect(res.bestScore).toBeGreaterThanOrEqual(-1);
  });

  it("初期パラメータを破壊しない（非破壊）", async () => {
    const initial: GACandidate = { x: 0 };
    await populationGA(evalQuadratic, {
      seed: 3,
      generations: 5,
      popSize: 8,
      initial,
    });
    expect(initial).toEqual({ x: 0 });
  });

  it("多変数を同時に最適化する（交叉が複数キーに効く）", async () => {
    // f = -((a-1)^2 + (b+2)^2)、最適 a=1, b=-2。
    const f = async (c: GACandidate): Promise<number> => {
      const a = c["a"] ?? 0;
      const b = c["b"] ?? 0;
      return -((a - 1) * (a - 1) + (b + 2) * (b + 2));
    };
    const res = await populationGA(f, {
      seed: 11,
      generations: 60,
      popSize: 24,
      initial: { a: 0, b: 0 },
    });
    expect(res.best["a"]).toBeCloseTo(1, 1);
    expect(res.best["b"]).toBeCloseTo(-2, 1);
  });

  it("エリート保存で best スコアは世代をまたいで単調非減少", async () => {
    const res = await populationGA(evalQuadratic, {
      seed: 13,
      generations: 30,
      popSize: 20,
      initial: { x: -8 },
      eliteFrac: 0.25,
    });
    for (let i = 1; i < res.history.length; i++) {
      const prev = res.history[i - 1]?.bestScore ?? -Infinity;
      const cur = res.history[i]?.bestScore ?? -Infinity;
      expect(cur).toBeGreaterThanOrEqual(prev);
    }
  });

  it("popSize=1 でも動く（個体群退化のフォールバック）", async () => {
    const res = await populationGA(evalQuadratic, {
      seed: 2,
      generations: 5,
      popSize: 1,
      initial: { x: 0 },
    });
    expect(res.evaluations).toBe(1 * (5 + 1));
    expect(Number.isFinite(res.bestScore)).toBe(true);
  });

  it("ヒルクライムが苦手な多峰関数でも大域最適へ届く（GA の強み）", async () => {
    // 二重井戸: x=1.5 が大域最適(0)、x=-1.5 が局所最適(-0.5)。
    // 局所最適の谷から開始しても、個体群の多様性＋ガウス突然変異で大域側へ抜ける。
    const multimodal = async (c: GACandidate): Promise<number> => {
      const x = c["x"] ?? 0;
      const well1 = -((x - 1.5) * (x - 1.5));
      const well2 = -((x + 1.5) * (x + 1.5)) - 0.5;
      return Math.max(well1, well2);
    };
    const res = await populationGA(multimodal, {
      seed: 21,
      generations: 80,
      popSize: 40,
      initial: { x: -1.5 }, // 局所最適の谷から開始
      mutationScale: 1.0,
    });
    // 大域最適 x=1.5（スコア 0 近傍）に到達できる＝局所解 -0.5 を脱出した。
    expect(res.best["x"]).toBeCloseTo(1.5, 1);
    expect(res.bestScore).toBeGreaterThan(-0.1);
  });
});
