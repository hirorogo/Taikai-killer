import { describe, it, expect } from "vitest";
import {
  runRoundRobin,
  jankenMatch,
  jankenCompare,
  toBattleRecord,
} from "../orchestrator/battle.ts";
import type { Participant, Janken, MatchFn } from "../orchestrator/battle.ts";

/** 常に同じ手を出す決定的プレイヤーを作る。 */
function constPlayer(id: string, move: Janken): Participant<number, Janken> {
  return { id, play: () => move };
}

describe("jankenCompare", () => {
  it("優劣表どおり（rock>scissors, paper>rock, scissors>paper）", () => {
    expect(jankenCompare("rock", "scissors")).toBe("a");
    expect(jankenCompare("paper", "rock")).toBe("a");
    expect(jankenCompare("scissors", "paper")).toBe("a");
    expect(jankenCompare("scissors", "rock")).toBe("b");
    expect(jankenCompare("rock", "paper")).toBe("b");
    expect(jankenCompare("paper", "scissors")).toBe("b");
  });

  it("同じ手は引き分け", () => {
    expect(jankenCompare("rock", "rock")).toBe("draw");
    expect(jankenCompare("paper", "paper")).toBe("draw");
    expect(jankenCompare("scissors", "scissors")).toBe("draw");
  });
});

describe("jankenMatch", () => {
  it("PlayFn を呼んで 1 手で決着する", () => {
    const a = () => "rock" as Janken;
    const b = () => "scissors" as Janken;
    expect(jankenMatch(a, b, 0)).toBe("a");
  });

  it("round 番号が play に渡る（ラウンドで手を変えられる）", () => {
    const a: (round: number) => Janken = (round) => (round % 2 === 0 ? "rock" : "scissors");
    const b = () => "scissors" as Janken;
    expect(jankenMatch(a, b, 0)).toBe("a"); // rock vs scissors
    expect(jankenMatch(a, b, 1)).toBe("draw"); // scissors vs scissors
  });
});

describe("runRoundRobin: 総当たり件数", () => {
  it("n 人 1 ラウンドで C(n,2) マッチ", () => {
    const players = [
      constPlayer("r", "rock"),
      constPlayer("p", "paper"),
      constPlayer("s", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    expect(res.totalMatches).toBe(3); // C(3,2)=3
    expect(res.rounds).toBe(1);
    expect(res.results).toHaveLength(3);
  });

  it("rounds 倍された総マッチ数 = C(n,2)*rounds", () => {
    const players = [
      constPlayer("a", "rock"),
      constPlayer("b", "paper"),
      constPlayer("c", "scissors"),
      constPlayer("d", "rock"),
    ];
    const res = runRoundRobin(players, jankenMatch, 5);
    expect(res.totalMatches).toBe(6 * 5); // C(4,2)=6
    expect(res.rounds).toBe(5);
  });

  it("各選手の対戦数の合計 = 総マッチ数*2（各マッチ2選手）", () => {
    const players = [
      constPlayer("a", "rock"),
      constPlayer("b", "paper"),
      constPlayer("c", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 2);
    const totalPlayed = res.results.reduce(
      (sum, r) => sum + r.record.wins + r.record.losses + r.record.draws,
      0,
    );
    expect(totalPlayed).toBe(res.totalMatches * 2);
  });
});

describe("runRoundRobin: 勝率と勝敗", () => {
  it("rock/paper/scissors 三すくみは全員 win_rate=0.5（1勝1敗）", () => {
    const players = [
      constPlayer("rock", "rock"),
      constPlayer("paper", "paper"),
      constPlayer("scissors", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    for (const r of res.results) {
      expect(r.record).toEqual({ wins: 1, losses: 1, draws: 0 });
      expect(r.win_rate).toBe(0.5);
    }
  });

  it("常に rock を出す 2 人 + scissors 1 人: rock は scissors に勝ち互いに引き分け", () => {
    const players = [
      constPlayer("rock1", "rock"),
      constPlayer("rock2", "rock"),
      constPlayer("scissors", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    // rock1: vs rock2=draw, vs scissors=win
    expect(byId["rock1"]!.record).toEqual({ wins: 1, losses: 0, draws: 1 });
    expect(byId["rock2"]!.record).toEqual({ wins: 1, losses: 0, draws: 1 });
    // scissors: vs rock1=loss, vs rock2=loss
    expect(byId["scissors"]!.record).toEqual({ wins: 0, losses: 2, draws: 0 });
    expect(byId["scissors"]!.win_rate).toBe(0);
    expect(byId["rock1"]!.win_rate).toBeCloseTo(0.5, 10); // 1/(1+0+1)
  });
});

describe("runRoundRobin: 引き分け", () => {
  it("全員同じ手なら全マッチ引き分け（win_rate=0）", () => {
    const players = [
      constPlayer("a", "rock"),
      constPlayer("b", "rock"),
      constPlayer("c", "rock"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    for (const r of res.results) {
      expect(r.record.wins).toBe(0);
      expect(r.record.losses).toBe(0);
      expect(r.record.draws).toBe(2);
      expect(r.win_rate).toBe(0);
    }
  });
});

describe("runRoundRobin: エッジケース", () => {
  it("1 人なら 0 戦・win_rate=0", () => {
    const res = runRoundRobin([constPlayer("solo", "rock")], jankenMatch, 3);
    expect(res.totalMatches).toBe(0);
    expect(res.results[0]!.win_rate).toBe(0);
    expect(res.results[0]!.opponents).toEqual([]);
  });

  it("0 人なら空結果", () => {
    const res = runRoundRobin<number, Janken>([], jankenMatch, 1);
    expect(res.totalMatches).toBe(0);
    expect(res.results).toEqual([]);
  });

  it("rounds<=0 は 0 戦扱い", () => {
    const players = [constPlayer("a", "rock"), constPlayer("b", "paper")];
    const res = runRoundRobin(players, jankenMatch, 0);
    expect(res.totalMatches).toBe(0);
    expect(res.results[0]!.record).toEqual({ wins: 0, losses: 0, draws: 0 });
  });

  it("id 重複は弾く（来歴保護）", () => {
    const players = [constPlayer("dup", "rock"), constPlayer("dup", "paper")];
    expect(() => runRoundRobin(players, jankenMatch, 1)).toThrow(/duplicate/);
  });

  it("opponents は自分以外の全員", () => {
    const players = [
      constPlayer("a", "rock"),
      constPlayer("b", "paper"),
      constPlayer("c", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    expect(byId["a"]!.opponents.sort()).toEqual(["b", "c"]);
    expect(byId["b"]!.opponents.sort()).toEqual(["a", "c"]);
  });
});

describe("runRoundRobin: 決定性", () => {
  // round を seed に混ぜる乱数 play（Math.random 非依存）。
  const hands: Janken[] = ["rock", "paper", "scissors"];
  const seededPlayer = (id: string, base: number): Participant<number, Janken> => ({
    id,
    // round + base で決定的に手を選ぶ（同入力→同手）。
    play: (round) => hands[(round + base) % 3]!,
  });

  it("同一入力で 2 回実行すると完全一致（決定的）", () => {
    const make = () => [seededPlayer("x", 0), seededPlayer("y", 1), seededPlayer("z", 2)];
    const r1 = runRoundRobin(make(), jankenMatch, 9);
    const r2 = runRoundRobin(make(), jankenMatch, 9);
    expect(r1.results).toEqual(r2.results);
    expect(r1.totalMatches).toBe(r2.totalMatches);
  });
});

describe("toBattleRecord: BenchResult.battle 形に詰める", () => {
  it("opponents/record/format=round_robin が出る", () => {
    const players = [
      constPlayer("rock", "rock"),
      constPlayer("paper", "paper"),
      constPlayer("scissors", "scissors"),
    ];
    const res = runRoundRobin(players, jankenMatch, 1);
    const battle = toBattleRecord(res.results[0]!);
    expect(battle.format).toBe("round_robin");
    expect(battle.record).toEqual({ wins: 1, losses: 1, draws: 0 });
    expect(Array.isArray(battle.opponents)).toBe(true);
    expect(battle.opponents.length).toBe(2);
  });

  it("カスタム matchFn も受け付ける（じゃんけん非依存の汎用性）", () => {
    // 数値で勝敗を決める別ゲーム: 大きい数字を出した方が勝ち。
    const numMatch: MatchFn<number, number> = (a, b, round) => {
      const va = a(round);
      const vb = b(round);
      if (va === vb) return "draw";
      return va > vb ? "a" : "b";
    };
    const players: Participant<number, number>[] = [
      { id: "hi", play: () => 10 },
      { id: "mid", play: () => 5 },
      { id: "lo", play: () => 1 },
    ];
    const res = runRoundRobin(players, numMatch, 1);
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    expect(byId["hi"]!.record).toEqual({ wins: 2, losses: 0, draws: 0 });
    expect(byId["hi"]!.win_rate).toBe(1);
    expect(byId["lo"]!.record).toEqual({ wins: 0, losses: 2, draws: 0 });
  });
});
