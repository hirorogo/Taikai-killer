import { describe, it, expect } from "vitest";
import { runRoundRobin } from "../orchestrator/battle.ts";
import type { Participant, MatchOutcome } from "../orchestrator/battle.ts";
import {
  rpslsCompare,
  rpslsMatch,
  RPSLS_MOVES,
  morraCompare,
  morraMatch,
  MORRA_MOVES,
  isMorraMove,
  clampMorra,
} from "../orchestrator/battleGames.ts";
import type { Rpsls, Morra } from "../orchestrator/battleGames.ts";

/** 勝敗の対称を反転（a↔b、draw はそのまま）。対称性テストの期待値生成に使う。 */
function flip(o: MatchOutcome): MatchOutcome {
  if (o === "a") return "b";
  if (o === "b") return "a";
  return "draw";
}

/** 常に同じ手を出す決定的プレイヤー。 */
function constPlayer<M>(id: string, move: M): Participant<number, M> {
  return { id, play: () => move };
}

// ───────── (1) RPSLS ─────────

describe("rpslsCompare: 勝敗表（カノニカル 10 関係）", () => {
  it("rock は scissors と lizard に勝つ", () => {
    expect(rpslsCompare("rock", "scissors")).toBe("a");
    expect(rpslsCompare("rock", "lizard")).toBe("a");
  });
  it("paper は rock と spock に勝つ", () => {
    expect(rpslsCompare("paper", "rock")).toBe("a");
    expect(rpslsCompare("paper", "spock")).toBe("a");
  });
  it("scissors は paper と lizard に勝つ", () => {
    expect(rpslsCompare("scissors", "paper")).toBe("a");
    expect(rpslsCompare("scissors", "lizard")).toBe("a");
  });
  it("lizard は spock と paper に勝つ", () => {
    expect(rpslsCompare("lizard", "spock")).toBe("a");
    expect(rpslsCompare("lizard", "paper")).toBe("a");
  });
  it("spock は scissors と rock に勝つ", () => {
    expect(rpslsCompare("spock", "scissors")).toBe("a");
    expect(rpslsCompare("spock", "rock")).toBe("a");
  });
});

describe("rpslsCompare: 引き分け", () => {
  it("同じ手は全て draw", () => {
    for (const m of RPSLS_MOVES) {
      expect(rpslsCompare(m, m)).toBe("draw");
    }
  });
});

describe("rpslsCompare: 対称性と構造", () => {
  it("反対称: compare(a,b) と compare(b,a) は互いに反転（draw は自己対称）", () => {
    for (const a of RPSLS_MOVES) {
      for (const b of RPSLS_MOVES) {
        expect(rpslsCompare(b, a)).toBe(flip(rpslsCompare(a, b)));
      }
    }
  });

  it("各手はちょうど 2 勝 2 敗（自分以外 4 手に対して）", () => {
    for (const a of RPSLS_MOVES) {
      let wins = 0;
      let losses = 0;
      let draws = 0;
      for (const b of RPSLS_MOVES) {
        const o = rpslsCompare(a, b);
        if (o === "a") wins++;
        else if (o === "b") losses++;
        else draws++;
      }
      expect(wins).toBe(2);
      expect(losses).toBe(2);
      expect(draws).toBe(1); // 自分自身との draw
    }
  });
});

describe("rpslsMatch: MatchFn として round-robin に渡せる", () => {
  it("5 手の総当たりは全員 win_rate=0.5（2勝2敗）", () => {
    const players = RPSLS_MOVES.map((m) => constPlayer<Rpsls>(m, m));
    const res = runRoundRobin(players, rpslsMatch, 1);
    expect(res.totalMatches).toBe(10); // C(5,2)
    for (const r of res.results) {
      expect(r.record).toEqual({ wins: 2, losses: 2, draws: 0 });
      expect(r.win_rate).toBe(0.5);
    }
  });

  it("round 番号が play に渡る（手をラウンドで変えられる）", () => {
    const a: (round: number) => Rpsls = (round) => (round % 2 === 0 ? "rock" : "paper");
    const b = () => "rock" as Rpsls;
    expect(rpslsMatch(a, b, 0)).toBe("draw"); // rock vs rock
    expect(rpslsMatch(a, b, 1)).toBe("a"); // paper vs rock
  });

  it("決定的: 同一入力で 2 回実行すると完全一致", () => {
    const make = () =>
      RPSLS_MOVES.map((m, i) => ({
        id: m,
        play: (round: number): Rpsls => RPSLS_MOVES[(round + i) % RPSLS_MOVES.length]!,
      }));
    const r1 = runRoundRobin(make(), rpslsMatch, 7);
    const r2 = runRoundRobin(make(), rpslsMatch, 7);
    expect(r1.results).toEqual(r2.results);
  });
});

// ───────── (2) Morra ─────────

describe("isMorraMove: 合法手ガード", () => {
  it("1..5 の整数のみ true", () => {
    expect(MORRA_MOVES.every((m) => isMorraMove(m))).toBe(true);
    expect(isMorraMove(0)).toBe(false);
    expect(isMorraMove(6)).toBe(false);
    expect(isMorraMove(2.5)).toBe(false);
    expect(isMorraMove(-1)).toBe(false);
  });
});

describe("morraCompare: 合計の偶奇＋大小ルール", () => {
  it("合計が偶数なら本数が大きい方が勝ち", () => {
    expect(morraCompare(3, 1)).toBe("a"); // 4 偶, 3>1 → a
    expect(morraCompare(1, 3)).toBe("b"); // 4 偶, 1<3 → b
    expect(morraCompare(4, 2)).toBe("a"); // 6 偶, 4>2 → a
    expect(morraCompare(5, 1)).toBe("a"); // 6 偶, 5>1 → a
  });
  it("合計が奇数なら本数が小さい方が勝ち", () => {
    expect(morraCompare(1, 2)).toBe("a"); // 3 奇, 1<2 → a
    expect(morraCompare(2, 1)).toBe("b"); // 3 奇, 2>1 → b
    expect(morraCompare(3, 4)).toBe("a"); // 7 奇, 3<4 → a
    expect(morraCompare(5, 2)).toBe("b"); // 7 奇, 5>2 → b
  });
  it("同じ本数は draw（鏡像は決着しない）", () => {
    for (const m of MORRA_MOVES) {
      expect(morraCompare(m, m)).toBe("draw");
    }
  });
  it("不正な手は例外（決定的な早期失敗）", () => {
    // @ts-expect-error 範囲外の値を意図的に渡す
    expect(() => morraCompare(0, 3)).toThrow(/illegal Morra move/);
    // @ts-expect-error 範囲外の値を意図的に渡す
    expect(() => morraCompare(3, 6)).toThrow(/illegal Morra move/);
  });
});

describe("morraCompare: 対称性", () => {
  it("反対称: compare(a,b) と compare(b,a) は互いに反転（draw は自己対称）", () => {
    for (const a of MORRA_MOVES) {
      for (const b of MORRA_MOVES) {
        // 偶奇は a+b=b+a で同じ、draw は a===b の対称。よって compare(b,a)=flip(compare(a,b))。
        // ただし draw 同士は flip しても draw、勝ち負けは偶奇が同じなので a/b の役割だけ入れ替わる。
        const ab = morraCompare(a, b);
        const ba = morraCompare(b, a);
        expect(ba).toBe(flip(ab));
      }
    }
  });
});

describe("morraMatch: MatchFn として round-robin に渡せる", () => {
  it("勝敗表どおり集計される", () => {
    // 常に 2 / 常に 3 / 常に 4 を出す 3 人。
    const players = [constPlayer<Morra>("two", 2), constPlayer<Morra>("three", 3), constPlayer<Morra>("four", 4)];
    const res = runRoundRobin(players, morraMatch, 1);
    const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
    // two vs three = 5 奇 → three(b) 勝ち / two 負け
    // two vs four = 6 偶 → two(a) 勝ち / four 負け
    // three vs four = 7 奇 → four(b) 勝ち / three 負け
    expect(byId["two"]!.record).toEqual({ wins: 1, losses: 1, draws: 0 });
    expect(byId["three"]!.record).toEqual({ wins: 1, losses: 1, draws: 0 });
    expect(byId["four"]!.record).toEqual({ wins: 1, losses: 1, draws: 0 });
  });

  it("全員同じ本数なら全マッチ draw", () => {
    const players = [
      constPlayer<Morra>("a", 3),
      constPlayer<Morra>("b", 3),
      constPlayer<Morra>("c", 3),
    ];
    const res = runRoundRobin(players, morraMatch, 1);
    for (const r of res.results) {
      expect(r.record).toEqual({ wins: 0, losses: 0, draws: 2 });
      expect(r.win_rate).toBe(0);
    }
  });

  it("round 番号が play に渡る", () => {
    const a: (round: number) => Morra = (round) => (round % 2 === 0 ? 1 : 2);
    const b = () => 3 as Morra;
    expect(morraMatch(a, b, 0)).toBe("b"); // a=1,b=3 sum4 偶 → 大きい b
    expect(morraMatch(a, b, 1)).toBe("a"); // a=2,b=3 sum5 奇 → 小さい a
  });

  it("決定的: 同一入力で 2 回実行すると完全一致", () => {
    const make = () =>
      MORRA_MOVES.map((m, i) => ({
        id: `p${m}`,
        play: (round: number): Morra => MORRA_MOVES[(round + i) % MORRA_MOVES.length]!,
      }));
    const r1 = runRoundRobin(make(), morraMatch, 11);
    const r2 = runRoundRobin(make(), morraMatch, 11);
    expect(r1.results).toEqual(r2.results);
  });
});

describe("clampMorra: 不正値の丸め", () => {
  it("合法手はそのまま、不正値は 1 に丸める（決定的）", () => {
    const wild = clampMorra((round) => round); // round そのものを手にする: 0,1,2,...
    expect(wild(0)).toBe(1); // 0 は不正 → 1
    expect(wild(1)).toBe(1); // 1 は合法
    expect(wild(3)).toBe(3); // 3 は合法
    expect(wild(5)).toBe(5); // 5 は合法
    expect(wild(6)).toBe(1); // 6 は不正 → 1
    const over = clampMorra(() => 99);
    expect(over(0)).toBe(1);
  });
});
