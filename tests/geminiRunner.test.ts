import { describe, it, expect } from "vitest";
import { extractText, composePrompt, buildArgs } from "../orchestrator/runtimes/geminiRunner.ts";
import type { GenerateInput } from "../orchestrator/runtimeRegistry.ts";

describe("geminiRunner.extractText", () => {
  it("空 stdout は空・非エラー", () => {
    expect(extractText("")).toEqual({ text: "", isError: false });
    expect(extractText("   \n ")).toEqual({ text: "", isError: false });
  });

  it("JSON の result キーから本文を抽出", () => {
    const out = extractText(JSON.stringify({ result: "hello" }));
    expect(out).toEqual({ text: "hello", isError: false });
  });

  it("JSON の response / text キーもフォールバックで拾う", () => {
    expect(extractText(JSON.stringify({ response: "r" }))).toEqual({ text: "r", isError: false });
    expect(extractText(JSON.stringify({ text: "t" }))).toEqual({ text: "t", isError: false });
  });

  it("is_error:true を伝播する", () => {
    const out = extractText(JSON.stringify({ result: "x", is_error: true }));
    expect(out).toEqual({ text: "x", isError: true });
  });

  it("テキストキーの無い JSON は本文空・エラー扱い（素 stdout を採用しない）", () => {
    const out = extractText(JSON.stringify({ foo: 1 }));
    expect(out).toEqual({ text: "", isError: true });
  });

  it("非 JSON は素の stdout を本文採用（機械可読フラグ非対応版フォールバック）", () => {
    const out = extractText("  plain text answer  ");
    expect(out).toEqual({ text: "plain text answer", isError: false });
  });
});

describe("geminiRunner.composePrompt", () => {
  const base: GenerateInput = { prompt: "P", timeoutMs: 1000 };

  it("system 無しはプロンプトそのまま", () => {
    expect(composePrompt(base)).toBe("P");
  });

  it("system 有りは先頭に畳み込む", () => {
    expect(composePrompt({ ...base, system: "S" })).toBe("S\n\nP");
  });
});

describe("geminiRunner.buildArgs", () => {
  const base: GenerateInput = { prompt: "P", timeoutMs: 1000 };

  it("非対話フラグを必ず含む", () => {
    expect(buildArgs(base)).toContain("-p");
  });

  it("allowedTools 無し/空でも throw しない", () => {
    expect(() => buildArgs(base)).not.toThrow();
    expect(() => buildArgs({ ...base, allowedTools: [] })).not.toThrow();
    expect(() => buildArgs({ ...base, allowedTools: ["Read"] })).not.toThrow();
  });
});
