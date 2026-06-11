import { describe, it, expect } from "vitest";
import {
  GEMINI_AUTH_ENV_VARS,
  hasAuthEnv,
  isAuthError,
} from "../orchestrator/runtimes/geminiMcp.ts";

describe("geminiMcp.GEMINI_AUTH_ENV_VARS", () => {
  it("実機の code=41 メッセージが列挙する3種を保持する", () => {
    expect([...GEMINI_AUTH_ENV_VARS]).toEqual([
      "GEMINI_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_GENAI_USE_GCA",
    ]);
  });
});

describe("geminiMcp.hasAuthEnv", () => {
  it("どの認証 env も無ければ false", () => {
    expect(hasAuthEnv({})).toBe(false);
  });

  it("空文字/空白だけの値は未設定扱い（false）", () => {
    expect(hasAuthEnv({ GEMINI_API_KEY: "" })).toBe(false);
    expect(hasAuthEnv({ GEMINI_API_KEY: "   " })).toBe(false);
  });

  it("いずれか1つでも非空なら true", () => {
    expect(hasAuthEnv({ GEMINI_API_KEY: "k" })).toBe(true);
    expect(hasAuthEnv({ GOOGLE_GENAI_USE_VERTEXAI: "true" })).toBe(true);
    expect(hasAuthEnv({ GOOGLE_GENAI_USE_GCA: "true" })).toBe(true);
  });

  it("無関係な env では false（誤検知しない）", () => {
    expect(hasAuthEnv({ PATH: "/usr/bin", HOME: "/home/x" })).toBe(false);
  });
});

describe("geminiMcp.isAuthError", () => {
  it("空入力は false", () => {
    expect(isAuthError("")).toBe(false);
    expect(isAuthError("   \n ")).toBe(false);
  });

  it("JSON の error.code=41 を検知（実機 -o json 出力形）", () => {
    const real = JSON.stringify({
      session_id: "abc",
      error: {
        type: "Error",
        message:
          "Please set an Auth method ... GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
        code: 41,
      },
    });
    expect(isAuthError(real)).toBe(true);
  });

  it("素テキストの 'Please set an Auth method' を検知（非 JSON 版フォールバック）", () => {
    expect(isAuthError("Error: Please set an Auth method before running")).toBe(true);
  });

  it("code 41 をテキストとして含む場合も検知", () => {
    expect(isAuthError("auth failed code: 41")).toBe(true);
  });

  it("別コード/別エラーは false（41 以外を auth 扱いしない）", () => {
    expect(isAuthError(JSON.stringify({ error: { code: 1 } }))).toBe(false);
    expect(isAuthError("some unrelated runtime error")).toBe(false);
  });

  it("成功 JSON（response あり・error 無し）は false", () => {
    expect(isAuthError(JSON.stringify({ response: "hello", session_id: "x" }))).toBe(false);
  });
});
