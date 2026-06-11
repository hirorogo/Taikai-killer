/**
 * s6battle の純ロジックテスト（vitest）。
 * 実プロセス対戦（runBattleEval の spawn）は battleRunner に委譲＝テスト対象外。
 * rank 付与 / 同率処理 / 空入力ガード / BenchResult 詰め直し（toBenchResults）のみ検証。
 */
import { describe, it, expect } from "vitest";
import { toBenchResults, type BattleEvalEntry, type RubricRef } from "../orchestrator/s6battle.ts";

const RUBRIC: RubricRef = { derived_from: "tournament:demo-cup", eval_mode: "battle" };

/** win_rate と最小 battle 形だけ持つエントリを作る（rank テスト用）。 */
function entry(id: string, win_rate: number, opponents: string[] = []): BattleEvalEntry {
  const wins = Math.round(win_rate * 10);
  return {
    id,
    win_rate,
    battle: {
      opponents,
      record: { wins, losses: 10 - wins, draws: 0 },
      format: "round_robin",
    },
  };
}

describe("toBenchResults: 空入力ガード", () => {
  it("空配列は空配列を返す", () => {
    expect(toBenchResults([], RUBRIC)).toEqual([]);
  });
});

describe("toBenchResults: BenchResult 形への変換", () => {
  it("eval_mode=battle / rubric_ref / score=win_rate / metrics.win_rate を詰める", () => {
    const out = toBenchResults([entry("a", 0.75, ["b"])], RUBRIC, "run-1");
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.eval_mode).toBe("battle");
    expect(r.rubric_ref).toBe("tournament:demo-cup");
    expect(r.strategy_id).toBe("a");
    expect(r.result_id).toBe("run-1:a");
    expect(r.score).toBe(0.75);
    expect(r.win_rate).toBe(0.75);
    expect(r.metrics).toEqual({ win_rate: 0.75 });
    expect(r.threshold).toEqual([]);
    expect(r.battle).toEqual({
      opponents: ["b"],
      record: { wins: 8, losses: 2, draws: 0 },
      format: "round_robin",
    });
  });

  it("runId 未指定なら result_id は 'battle:<id>'", () => {
    const out = toBenchResults([entry("x", 0.5)], RUBRIC);
    expect(out[0]!.result_id).toBe("battle:x");
  });

  it("battle.record / opponents をコピーして詰める（入力配列を共有参照しない）", () => {
    const opp = ["b", "c"];
    const e = entry("a", 0.5, opp);
    const out = toBenchResults([e], RUBRIC);
    opp.push("d");
    expect(out[0]!.battle!.opponents).toEqual(["b", "c"]); // スナップショット性
  });
});

describe("toBenchResults: rank 付与（win_rate 降順）", () => {
  it("win_rate 降順で 1,2,3 を振る（入力順は保持）", () => {
    const out = toBenchResults([entry("low", 0.2), entry("high", 0.9), entry("mid", 0.5)], RUBRIC);
    // 戻り並びは入力順（low, high, mid）。rank だけ win_rate 由来。
    expect(out.map((r) => [r.strategy_id, r.rank])).toEqual([
      ["low", 3],
      ["high", 1],
      ["mid", 2],
    ]);
  });

  it("最強（最大 win_rate）が rank 1", () => {
    const out = toBenchResults([entry("a", 0.3), entry("b", 1)], RUBRIC);
    const byId = Object.fromEntries(out.map((r) => [r.strategy_id, r.rank]));
    expect(byId["b"]).toBe(1);
    expect(byId["a"]).toBe(2);
  });
});

describe("toBenchResults: 同率処理（standard competition ranking, 1224）", () => {
  it("同率は同 rank・次の rank は同率件数ぶん飛ぶ（0.9,0.9,0.5 → 1,1,3）", () => {
    const out = toBenchResults([entry("a", 0.9), entry("b", 0.9), entry("c", 0.5)], RUBRIC);
    const byId = Object.fromEntries(out.map((r) => [r.strategy_id, r.rank]));
    expect(byId["a"]).toBe(1);
    expect(byId["b"]).toBe(1);
    expect(byId["c"]).toBe(3);
  });

  it("3 者同率は全員 rank 1", () => {
    const out = toBenchResults([entry("a", 0.5), entry("b", 0.5), entry("c", 0.5)], RUBRIC);
    expect(out.every((r) => r.rank === 1)).toBe(true);
  });

  it("中間の同率（0.9,0.7,0.7,0.3 → 1,2,2,4）", () => {
    const out = toBenchResults(
      [entry("a", 0.9), entry("b", 0.7), entry("c", 0.7), entry("d", 0.3)],
      RUBRIC,
    );
    const byId = Object.fromEntries(out.map((r) => [r.strategy_id, r.rank]));
    expect(byId["a"]).toBe(1);
    expect(byId["b"]).toBe(2);
    expect(byId["c"]).toBe(2);
    expect(byId["d"]).toBe(4);
  });
});

describe("toBenchResults: id 重複ガード（来歴保護）", () => {
  it("strategy id が重複したら throw", () => {
    expect(() => toBenchResults([entry("dup", 0.5), entry("dup", 0.3)], RUBRIC)).toThrow(/duplicate/);
  });
});

describe("toBenchResults: 決定性", () => {
  it("同じ入力で 2 回呼ぶと完全一致", () => {
    const input = [entry("a", 0.9), entry("b", 0.9), entry("c", 0.5)];
    const r1 = toBenchResults(input, RUBRIC, "run-x");
    const r2 = toBenchResults(input, RUBRIC, "run-x");
    expect(r1).toEqual(r2);
  });

  it("単一エントリは rank 1", () => {
    const out = toBenchResults([entry("solo", 0)], RUBRIC);
    expect(out[0]!.rank).toBe(1);
    expect(out[0]!.score).toBe(0);
  });
});
