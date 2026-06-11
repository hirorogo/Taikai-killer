/**
 * Claude CLI runner（CLI subprocess 型 / D4）。
 * 移植元: dashboard/server/services/chat_runtime_cli.py（speca, Python→TS）。
 *
 * 方針:
 * - `claude --print --output-format json --dangerously-skip-permissions` で1ショット。
 * - プロンプトは **stdin 経由**（argv クオート問題を回避）。
 * - Windows は claude.cmd を shell 経由で解決し windowsHide。
 * - ハード timeout で SIGKILL。装飾 stdout はパースせず、JSON のみ解釈。
 */
import { spawn } from "node:child_process";
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

const IS_WIN = process.platform === "win32";

function buildArgs(input: GenerateInput): string[] {
  const args = ["--print", "--output-format", "json", "--dangerously-skip-permissions"];
  const allowed = input.allowedTools ?? [];
  if (allowed.length > 0) {
    args.push("--allowed-tools", allowed.join(","));
  } else {
    // 空 = 全ツール無効。明示しないと version によっては "all" 既定になるため。
    args.push("--disallowed-tools", "*");
  }
  if (input.system) {
    args.push("--append-system-prompt", input.system);
  }
  return args;
}

/** `claude --output-format json` の単一 JSON から本文を抽出。装飾は弾く。 */
function extractText(stdout: string): { text: string; isError: boolean } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", isError: false };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const result = obj["result"];
    const text = typeof result === "string" ? result : "";
    return { text, isError: obj["is_error"] === true };
  } catch {
    // JSON 不正（装飾混入等）→ E_LLM_COMM 扱いになるよう空で返す
    return { text: "", isError: true };
  }
}

function spawnClaude(args: string[], promptStdin: string, timeoutMs: number): Promise<GenerateOutput> {
  return new Promise<GenerateOutput>((resolve, reject) => {
    const child = spawn("claude", args, {
      shell: IS_WIN, // Windows は claude.cmd を PATH から解決させる
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`spawn claude failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`claude CLI timed out after ${timeoutMs}ms`));
        return;
      }
      const { text } = extractText(stdout);
      resolve({
        text,
        raw: stdout || stderr,
        exitCode: code ?? -1,
        emptyResult: text.trim() === "",
      });
    });

    // プロンプトは stdin で渡す（argv クオート地獄を回避）
    child.stdin.on("error", () => {
      /* EPIPE 等は無視（close で処理） */
    });
    child.stdin.write(promptStdin);
    child.stdin.end();
  });
}

export const claudeRunner: Runtime = {
  name: "claude",

  async run(input: GenerateInput): Promise<GenerateOutput> {
    return spawnClaude(buildArgs(input), input.prompt, input.timeoutMs);
  },

  async checkAvailable(): Promise<{ ok: boolean; hint?: string }> {
    try {
      const out = await spawnClaude(["--version"], "", 15_000);
      return out.exitCode === 0
        ? { ok: true }
        : { ok: false, hint: `claude --version exit ${out.exitCode}` };
    } catch (e) {
      return { ok: false, hint: e instanceof Error ? e.message : String(e) };
    }
  },
};
