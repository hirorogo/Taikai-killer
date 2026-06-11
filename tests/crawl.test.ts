import { describe, it, expect } from "vitest";
import {
  normalizeKind,
  mapToCrawledUrl,
  parseSidecarOutput,
  isRawCrawlRecord,
  type RawCrawlRecord,
} from "../orchestrator/crawl.ts";
import type { CrawledUrl } from "../orchestrator/types.ts";

// テスト用の決定的な保存先リゾルバ（index でユニーク）。
const savePath = (_rec: RawCrawlRecord, i: number): string => `outputs/run/knowledge/${i}.txt`;

describe("crawl.normalizeKind", () => {
  it("許容値はそのまま通す", () => {
    expect(normalizeKind("web")).toBe("web");
    expect(normalizeKind("paper")).toBe("paper");
    expect(normalizeKind("arxiv")).toBe("arxiv");
  });

  it("未知値・非文字列は web に丸める", () => {
    expect(normalizeKind("pdf")).toBe("web");
    expect(normalizeKind("")).toBe("web");
    expect(normalizeKind(undefined)).toBe("web");
    expect(normalizeKind(42)).toBe("web");
    expect(normalizeKind(null)).toBe("web");
  });
});

describe("crawl.isRawCrawlRecord", () => {
  it("url が文字列なら true", () => {
    expect(isRawCrawlRecord({ url: "https://x" })).toBe(true);
  });

  it("url 欠落/非文字列・非オブジェクトは false", () => {
    expect(isRawCrawlRecord({ title: "t" })).toBe(false);
    expect(isRawCrawlRecord({ url: 1 })).toBe(false);
    expect(isRawCrawlRecord(null)).toBe(false);
    expect(isRawCrawlRecord("https://x")).toBe(false);
    expect(isRawCrawlRecord(undefined)).toBe(false);
  });
});

describe("crawl.mapToCrawledUrl", () => {
  it("成功レコードは saved_path をリゾルバから割り当てる", () => {
    const rec: RawCrawlRecord = { url: "https://a", title: "A", kind: "web", text: "body" };
    const got = mapToCrawledUrl(rec, 0, savePath);
    const expected: CrawledUrl = {
      url: "https://a",
      title: "A",
      kind: "web",
      saved_path: "outputs/run/knowledge/0.txt",
    };
    expect(got).toEqual(expected);
  });

  it("error 付きレコードは saved_path 空（保存対象なし）", () => {
    const rec: RawCrawlRecord = {
      url: "https://b",
      title: "",
      kind: "web",
      text: "",
      error: "robots_disallowed",
    };
    const got = mapToCrawledUrl(rec, 3, savePath);
    expect(got.saved_path).toBe("");
    expect(got.url).toBe("https://b");
  });

  it("kind は正規化される（arxiv/paper 維持、未知は web）", () => {
    expect(mapToCrawledUrl({ url: "u", title: "", kind: "arxiv", text: "" }, 0, savePath).kind).toBe(
      "arxiv",
    );
    expect(
      mapToCrawledUrl({ url: "u", title: "", kind: "weird", text: "" }, 0, savePath).kind,
    ).toBe("web");
  });

  it("title 欠落は空文字に正規化（CrawledUrl.title は必須）", () => {
    // text/title が undefined でも throw せず空文字で埋める。
    const rec = { url: "u", kind: "web" } as unknown as RawCrawlRecord;
    const got = mapToCrawledUrl(rec, 0, savePath);
    expect(got.title).toBe("");
  });

  it("excluded は載せない（exactOptionalPropertyTypes: undefined キーを作らない）", () => {
    const got = mapToCrawledUrl({ url: "u", title: "t", kind: "web", text: "x" }, 0, savePath);
    expect("excluded" in got).toBe(false);
  });

  it("空文字 error は成功扱い（error フィールドだが長さ 0）", () => {
    const rec: RawCrawlRecord = { url: "u", title: "t", kind: "web", text: "x", error: "" };
    const got = mapToCrawledUrl(rec, 2, savePath);
    expect(got.saved_path).toBe("outputs/run/knowledge/2.txt");
  });
});

describe("crawl.parseSidecarOutput", () => {
  it("正常な JSON 配列を CrawledUrl[] に変換（入力順保持）", () => {
    const json = JSON.stringify([
      { url: "https://a", title: "A", kind: "web", text: "x" },
      { url: "https://arxiv.org/abs/1", title: "P", kind: "arxiv", text: "y" },
    ]);
    const got = parseSidecarOutput(json, savePath);
    expect(got).toHaveLength(2);
    expect(got[0]?.url).toBe("https://a");
    expect(got[1]?.kind).toBe("arxiv");
    expect(got[0]?.saved_path).toBe("outputs/run/knowledge/0.txt");
  });

  it("壊れた JSON は空配列（throw しない / partial-first）", () => {
    expect(parseSidecarOutput("{not json", savePath)).toEqual([]);
    expect(parseSidecarOutput("", savePath)).toEqual([]);
    expect(parseSidecarOutput("   \n ", savePath)).toEqual([]);
  });

  it("配列でない JSON は空配列", () => {
    expect(parseSidecarOutput(JSON.stringify({ url: "x" }), savePath)).toEqual([]);
    expect(parseSidecarOutput(JSON.stringify("str"), savePath)).toEqual([]);
  });

  it("不正要素はスキップし、有効なものだけ index を採番", () => {
    const json = JSON.stringify([
      { url: "https://a", title: "A", kind: "web", text: "x" },
      { title: "no-url" }, // url 欠落 → スキップ
      null, // 非オブジェクト → スキップ
      { url: "https://c", title: "C", kind: "web", text: "z" },
    ]);
    const got = parseSidecarOutput(json, savePath);
    expect(got.map((c) => c.url)).toEqual(["https://a", "https://c"]);
    // スキップ要素は index を消費しない（採番は連番）。
    expect(got[1]?.saved_path).toBe("outputs/run/knowledge/1.txt");
  });

  it("error 付き要素は saved_path 空のまま配列に含む（失敗も first-class）", () => {
    const json = JSON.stringify([
      { url: "https://fail", title: "", kind: "web", text: "", error: "Timeout" },
    ]);
    const got = parseSidecarOutput(json, savePath);
    expect(got).toHaveLength(1);
    expect(got[0]?.saved_path).toBe("");
  });
});
