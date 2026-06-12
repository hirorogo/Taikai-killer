import { describe, it, expect } from "vitest";
import { extractText, composePrompt, buildArgs, parseGeminiError } from "../orchestrator/runtimes/geminiRunner.ts";
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

describe("geminiRunner.parseGeminiError", () => {
  it("認証エラー JSON（code=41）を警告行が前置されていても抽出", () => {
    const stderr = [
      "YOLO mode is enabled. All tool calls will be automatically approved.",
      'Approval mode overridden to "default" because the current folder is not trusted.',
      "{",
      '  "session_id": "abc",',
      '  "error": { "type": "Error", "message": "Please set an Auth method", "code": 41 }',
      "}",
    ].join("\n");
    expect(parseGeminiError(stderr)).toEqual({ code: 41, message: "Please set an Auth method" });
  });

  it("error フィールドの無い JSON は null（成功 response 等）", () => {
    expect(parseGeminiError(JSON.stringify({ response: "hi", session_id: "x" }))).toBeNull();
  });

  it("JSON が無い素テキストは null", () => {
    expect(parseGeminiError("Not enough arguments following: p")).toBeNull();
    expect(parseGeminiError("")).toBeNull();
  });

  it("code/message が部分的でも取れる分だけ返す", () => {
    expect(parseGeminiError('{"error":{"message":"boom"}}')).toEqual({ message: "boom" });
    expect(parseGeminiError('{"error":{"code":7}}')).toEqual({ code: 7 });
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
