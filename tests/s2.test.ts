import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newUniqueRatio,
  shouldContinueS2,
  dedupeUrls,
  tokenize,
  buildKnowledgeIndex,
  knowledgeFileName,
  resolveKnowledgePath,
  runS2,
  S2_MAX_ROUNDS,
  S2_CONVERGENCE_RATIO,
  type KnowledgeRecord,
  type RunS2Options,
} from "../orchestrator/s2.ts";
import type { CrawledUrl } from "../orchestrator/types.ts";
import type { RawCrawlRecord } from "../orchestrator/crawl.ts";

describe("s2.newUniqueRatio", () => {
  it("全て新規なら 1.0", () => {
    expect(newUniqueRatio([], ["a", "b", "c"])).toBe(1);
    expect(newUniqueRatio(["x"], ["a", "b"])).toBe(1);
  });

  it("全て既知なら 0", () => {
    expect(newUniqueRatio(["a", "b"], ["a", "b"])).toBe(0);
  });

  it("半分新規なら 0.5", () => {
    expect(newUniqueRatio(["a", "b"], ["a", "c"])).toBe(0.5);
  });

  it("curr が空なら 0（ゼロ除算回避・収束扱い）", () => {
    expect(newUniqueRatio(["a"], [])).toBe(0);
    expect(newUniqueRatio([], [])).toBe(0);
  });

  it("curr 内の重複はユニーク件数で数える（分母も分子も集合基準）", () => {
    // curr = {a,a,b} → ユニーク2件、新規は b の1件 → 1/2
    expect(newUniqueRatio(["a"], ["a", "a", "b"])).toBe(0.5);
    // 全部同じ新規1件 → 1/1
    expect(newUniqueRatio([], ["z", "z", "z"])).toBe(1);
  });

  it("prev 内の重複は集合として畳む", () => {
    expect(newUniqueRatio(["a", "a", "a"], ["a", "b"])).toBe(0.5);
  });
});

describe("s2.shouldContinueS2 (D7 停止条件)", () => {
  it("初回（round 0・prevRatio 無し）は継続", () => {
    expect(shouldContinueS2(0)).toBe(true);
  });

  it("ハードキャップ4回で停止（OR の片側）", () => {
    expect(shouldContinueS2(S2_MAX_ROUNDS - 1, 0.9)).toBe(true);
    expect(shouldContinueS2(S2_MAX_ROUNDS, 0.9)).toBe(false);
    expect(shouldContinueS2(S2_MAX_ROUNDS + 1, 0.9)).toBe(false);
  });

  it("新規率 <10% で収束停止（OR の片側）", () => {
    expect(shouldContinueS2(1, S2_CONVERGENCE_RATIO - 0.01)).toBe(false);
    expect(shouldContinueS2(1, 0)).toBe(false);
  });

  it("ちょうど 10% は閾値未満でないので継続", () => {
    expect(shouldContinueS2(1, S2_CONVERGENCE_RATIO)).toBe(true);
  });

  it("新規率高 かつ 回数未達なら継続", () => {
    expect(shouldContinueS2(2, 0.5)).toBe(true);
  });
});

describe("s2.dedupeUrls", () => {
  it("初出のみ残し入力順を保持", () => {
    expect(dedupeUrls(["a", "b", "a", "c", "b"])).toEqual(["a", "b", "c"]);
  });

  it("前後空白を除去して同一視（残すのは trim 済み）", () => {
    expect(dedupeUrls(["  https://x  ", "https://x"])).toEqual(["https://x"]);
  });

  it("末尾スラッシュとフラグメントを畳んで同一視", () => {
    expect(dedupeUrls(["https://x/page", "https://x/page/", "https://x/page#sec"])).toEqual([
      "https://x/page",
    ]);
  });

  it("空・空白のみは捨てる", () => {
    expect(dedupeUrls(["", "   ", "https://y"])).toEqual(["https://y"]);
  });

  it("異なる URL は潰さない", () => {
    expect(dedupeUrls(["https://a", "https://b"])).toEqual(["https://a", "https://b"]);
  });
});

describe("s2.tokenize", () => {
  it("小文字化し記号で分割", () => {
    expect(tokenize("Hello, World! Foo-Bar")).toEqual(["hello", "world", "foo", "bar"]);
  });

  it("stopword と短すぎる token を除外", () => {
    // "the","a","of","is" は stopword、"x"(1文字) は min 未満
    expect(tokenize("the quick a fox is x", 2)).toEqual(["quick", "fox"]);
  });

  it("日本語も分割される（記号区切り）", () => {
    const got = tokenize("強化学習 と 探索");
    expect(got).toContain("強化学習");
    expect(got).toContain("探索");
  });

  it("空文字は空配列", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("s2.buildKnowledgeIndex (steal B-2)", () => {
  const recs: KnowledgeRecord[] = [
    { path: "k/a.txt", title: "Minimax", text: "minimax search alpha beta pruning" },
    { path: "k/b.txt", title: "Reinforcement", text: "reinforcement learning minimax bandit" },
    { path: "k/c.txt", title: "Pruning", text: "alpha beta pruning tree" },
  ];

  it("token から出現ファイルパスを逆引きできる", () => {
    const idx = buildKnowledgeIndex(recs);
    expect(idx["minimax"]).toBeDefined();
    expect(idx["minimax"]).toContain("k/a.txt");
    expect(idx["minimax"]).toContain("k/b.txt");
    expect(idx["minimax"]).not.toContain("k/c.txt");
  });

  it("複数パスに出る token は頻度降順（同点はパス昇順で決定論的）", () => {
    // "alpha" は a.txt(1) と c.txt(1) に各1回 → 同点 → パス昇順 a,c
    const idx = buildKnowledgeIndex(recs);
    expect(idx["alpha"]).toEqual(["k/a.txt", "k/c.txt"]);
  });

  it("頻度の高いパスが先頭に来る", () => {
    const recs2: KnowledgeRecord[] = [
      { path: "k/hi.txt", title: "", text: "go go go go" },
      { path: "k/lo.txt", title: "", text: "go once" },
    ];
    const idx = buildKnowledgeIndex(recs2);
    expect(idx["go"]).toEqual(["k/hi.txt", "k/lo.txt"]);
  });

  it("path 空（保存失敗）のレコードは index に載せない", () => {
    const recs3: KnowledgeRecord[] = [
      { path: "", title: "Lost", text: "ghost token unique" },
      { path: "k/ok.txt", title: "Kept", text: "ghost kept" },
    ];
    const idx = buildKnowledgeIndex(recs3);
    expect(idx["ghost"]).toEqual(["k/ok.txt"]);
    expect(idx["unique"]).toBeUndefined();
  });

  it("maxPathsPerToken で値配列を切り詰める", () => {
    const many: KnowledgeRecord[] = Array.from({ length: 5 }, (_, i) => ({
      path: `k/${i}.txt`,
      title: "",
      text: "shared",
    }));
    const idx = buildKnowledgeIndex(many, { maxPathsPerToken: 2 });
    expect(idx["shared"]).toHaveLength(2);
  });

  it("maxTokens で採用 token 種類数を絞る（頻度上位優先）", () => {
    const recs4: KnowledgeRecord[] = [
      { path: "k/x.txt", title: "", text: "common common common rare" },
    ];
    const idx = buildKnowledgeIndex(recs4, { maxTokens: 1 });
    // 頻度最上位の "common" だけ採用
    expect(Object.keys(idx)).toEqual(["common"]);
  });

  it("空入力は空オブジェクト", () => {
    expect(buildKnowledgeIndex([])).toEqual({});
  });

  it("title もトークン源に含まれる", () => {
    const recs5: KnowledgeRecord[] = [{ path: "k/t.txt", title: "Quiescence", text: "search" }];
    const idx = buildKnowledgeIndex(recs5);
    expect(idx["quiescence"]).toEqual(["k/t.txt"]);
  });
});

describe("s2.knowledgeFileName / resolveKnowledgePath", () => {
  it("同一 url+index は決定論的に同じ名前", () => {
    expect(knowledgeFileName("https://a", 0)).toBe(knowledgeFileName("https://a", 0));
  });

  it("url が違えば名前が違う（衝突回避）", () => {
    expect(knowledgeFileName("https://a", 0)).not.toBe(knowledgeFileName("https://b", 0));
  });

  it("index が違えば名前が違う", () => {
    expect(knowledgeFileName("https://a", 0)).not.toBe(knowledgeFileName("https://a", 1));
  });

  it(".txt 拡張子・index ゼロ埋め", () => {
    const name = knowledgeFileName("https://a", 7);
    expect(name).toMatch(/^k0007_[0-9a-f]{12}\.txt$/);
  });

  it("resolveKnowledgePath は knowledgeDir に join", () => {
    const p = resolveKnowledgePath("/tmp/kn", "https://a", 0);
    expect(p).toContain("kn");
    expect(p.endsWith(".txt")).toBe(true);
  });
});

// ───────── runS2 結線（副作用・統合点）／D7 反復ループ ─────────

/** url → 本文 を引く偽サイドカー本文表。 */
type TextTable = Record<string, { title?: string; text: string }>;

/**
 * crawl() を模す crawlFn スタブ。実 crawl と同形に resolveSavedPath を index 付きで
 * 各 rec に対し呼び（保存の副作用を発火）、その戻り値を saved_path にした CrawledUrl[] を返す。
 * urls に無い本文は空文字（取得失敗相当）として扱う。
 */
function makeCrawlFn(table: TextTable): {
  fn: NonNullable<RunS2Options["crawlFn"]>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn: NonNullable<RunS2Options["crawlFn"]> = (urls, _timeoutMs, opts = {}) => {
    calls.push([...urls]);
    const resolve = opts.resolveSavedPath ?? ((): string => "");
    const out: CrawledUrl[] = urls.map((url, i) => {
      const entry = table[url] ?? { text: "" };
      const rec: RawCrawlRecord = { url, title: entry.title ?? "", kind: "web", text: entry.text };
      return { url, title: rec.title, kind: "web", saved_path: resolve(rec, i) };
    });
    return Promise.resolve(out);
  };
  return { fn, calls };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "s2-runs2-"));
}

describe("s2.runS2 (結線・統合)", () => {
  it("保存成功 rec はファイルが書かれ saved_path 確定・savedCount 一致・index に載る", async () => {
    const dir = freshDir();
    const { fn, calls } = makeCrawlFn({
      "https://a": { title: "Alpha", text: "minimax search alpha" },
      "https://b": { title: "Beta", text: "reinforcement learning bandit" },
    });
    const res = await runS2(["https://a", "https://b"], dir, { crawlFn: fn });

    expect(res.savedCount).toBe(2);
    expect(res.rounds).toBe(1);
    // 2 件とも saved_path 確定し、実ファイルが書かれている。
    const paths = res.crawled.map((c) => c.saved_path);
    expect(paths.every((p) => p.length > 0)).toBe(true);
    for (const c of res.crawled) {
      expect(existsSync(c.saved_path)).toBe(true);
    }
    // index に該当パスが逆引きで載る。
    expect(res.knowledgeIndex["minimax"]).toBeDefined();
    const aPath = res.crawled.find((c) => c.url === "https://a")!.saved_path;
    expect(res.knowledgeIndex["minimax"]).toContain(aPath);
    // dedupe 済みの urls が crawlFn に渡っている。
    expect(calls[0]).toEqual(["https://a", "https://b"]);
  });

  it("本文が書かれた中身は rec.text と一致", async () => {
    const dir = freshDir();
    const { fn } = makeCrawlFn({ "https://a": { text: "concrete body text" } });
    const res = await runS2(["https://a"], dir, { crawlFn: fn });
    const p = res.crawled[0]!.saved_path;
    expect(readFileSync(p, "utf8")).toBe("concrete body text");
  });

  it("本文空（trim 0）の rec は保存せず records に積まれず index に不在", async () => {
    const dir = freshDir();
    const { fn } = makeCrawlFn({
      "https://full": { title: "Kept", text: "ghost kept body" },
      "https://empty": { title: "Empty", text: "   " }, // 空白のみ＝雑音
    });
    const res = await runS2(["https://full", "https://empty"], dir, { crawlFn: fn });

    expect(res.savedCount).toBe(1);
    const emptyCrawled = res.crawled.find((c) => c.url === "https://empty")!;
    expect(emptyCrawled.saved_path).toBe("");
    // 空本文しか持たない unique token は index に載らない。
    expect(res.knowledgeIndex["ghost"]).toBeDefined();
    // empty 由来のファイルは作られていない（dir 内は full の1件のみ）。
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("dedupe が crawlFn に渡る urls に効く（重複・末尾スラッシュを畳む）", async () => {
    const dir = freshDir();
    const { fn, calls } = makeCrawlFn({ "https://x/p": { text: "body" } });
    await runS2(["https://x/p", "https://x/p/", "https://x/p#frag"], dir, { crawlFn: fn });
    expect(calls[0]).toEqual(["https://x/p"]);
  });

  it("2 ラウンド目で新規率<10% → 早期 break して crawlFn 呼び出しが打ち切られる", async () => {
    const dir = freshDir();
    // round 0: 10 件すべて新規。round 1: 同じ 10 件中 9 件既知＋1 新規 → 新規率 0.1 ではなく
    // <0.1 にするため 11 件中 1 新規にする（1/11 ≈ 0.09 < 0.1）。
    const round0 = Array.from({ length: 11 }, (_, i) => `https://u${i}`);
    const round1 = [...round0]; // 全既知 → 新規率 0 < 0.1 → round 1 完了後に停止
    const round2 = ["https://new-should-not-be-fetched"];
    const table: TextTable = Object.fromEntries(
      [...round0, ...round2].map((u) => [u, { text: `body ${u}` }]),
    );
    const { fn, calls } = makeCrawlFn(table);

    const provider = (round: number): readonly string[] =>
      round === 0 ? round0 : round === 1 ? round1 : round2;

    const res = await runS2([], dir, { crawlFn: fn, urlsForRound: provider });

    // round 0 と round 1 の 2 回だけ crawl が呼ばれ、round 2 には到達しない。
    expect(calls).toHaveLength(2);
    expect(res.rounds).toBe(2);
    expect(calls.flat()).not.toContain("https://new-should-not-be-fetched");
  });

  it("新規率が高いとハードキャップ S2_MAX_ROUNDS 回で打ち切る", async () => {
    const dir = freshDir();
    // 毎ラウンド全件新規（重複なし）→ 収束しない → ハードキャップで停止。
    const provider = (round: number): readonly string[] => [`https://r${round}-a`, `https://r${round}-b`];
    const table: TextTable = {};
    for (let r = 0; r < 10; r += 1) {
      table[`https://r${r}-a`] = { text: `a${r}` };
      table[`https://r${r}-b`] = { text: `b${r}` };
    }
    const { fn, calls } = makeCrawlFn(table);

    const res = await runS2([], dir, { crawlFn: fn, urlsForRound: provider });

    expect(res.rounds).toBe(S2_MAX_ROUNDS);
    expect(calls).toHaveLength(S2_MAX_ROUNDS);
  });

  it("既定 provider は 1 ラウンドで収束（urls だけ渡す従来挙動）", async () => {
    const dir = freshDir();
    const { fn, calls } = makeCrawlFn({ "https://a": { text: "body a" } });
    const res = await runS2(["https://a"], dir, { crawlFn: fn });
    expect(res.rounds).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("crawl 0 件でも throw せず空 index・savedCount 0（partial-first）", async () => {
    const dir = freshDir();
    const { fn } = makeCrawlFn({});
    const res = await runS2([], dir, { crawlFn: fn });
    expect(res.savedCount).toBe(0);
    expect(res.knowledgeIndex).toEqual({});
    expect(res.rounds).toBe(0);
  });
});
