import { describe, it, expect } from "vitest";
import {
  evolveJankenDemo,
  defaultOpponents,
} from "../evolution/evolveDemo.ts";
import type { EvolveDemoResult } from "../evolution/evolveDemo.ts";
import { normalizeWeights } from "../evolution/jankenStrategy.ts";
import type { JankenParams } from "../evolution/jankenStrategy.ts";
import type { JankenOpponent } from "../evolution/jankenEvolve.ts";

describe("defaultOpponents（内蔵の固定相手群）", () => {
  it("非空で id が一意（runRoundRobin の重複 id 禁止に適合）", () => {
    const opps = defaultOpponents();
    expect(opps.length).toBeGreaterThan(0);
    const ids = opps.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("毎回同じ顔ぶれを返す（純データ・決定的）", () => {
    expect(defaultOpponents()).toEqual(defaultOpponents());
  });
});

describe("evolveJankenDemo (D18 ① end-to-end, LLM 非依存)", () => {
  it("戻り値の形が {initialParams, initialWinRate, evolvedParams, evolvedWinRate, improved}", async () => {
    const res: EvolveDemoResult = await evolveJankenDemo({ seed: 7, iterations: 50 });
    expect(res.initialParams).toEqual({ rock: 1, paper: 1, scissors: 1 });
    expect(typeof res.initialWinRate).toBe("number");
    expect(typeof res.evolvedWinRate).toBe("number");
    expect(typeof res.improved).toBe("boolean");
    // evolvedParams は重みの 3 キーを持つ。
    expect(Object.keys(res.evolvedParams).sort()).toEqual(["paper", "rock", "scissors"]);
  });

  it("進化後の勝率は初期以上（同 seed・劣化しない）", async () => {
    const res = await evolveJankenDemo({ seed: 11, iterations: 200 });
    expect(res.evolvedWinRate).toBeGreaterThanOrEqual(res.initialWinRate);
    // improved フラグは「厳密に上回ったか」と整合する。
    expect(res.improved).toBe(res.evolvedWinRate > res.initialWinRate);
  });

  it("seed 固定で完全再現（params/勝率/フラグが一致）", async () => {
    const opts = { seed: 23, iterations: 150 } as const;
    const r1 = await evolveJankenDemo({ ...opts });
    const r2 = await evolveJankenDemo({ ...opts });
    expect(r1.evolvedParams).toEqual(r2.evolvedParams);
    expect(r1.evolvedWinRate).toBe(r2.evolvedWinRate);
    expect(r1.initialWinRate).toBe(r2.initialWinRate);
    expect(r1.improved).toBe(r2.improved);
  });

  it("相手が常に rock なら進化後はパー寄りで勝率が上がる", async () => {
    const onlyRock: JankenOpponent[] = [
      { id: "always-rock", params: { rock: 1, paper: 0, scissors: 0 } },
    ];
    const res = await evolveJankenDemo({
      seed: 3,
      iterations: 200,
      opponents: onlyRock,
      roundsPerMatch: 300,
      stepScale: 0.4,
    });
    // 勝率が初期(一様≈0.5)から上がり、有意に 0.5 を超える。
    expect(res.improved).toBe(true);
    expect(res.evolvedWinRate).toBeGreaterThan(0.5);
    expect(res.evolvedWinRate).toBeGreaterThan(res.initialWinRate);
    // グー相手の最適応答＝パー。進化後はパーの重みが最大になっているはず。
    const w = normalizeWeights(res.evolvedParams);
    expect(w.paper).toBeGreaterThan(w.rock);
    expect(w.paper).toBeGreaterThan(w.scissors);
  });

  it("iterations=0 なら初期と同等（improved=false）", async () => {
    const res = await evolveJankenDemo({ seed: 5, iterations: 0 });
    expect(res.evolvedWinRate).toBe(res.initialWinRate);
    expect(res.improved).toBe(false);
  });

  it("初期パラメータを指定でき、戻り値にそのまま反映される", async () => {
    const initial: JankenParams = { rock: 2, paper: 1, scissors: 1 };
    const res = await evolveJankenDemo({ seed: 9, iterations: 30, initial });
    expect(res.initialParams).toEqual(initial);
  });

  it("内蔵の既定相手群でも end-to-end が改善方向に回る（劣化しない）", async () => {
    const res = await evolveJankenDemo({ seed: 17, iterations: 250 });
    expect(res.evolvedWinRate).toBeGreaterThanOrEqual(res.initialWinRate);
  });
});
