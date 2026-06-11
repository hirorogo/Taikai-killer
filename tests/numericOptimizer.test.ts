import { describe, it, expect } from "vitest";
import { createRng, optimize } from "../evolution/numericOptimizer.ts";
import type { Params } from "../evolution/numericOptimizer.ts";

describe("createRng", () => {
  it("同一 seed は同一系列（決定的）", () => {
    const a = createRng(42);
    const b = createRng(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("異なる seed は異なる系列", () => {
    const a = createRng(1);
    const b = createRng(2);
    expect(a()).not.toBe(b());
  });

  it("値は [0,1) に収まる", () => {
    const r = createRng(123);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("非有限 seed は 0 として扱い決定的", () => {
    const a = createRng(Number.NaN);
    const b = createRng(0);
    expect(a()).toBe(b());
  });
});

describe("optimize", () => {
  // f(x) = -(x-3)^2 を最大化（最適は x=3、スコア0）。LLM 非依存・純数値。
  const evalQuadratic = async (p: Params): Promise<number> => {
    const x = p["x"] ?? 0;
    return -((x - 3) * (x - 3));
  };

  it("二次関数の頂点へ収束する（max 方向）", async () => {
    const res = await optimize({ x: 0 }, evalQuadratic, {
      iterations: 500,
      seed: 7,
      stepScale: 0.3,
    });
    expect(res.best["x"]).toBeCloseTo(3, 1);
    expect(res.bestScore).toBeGreaterThan(-0.01);
  });

  it("seed 固定で完全再現（best/score/履歴が一致）", async () => {
    const opts = { iterations: 200, seed: 99, stepScale: 0.5 } as const;
    const r1 = await optimize({ x: -5 }, evalQuadratic, opts);
    const r2 = await optimize({ x: -5 }, evalQuadratic, opts);
    expect(r1.best).toEqual(r2.best);
    expect(r1.bestScore).toBe(r2.bestScore);
    expect(r1.history).toEqual(r2.history);
    expect(r1.evaluations).toBe(r2.evaluations);
  });

  it("seed が違えば探索経路が変わる", async () => {
    const base = { iterations: 200, stepScale: 0.5 };
    const a = await optimize({ x: -5 }, evalQuadratic, { ...base, seed: 1 });
    const b = await optimize({ x: -5 }, evalQuadratic, { ...base, seed: 2 });
    expect(a.history).not.toEqual(b.history);
  });

  it("初期パラメータを破壊しない（非破壊）", async () => {
    const p0: Params = { x: 0 };
    await optimize(p0, evalQuadratic, { iterations: 50, seed: 3, stepScale: 0.2 });
    expect(p0).toEqual({ x: 0 });
  });

  it("evaluate 呼び出し回数 = 初期1 + 反復回数（リスタート無し）", async () => {
    let calls = 0;
    const counting = async (p: Params): Promise<number> => {
      calls++;
      const x = p["x"] ?? 0;
      return -(x * x);
    };
    const res = await optimize({ x: 1 }, counting, {
      iterations: 30,
      seed: 5,
      stepScale: 0.1,
    });
    expect(calls).toBe(31);
    expect(res.evaluations).toBe(31);
  });

  it("iterations=0 は初期点をそのまま返す（評価1回のみ）", async () => {
    const res = await optimize({ x: 2 }, evalQuadratic, {
      iterations: 0,
      seed: 1,
      stepScale: 0.1,
    });
    expect(res.best).toEqual({ x: 2 });
    expect(res.evaluations).toBe(1);
    expect(res.history).toEqual([]);
    expect(res.restarts).toBe(0);
  });

  it("多変数を同時に最適化する", async () => {
    // f = -((a-1)^2 + (b+2)^2)、最適 a=1, b=-2。
    const f = async (p: Params): Promise<number> => {
      const a = p["a"] ?? 0;
      const b = p["b"] ?? 0;
      return -((a - 1) * (a - 1) + (b + 2) * (b + 2));
    };
    const res = await optimize({ a: 0, b: 0 }, f, {
      iterations: 800,
      seed: 11,
      stepScale: 0.3,
    });
    expect(res.best["a"]).toBeCloseTo(1, 1);
    expect(res.best["b"]).toBeCloseTo(-2, 1);
  });

  it("restartAfter 指定時はリスタートが発生しうる", async () => {
    // 平坦すぎてすぐ停滞する関数（一点だけ良い）で stall を誘発。
    const spiky = async (p: Params): Promise<number> => {
      const x = p["x"] ?? 0;
      return Math.abs(x - 100) < 0.01 ? 1 : 0;
    };
    const res = await optimize({ x: 0 }, spiky, {
      iterations: 100,
      seed: 4,
      stepScale: 0.5,
      restartAfter: 5,
    });
    expect(res.restarts).toBeGreaterThan(0);
  });
});
