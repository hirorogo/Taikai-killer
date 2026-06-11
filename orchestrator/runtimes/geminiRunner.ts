/**
 * Gemini CLI runner（CLI subprocess 型）。MVP スコープ外（Claude 1モデルで縦串を通す）。
 * 縦串が通ったら claudeRunner と同形で実装。移植元: chat_runtime_gemini.py。
 */
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

export const geminiRunner: Runtime = {
  name: "gemini",
  async run(_input: GenerateInput): Promise<GenerateOutput> {
    throw new Error("geminiRunner.run 未実装（MVPスコープ外）");
  },
  async checkAvailable(): Promise<{ ok: boolean; hint?: string }> {
    return { ok: false, hint: "MVPスコープ外" };
  },
};
