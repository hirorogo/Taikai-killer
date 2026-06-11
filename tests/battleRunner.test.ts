/**
 * battleRunner の純ロジックテスト（vitest）。
 * spawn は実プロセスなのでテスト対象外。prompt 構築 / parseMove / 集計詰め(packBattleResults) のみ検証。
 */
import { describe, it, expect } from "vitest";
import {
  buildHistoryPrompt,
  parseMove,
  packBattleResults,
  type PlayerState,
} from "../orchestrator/battleRunner.ts";
import type { Janken } from "../orchestrator/battle.ts";

describe("buildHistoryPrompt", () => {
  it("1 行 JSON（改行を含まない）で round/you/opponent/history を返す", () => {
    const s = buildHistoryPrompt(2, ["rock", "paper"], ["scissors", "rock"]);
    expect(s.includes("\n")).toBe(false);
    const parsed = JSON.parse(s) as PlayerState;
    expect(parsed.round).toBe(2);
    expect(parsed.you).toEqual(["rock", "paper"]);
    expect(parsed.opponent).toEqual(["scissors", "rock"]);
    expect(parsed.history).toEqual([
      { you: "rock", opponent: "scissors" },
      { you: "paper", opponent: "rock" },
    ]);
  });

  it("初手（履歴空）でも history は空配列で成立する", () => {
    const parsed = JSON.parse(buildHistoryPrompt(0, [], [])) as PlayerState;
    expect(parsed.round).toBe(0);
    expect(parsed.you).toEqual([]);
    expect(parsed.opponent).toEqual([]);
    expect(parsed.history).toEqual([]);
  });

  it("you/opponent の長さが食い違っても短い方までで history を組む（防御的）", () => {
    const parsed = JSON.parse(buildHistoryPrompt(3, ["rock", "paper", "rock"], ["scissors"])) as PlayerState;
    expect(parsed.history).toEqual([{ you: "rock", opponent: "scissors" }]);
    // 生配列はそのまま渡す（情報を落とさない）。
    expect(parsed.you).toHaveLength(3);
    expect(parsed.opponent).toHaveLength(1);
  });

  it("入力配列をコピーして渡す（呼び出し側の配列を共有参照しない）", () => {
    const you: Janken[] = ["rock"];
    const opp: Janken[] = ["paper"];
    const parsed = JSON.parse(buildHistoryPrompt(1, you, opp)) as PlayerState;
    you.push("scissors");
    // 既に JSON 化済みなので後からの push は反映されない（スナップショット性）。
    expect(parsed.you).toEqual(["rock"]);
    expect(parsed.opponent).toEqual(["paper"]);
  });
});

describe("parseMove", () => {
  it("正規の手をそのまま返す", () => {
    expect(parseMove("rock")).toBe("rock");
    expect(parseMove("paper")).toBe("paper");
    expect(parseMove("scissors")).toBe("scissors");
  });

  it("前後空白・改行・大文字を正規化する", () => {
    expect(parseMove("  ROCK  ")).toBe("rock");
    expect(parseMove("Paper\n")).toBe("paper");
    expect(parseMove("\r\nScissors\r\n")).toBe("scissors");
  });

  it("末尾の非空行を採用する（手前の改行を無視）", () => {
    expect(parseMove("\n\nrock\n")).toBe("rock");
    expect(parseMove("rock\npaper")).toBe("paper"); // 最後の手が有効
  });

  it("末尾行が不正なら null（中間の正規語に誤マッチしない）", () => {
    expect(parseMove("rock\ngarbage")).toBeNull();
  });

  it("空・不正・近い綴りは null", () => {
    expect(parseMove("")).toBeNull();
    expect(parseMove("   \n  ")).toBeNull();
    expect(parseMove("rocks")).toBeNull();
    expect(parseMove("グー")).toBeNull();
    expect(parseMove("0")).toBeNull();
  });
});

describe("packBattleResults: 集計詰め（BenchResult.battle 形）", () => {
  /** 全ペア全ラウンドで同じ手を出す手表を作る（テスト用）。 */
  function constMoves(
    players: string[],
    move: Record<string, Janken>,
    rounds: number,
  ): Map<string, Map<string, Janken[]>> {
    const m = new Map<string, Map<string, Janken[]>>();
    for (const id of players) {
      const inner = new Map<string, Janken[]>();
      for (const opp of players) {
        if (opp === id) continue;
        inner.set(opp, Array.from({ length: rounds }, () => move[id] ?? "rock"));
      }
      m.set(id, inner);
    }
    return m;
  }

  it("rock/paper/scissors 三すくみは全員 win_rate=0.5・1勝1敗", () => {
    const players = [{ id: "r" }, { id: "p" }, { id: "s" }];
    const moves = constMoves(["r", "p", "s"], { r: "rock", p: "paper", s: "scissors" }, 1);
    const res = packBattleResults(players, moves, 1);
    expect(res.totalMatches).toBe(3); // C(3,2)
    expect(res.rounds).toBe(1);
    for (const e of res.entries) {
      expect(e.battle.format).toBe("round_robin");
      expect(e.battle.record).toEqual({ wins: 1, losses: 1, draws: 0 });
      expect(e.win_rate).toBe(0.5);
      expect(e.battle.opponents).toHaveLength(2);
    }
  });

  it("常に rock 2 人 + scissors 1 人: rock は scissors に勝ち互いに引き分け", () => {
    const players = [{ id: "rock1" }, { id: "rock2" }, { id: "sc" }];
    const moves = constMoves(["rock1", "rock2", "sc"], { rock1: "rock", rock2: "rock", sc: "scissors" }, 1);
    const res = packBattleResults(players, moves, 1);
    const byId = Object.fromEntries(res.entries.map((e) => [e.id, e]));
    expect(byId["rock1"]!.battle.record).toEqual({ wins: 1, losses: 0, draws: 1 });
    expect(byId["rock2"]!.battle.record).toEqual({ wins: 1, losses: 0, draws: 1 });
    expect(byId["sc"]!.battle.record).toEqual({ wins: 0, losses: 2, draws: 0 });
    expect(byId["sc"]!.win_rate).toBe(0);
    expect(byId["rock1"]!.win_rate).toBeCloseTo(0.5, 10);
  });

  it("rounds 倍された record とマッチ数（C(n,2)*rounds）", () => {
    const players = [{ id: "r" }, { id: "p" }];
    const moves = constMoves(["r", "p"], { r: "rock", p: "paper" }, 4);
    const res = packBattleResults(players, moves, 4);
    expect(res.totalMatches).toBe(1 * 4);
    const byId = Object.fromEntries(res.entries.map((e) => [e.id, e]));
    // paper は rock に勝つ → p 全勝, r 全敗。
    expect(byId["p"]!.battle.record).toEqual({ wins: 4, losses: 0, draws: 0 });
    expect(byId["r"]!.battle.record).toEqual({ wins: 0, losses: 4, draws: 0 });
    expect(byId["p"]!.win_rate).toBe(1);
  });

  it("ラウンドごとに手が変わる手表（履歴依存戦略の模擬）も正しく集計する", () => {
    // a は round0=rock, round1=paper / b は両 round scissors。
    const moves = new Map<string, Map<string, Janken[]>>([
      ["a", new Map([["b", ["rock", "paper"] as Janken[]]])],
      ["b", new Map([["a", ["scissors", "scissors"] as Janken[]]])],
    ]);
    const res = packBattleResults([{ id: "a" }, { id: "b" }], moves, 2);
    const byId = Object.fromEntries(res.entries.map((e) => [e.id, e]));
    // r0: rock vs scissors → a win。 r1: paper vs scissors → b win。
    expect(byId["a"]!.battle.record).toEqual({ wins: 1, losses: 1, draws: 0 });
    expect(byId["b"]!.battle.record).toEqual({ wins: 1, losses: 1, draws: 0 });
  });

  it("opponents は自分以外の全員（来歴に使う）", () => {
    const players = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const moves = constMoves(["a", "b", "c"], { a: "rock", b: "rock", c: "rock" }, 1);
    const res = packBattleResults(players, moves, 1);
    const byId = Object.fromEntries(res.entries.map((e) => [e.id, e]));
    expect([...byId["a"]!.battle.opponents].sort()).toEqual(["b", "c"]);
    expect([...byId["b"]!.battle.opponents].sort()).toEqual(["a", "c"]);
  });

  it("手表が欠けていてもクラッシュせず rock で埋める（防御的）", () => {
    // a の対 b 手表を空にする → packBattleResults は rock を補う。
    const moves = new Map<string, Map<string, Janken[]>>([
      ["a", new Map([["b", [] as Janken[]]])],
      ["b", new Map([["a", ["scissors"] as Janken[]]])],
    ]);
    const res = packBattleResults([{ id: "a" }, { id: "b" }], moves, 1);
    const byId = Object.fromEntries(res.entries.map((e) => [e.id, e]));
    // a=rock(補完) vs b=scissors → a win。
    expect(byId["a"]!.battle.record).toEqual({ wins: 1, losses: 0, draws: 0 });
  });

  it("id 重複は弾く（来歴保護）", () => {
    const moves = new Map<string, Map<string, Janken[]>>();
    expect(() => packBattleResults([{ id: "dup" }, { id: "dup" }], moves, 1)).toThrow(/duplicate/);
  });

  it("1 人なら 0 戦・win_rate=0・opponents 空", () => {
    const moves = new Map<string, Map<string, Janken[]>>([["solo", new Map()]]);
    const res = packBattleResults([{ id: "solo" }], moves, 3);
    expect(res.totalMatches).toBe(0);
    expect(res.entries[0]!.win_rate).toBe(0);
    expect(res.entries[0]!.battle.opponents).toEqual([]);
    expect(res.entries[0]!.battle.record).toEqual({ wins: 0, losses: 0, draws: 0 });
  });

  it("同じ手表で 2 回呼ぶと完全一致（決定的）", () => {
    const players = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const moves = constMoves(["a", "b", "c"], { a: "rock", b: "paper", c: "scissors" }, 3);
    const r1 = packBattleResults(players, moves, 3);
    const r2 = packBattleResults(players, moves, 3);
    expect(r1).toEqual(r2);
  });
});
