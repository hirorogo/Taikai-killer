import { describe, it, expect } from "vitest";
import {
  dedupStrategies,
  normalizeApproach,
  jaccard,
  DEFAULT_THRESHOLD,
} from "../orchestrator/collector.ts";
import type { Strategy } from "../orchestrator/types.ts";

/** テスト用 Strategy ファクトリ。 */
function strat(id: string, approach: string, extra?: Partial<Strategy>): Strategy {
  return { id, origin: "requirement", approach, ...extra };
}

describe("normalizeApproach", () => {
  it("小文字化・前後trim・連続空白の圧縮を行う", () => {
    expect(normalizeApproach("  Greedy   First\tMove\n Best ")).toBe("greedy first move best");
  });

  it("正規化だけが違う文字列は一致する", () => {
    expect(normalizeApproach("Minimax  Depth 3")).toBe(normalizeApproach("minimax depth 3"));
  });
});

describe("jaccard", () => {
  it("完全一致は 1、無交差は 0", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("部分一致は |∩|/|∪|", () => {
    // ∩={a,b}=2, ∪={a,b,c,d}=4 → 0.5
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["a", "b", "d"]))).toBe(0.5);
  });

  it("両方空は 1、片方だけ空は 0", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("dedupStrategies — 正規化一致での統合", () => {
  it("大文字小文字・空白だけ違う戦略を1件に統合し merged_from に記録する", () => {
    const input: Strategy[] = [
      strat("s1", "Greedy first move"),
      strat("s2", "greedy   first move"),
      strat("s3", "GREEDY FIRST MOVE"),
    ];
    const out = dedupStrategies(input);
    expect(out).toHaveLength(1);
    const rep = out[0]!;
    expect(rep.id).toBe("s1"); // 最初に現れたものが代表
    expect(rep.approach).toBe("Greedy first move"); // 代表の原文を保持
    expect(rep.merged_from).toEqual(["s2", "s3"]); // 統合元・入力順
  });
});

describe("dedupStrategies — Jaccard 閾値での統合", () => {
  it("閾値以上のトークン重複は統合される", () => {
    // tokens: {alpha,beta,gamma,delta} vs {alpha,beta,gamma,epsilon}
    // ∩=3, ∪=5 → 0.6。閾値 0.5 なら統合される。
    const input: Strategy[] = [
      strat("a", "alpha beta gamma delta"),
      strat("b", "alpha beta gamma epsilon"),
    ];
    const out = dedupStrategies(input, { threshold: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.merged_from).toEqual(["b"]);
  });

  it("既定閾値 0.85 では 0.6 程度の類似は統合されない", () => {
    const input: Strategy[] = [
      strat("a", "alpha beta gamma delta"),
      strat("b", "alpha beta gamma epsilon"),
    ];
    const out = dedupStrategies(input); // 既定 0.85
    expect(out).toHaveLength(2);
    expect(out[0]!.merged_from).toBeUndefined();
    expect(out[1]!.merged_from).toBeUndefined();
  });

  it("DEFAULT_THRESHOLD は 0.85", () => {
    expect(DEFAULT_THRESHOLD).toBe(0.85);
  });
});

describe("dedupStrategies — 非重複の保持", () => {
  it("似ていない戦略はそのまま保持し merged_from を付けない", () => {
    const input: Strategy[] = [
      strat("a", "minimax with alpha-beta pruning"),
      strat("b", "monte carlo tree search rollout"),
      strat("c", "rule based heuristic table"),
    ];
    const out = dedupStrategies(input);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.id)).toEqual(["a", "b", "c"]);
    for (const s of out) {
      expect(s.merged_from).toBeUndefined();
    }
  });
});

describe("dedupStrategies — 順序安定（決定的）", () => {
  it("出力は代表が初出した入力順を保つ", () => {
    const input: Strategy[] = [
      strat("x", "approach one"),
      strat("y", "approach two"),
      strat("x2", "Approach One"), // x に統合
      strat("z", "approach three"),
      strat("y2", "approach   two"), // y に統合
    ];
    const out = dedupStrategies(input);
    expect(out.map((s) => s.id)).toEqual(["x", "y", "z"]);
    expect(out[0]!.merged_from).toEqual(["x2"]);
    expect(out[1]!.merged_from).toEqual(["y2"]);
    expect(out[2]!.merged_from).toBeUndefined();
  });

  it("同一入力で複数回呼んでも同じ結果（決定的）", () => {
    const input: Strategy[] = [
      strat("a", "foo bar"),
      strat("b", "foo bar"),
      strat("c", "baz qux"),
    ];
    const first = dedupStrategies(input);
    const second = dedupStrategies(input);
    expect(first).toEqual(second);
  });
});

describe("dedupStrategies — merged_from 履歴の引き継ぎ", () => {
  it("統合される戦略が持つ既存 merged_from を代表に取り込む", () => {
    const input: Strategy[] = [
      strat("rep", "shared approach"),
      strat("dup", "shared   approach", { merged_from: ["old1", "old2"] }),
    ];
    const out = dedupStrategies(input);
    expect(out).toHaveLength(1);
    // dup 自身の id ＋ dup が運んできた履歴。
    expect(out[0]!.merged_from).toEqual(["dup", "old1", "old2"]);
  });

  it("代表が元々持つ merged_from を温存しつつ新規統合分を追記する", () => {
    const input: Strategy[] = [
      strat("rep", "shared approach", { merged_from: ["prior"] }),
      strat("dup", "shared approach"),
    ];
    const out = dedupStrategies(input);
    expect(out[0]!.merged_from).toEqual(["prior", "dup"]);
  });

  it("merged_from の重複・代表 id 自己参照は排除される", () => {
    const input: Strategy[] = [
      strat("rep", "x y z"),
      strat("dup1", "x y z", { merged_from: ["rep", "dup2"] }),
      strat("dup2", "x y z"),
    ];
    const out = dedupStrategies(input);
    expect(out).toHaveLength(1);
    // rep(自己参照)は除外、dup2 は二重登録されない。
    expect(out[0]!.merged_from).toEqual(["dup1", "dup2"]);
  });
});

describe("dedupStrategies — エッジケース", () => {
  it("空配列は空配列を返す", () => {
    expect(dedupStrategies([])).toEqual([]);
  });

  it("入力配列・要素を破壊しない", () => {
    const a = strat("a", "same thing");
    const b = strat("b", "same thing");
    const input = [a, b];
    dedupStrategies(input);
    expect(input).toHaveLength(2);
    expect(a.merged_from).toBeUndefined();
    expect(b.merged_from).toBeUndefined();
  });

  it("空 approach どうしは統合される", () => {
    const input: Strategy[] = [strat("a", "   "), strat("b", "")];
    const out = dedupStrategies(input);
    expect(out).toHaveLength(1);
    expect(out[0]!.merged_from).toEqual(["b"]);
  });
});
