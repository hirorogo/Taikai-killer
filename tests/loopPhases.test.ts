import { describe, it, expect } from "vitest";
import {
  formatKnowledge,
  knowledgeSeedUrls,
  mergeRefinement,
  buildRefinePrompt,
} from "../orchestrator/loopPhases.ts";
import type { CrawledUrl } from "../orchestrator/types.ts";
import type { TournamentInfo } from "../orchestrator/types.ts";

// spawn(crawl) / runCLISubprocess を呼ぶ副作用関数（gatherKnowledge / refineRequirements）は
// テスト外。ここでは純ロジック（formatKnowledge / mergeRefinement / seed/prompt 整形）のみ検証。

const crawledOk = (over: Partial<CrawledUrl> = {}): CrawledUrl => ({
  url: "https://a",
  title: "Alpha Beta",
  kind: "web",
  saved_path: "outputs/run/knowledge/0.txt",
  ...over,
});

describe("loopPhases.formatKnowledge", () => {
  it("saved_path 空（取得失敗）は捨てる", () => {
    const got = formatKnowledge([crawledOk({ saved_path: "" })]);
    expect(got).toBe("");
  });

  it("0 件 / 全件失敗なら空文字（スキップ相当）", () => {
    expect(formatKnowledge([])).toBe("");
    expect(formatKnowledge([crawledOk({ saved_path: "" }), crawledOk({ saved_path: "" })])).toBe("");
  });

  it("使える知見を箇条書きダイジェストに整形（url を出典に含む）", () => {
    const got = formatKnowledge([crawledOk({ title: "Monte Carlo Search", url: "https://x" })]);
    expect(got).toContain("外部知見ダイジェスト");
    expect(got).toContain("Monte Carlo Search");
    expect(got).toContain("<https://x>");
    expect(got.startsWith("## ")).toBe(true);
  });

  it("title から代表トークンを添える（重複排除・小文字）", () => {
    const got = formatKnowledge([crawledOk({ title: "Alpha alpha Beta" })]);
    // tokenize は小文字化＋重複は uniqueTokens で除去 → "alpha" は1回。
    expect(got).toContain("[alpha, beta]");
  });

  it("maxItems で件数を絞る（決定論的に入力順）", () => {
    const items = [
      crawledOk({ url: "https://1", title: "one", saved_path: "p1" }),
      crawledOk({ url: "https://2", title: "two", saved_path: "p2" }),
      crawledOk({ url: "https://3", title: "three", saved_path: "p3" }),
    ];
    const got = formatKnowledge(items, { maxItems: 2 });
    expect(got).toContain("<https://1>");
    expect(got).toContain("<https://2>");
    expect(got).not.toContain("<https://3>");
  });

  it("title が空でも (無題) で行を作る", () => {
    const got = formatKnowledge([crawledOk({ title: "" })]);
    expect(got).toContain("(無題)");
  });

  it("titleMaxChars で長いタイトルを切り詰める", () => {
    const long = "x".repeat(50);
    const got = formatKnowledge([crawledOk({ title: long })], { titleMaxChars: 10 });
    expect(got).toContain("x".repeat(10));
    expect(got).not.toContain("x".repeat(11));
  });

  it("旧名 excerptChars も後方互換で切り詰めに効く", () => {
    const long = "y".repeat(50);
    const got = formatKnowledge([crawledOk({ title: long })], { excerptChars: 8 });
    expect(got).toContain("y".repeat(8));
    expect(got).not.toContain("y".repeat(9));
  });
});

describe("loopPhases.knowledgeSeedUrls", () => {
  const baseTi: TournamentInfo = {
    name: "T",
    language: "python",
    run_cmd: "python main.py",
    test_cmd: "pytest",
    test_source: "provided",
    submission: { format: "zip" },
  };

  it("source_url があれば採用（trim 済み）", () => {
    const got = knowledgeSeedUrls({ ...baseTi, source_url: "  https://rules  " });
    expect(got).toEqual(["https://rules"]);
  });

  it("source_url 無し → 空配列（S2 スキップ）", () => {
    expect(knowledgeSeedUrls(baseTi)).toEqual([]);
  });

  it("空文字 source_url → 空配列", () => {
    expect(knowledgeSeedUrls({ ...baseTi, source_url: "   " })).toEqual([]);
  });
});

describe("loopPhases.mergeRefinement", () => {
  it("refinement 空なら spec をそのまま返す（安全側）", () => {
    expect(mergeRefinement("SPEC", "", "strat")).toBe("SPEC");
    expect(mergeRefinement("SPEC", "   \n ", "strat")).toBe("SPEC");
  });

  it("refinement があれば spec の末尾に精緻化ブロックを追記（spec は捨てない）", () => {
    const got = mergeRefinement("SPEC BODY", "- 曖昧点A\n- エッジB", "貪欲法");
    expect(got.startsWith("SPEC BODY")).toBe(true);
    expect(got).toContain("要件精緻化");
    expect(got).toContain("- 曖昧点A");
    expect(got).toContain("（戦略: 貪欲法）");
  });

  it("strategyApproach が長い場合はヘッダで切り詰め（80字）", () => {
    const longApproach = "あ".repeat(120);
    const got = mergeRefinement("SPEC", "- x", longApproach);
    expect(got).toContain("あ".repeat(80));
    expect(got).not.toContain("あ".repeat(81));
  });

  it("strategyApproach 空ならヘッダなしで追記", () => {
    const got = mergeRefinement("SPEC", "- x", "   ");
    expect(got).toContain("要件精緻化");
    expect(got).not.toContain("（戦略:");
  });
});

describe("loopPhases.buildRefinePrompt", () => {
  it("spec と strategy を埋め込み、2〜3点・コード禁止の制約を含む", () => {
    const p = buildRefinePrompt("MY SPEC", "MY STRATEGY");
    expect(p).toContain("MY SPEC");
    expect(p).toContain("MY STRATEGY");
    expect(p).toContain("2〜3");
    expect(p).toContain("コードは書かない");
  });
});
