import { describe, it, expect } from "vitest";
import { createRng } from "../evolution/numericOptimizer.ts";
import {
  makeJankenPlayer,
  normalizeWeights,
  judge,
  MOVES,
} from "../evolution/jankenStrategy.ts";
import type { JankenParams, Move, Outcome } from "../evolution/jankenStrategy.ts";
import {
  evolveJanken,
  overallWinRate,
  matchWinRate,
} from "../evolution/jankenEvolve.ts";
import type { JankenOpponent } from "../evolution/jankenEvolve.ts";
import { jankenCompare } from "../orchestrator/battle.ts";

const uniform: JankenParams = { rock: 1, paper: 1, scissors: 1 };

describe("normalizeWeights", () => {
  it("正の重みを合計1の分布に正規化する", () => {
    const d = normalizeWeights({ rock: 1, paper: 1, scissors: 2 });
    expect(d.rock + d.paper + d.scissors).toBeCloseTo(1, 10);
    expect(d.scissors).toBeCloseTo(0.5, 10);
  });

  it("負・非有限は 0 に丸める", () => {
    const d = normalizeWeights({ rock: -5, paper: Number.NaN, scissors: 3 });
    expect(d.rock).toBe(0);
    expect(d.paper).toBe(0);
    expect(d.scissors).toBe(1);
  });

  it("全 0 は一様分布にフォールバック（必ず合法）", () => {
    const d = normalizeWeights({ rock: 0, paper: 0, scissors: 0 });
    expect(d.rock).toBeCloseTo(1 / 3, 10);
    expect(d.paper).toBeCloseTo(1 / 3, 10);
    expect(d.scissors).toBeCloseTo(1 / 3, 10);
  });
});

describe("judge", () => {
  it("じゃんけんの勝敗（player 視点）", () => {
    expect(judge("rock", "scissors")).toBe("win");
    expect(judge("paper", "rock")).toBe("win");
    expect(judge("scissors", "paper")).toBe("win");
    expect(judge("rock", "paper")).toBe("loss");
    expect(judge("rock", "rock")).toBe("draw");
  });

  it("battle.ts の jankenCompare と全 9 組で一致する（優劣表の二重メンテ防止）", () => {
    // judge は jankenCompare の薄いアダプタ。表が食い違わないことを全組合せで保証する。
    for (const a of MOVES) {
      for (const b of MOVES) {
        const cmp = jankenCompare(a, b); // "a" | "b" | "draw"（第1引数視点）
        const expected: Outcome =
          cmp === "draw" ? "draw" : cmp === "a" ? "win" : "loss";
        expect(judge(a, b)).toBe(expected);
      }
    }
  });
});

describe("makeJankenPlayer", () => {
  it("確率 1 の手だけを出す（決定的偏重）", () => {
    const player = makeJankenPlayer({ rock: 0, paper: 1, scissors: 0 }, createRng(1));
    for (let i = 0; i < 50; i++) {
      expect(player()).toBe<Move>("paper");
    }
  });

  it("同一 seed の rng で同一の手の列（再現性）", () => {
    const params: JankenParams = { rock: 1, paper: 2, scissors: 1 };
    const a = makeJankenPlayer(params, createRng(123));
    const b = makeJankenPlayer(params, createRng(123));
    const seqA: Move[] = [];
    const seqB: Move[] = [];
    for (let i = 0; i < 30; i++) {
      seqA.push(a());
      seqB.push(b());
    }
    expect(seqA).toEqual(seqB);
  });

  it("合法な手しか返さない（負・全0でも安全）", () => {
    const player = makeJankenPlayer({ rock: -1, paper: 0, scissors: 0 }, createRng(9));
    for (let i = 0; i < 100; i++) {
      expect(MOVES).toContain(player());
    }
  });
});

describe("matchWinRate / overallWinRate", () => {
  it("グー固定相手にはパー固定戦略がほぼ全勝（win_rate≈1）", () => {
    const rockBot: JankenParams = { rock: 1, paper: 0, scissors: 0 };
    const paperBot: JankenParams = { rock: 0, paper: 1, scissors: 0 };
    const wr = matchWinRate(paperBot, rockBot, 300, 42);
    expect(wr).toBe(1);
  });

  it("同一戦略同士はおよそ五分（win_rate≈0.5）", () => {
    const wr = matchWinRate(uniform, uniform, 2000, 7);
    expect(wr).toBeGreaterThan(0.4);
    expect(wr).toBeLessThan(0.6);
  });

  it("seed 固定で overallWinRate が再現する", () => {
    const opps: JankenOpponent[] = [
      { id: "rock", params: { rock: 5, paper: 1, scissors: 1 } },
      { id: "scissors", params: { rock: 1, paper: 1, scissors: 5 } },
    ];
    const a = overallWinRate(uniform, opps, 200, 100);
    const b = overallWinRate(uniform, opps, 200, 100);
    expect(a).toBe(b);
  });

  it("相手が空なら勝率 0", () => {
    expect(overallWinRate(uniform, [], 100, 1)).toBe(0);
  });
});

describe("evolveJanken (D18 ① 数値最適化, LLM 非依存)", () => {
  // グー偏重の相手群。最適応答は「パー寄り」。進化で勝率が上がるはず。
  const opponents: JankenOpponent[] = [
    { id: "rocky-1", params: { rock: 6, paper: 1, scissors: 1 } },
    { id: "rocky-2", params: { rock: 8, paper: 2, scissors: 1 } },
  ];

  it("進化後の勝率は初期（一様）より上がる（または同等以上）", async () => {
    const res = await evolveJanken({
      initial: uniform,
      opponents,
      roundsPerMatch: 300,
      iterations: 200,
      seed: 11,
      stepScale: 0.4,
    });
    // 一様(0.5付近)からグー偏重相手を突く分布へ改善。厳密に「同等以上」を満たす。
    expect(res.bestWinRate).toBeGreaterThanOrEqual(res.initialWinRate);
    // 実際に有意に勝てるようになっていること（パー寄りへ寄せれば 0.5 を超える）。
    expect(res.bestWinRate).toBeGreaterThan(0.5);
    // 進化後はパーの重みが最大になっているはず（グー相手の最適応答）。
    const w = normalizeWeights(res.bestParams);
    expect(w.paper).toBeGreaterThan(w.rock);
    expect(w.paper).toBeGreaterThan(w.scissors);
  });

  it("seed 固定で完全再現（best/勝率/履歴が一致）", async () => {
    const base = {
      initial: uniform,
      opponents,
      roundsPerMatch: 200,
      iterations: 150,
      seed: 23,
      stepScale: 0.3,
    } as const;
    const r1 = await evolveJanken({ ...base });
    const r2 = await evolveJanken({ ...base });
    expect(r1.bestParams).toEqual(r2.bestParams);
    expect(r1.bestWinRate).toBe(r2.bestWinRate);
    expect(r1.initialWinRate).toBe(r2.initialWinRate);
    expect(r1.optimize.history).toEqual(r2.optimize.history);
    expect(r1.optimize.evaluations).toBe(r2.optimize.evaluations);
  });

  it("seed が違えば探索経路が変わる（が結果は妥当）", async () => {
    const base = {
      initial: uniform,
      opponents,
      roundsPerMatch: 200,
      iterations: 150,
      stepScale: 0.3,
    };
    const a = await evolveJanken({ ...base, seed: 1 });
    const b = await evolveJanken({ ...base, seed: 2 });
    // 探索経路（履歴）は seed で変わる。
    expect(a.optimize.history).not.toEqual(b.optimize.history);
    // どちらも初期以上には改善している。
    expect(a.bestWinRate).toBeGreaterThanOrEqual(a.initialWinRate);
    expect(b.bestWinRate).toBeGreaterThanOrEqual(b.initialWinRate);
  });

  it("iterations=0 でも初期と同等（劣化しない）", async () => {
    const res = await evolveJanken({
      initial: uniform,
      opponents,
      roundsPerMatch: 200,
      iterations: 0,
      seed: 5,
      stepScale: 0.3,
    });
    // 反復ゼロ＝初期点のみ。best は初期勝率に一致。
    expect(res.bestWinRate).toBe(res.initialWinRate);
  });
});
