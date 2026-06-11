/**
 * Claude CLI runner（CLI subprocess 型）。
 * 移植元: dashboard/server/services/chat_runtime_cli.py。
 * claude CLI を機械可読モード（--output-format json 等）で叩き、ハード timeout、
 * 装飾 stdout パース禁止＝JSON 抽出のみ。TODO(Issue#3): 実装。
 */
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

export const claudeRunner: Runtime = {
  name: "claude",

  async run(_input: GenerateInput): Promise<GenerateOutput> {
    // TODO(Issue#3): child_process.spawn("claude", ["--print","--output-format","json", ...])
    //   - timeout で kill、stdout から JSON 抽出、exitCode/emptyResult 判定
    throw new Error("claudeRunner.run 未実装（Issue #3）");
  },

  async checkAvailable(): Promise<{ ok: boolean; hint?: string }> {
    // TODO(Issue#3): `claude --version` で存在＋認証を確認
    return { ok: false, hint: "未実装" };
  },
};
