/**
 * Gemini CLI runner（CLI subprocess 型 / D4）。
 * 移植元: dashboard/server/services/chat_runtime_gemini.py（speca, Python→TS）。
 * 構造は claudeRunner.ts と同形に揃える（spawn / stdin プロンプト / ハード timeout / 本文抽出 / --version 存在確認）。
 *
 * ⚠ フラグ非互換の可能性（要実機検証）:
 * - gemini CLI の正確な非対話フラグは claude と異なる可能性が高い。本実装は「非対話・1ショット・
 *   機械可読」を狙って暫定フラグ（GEMINI_NONINTERACTIVE_FLAGS）を置くが、実機で gemini CLI のヘルプを
 *   確認して差し替える前提。最低限 `gemini --version` で存在確認できる形は保証する。
 * - Google 公式 gemini CLI は非対話実行を `-p/--prompt` または stdin で受ける版があり、
 *   `--output-format json` 相当が無い版もある。そのため本文抽出は「JSON ならパース、ダメなら素の
 *   stdout を本文扱い」の二段構えにしている（D4: 装飾 stdout はそのまま採用せず、可能なら機械可読を優先）。
 */
import { spawn } from "node:child_process";
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

const IS_WIN = process.platform === "win32";

/**
 * ⚠ 暫定フラグ。gemini CLI の実フラグは未確定（claude と非互換の可能性大）。
 * 非対話・1ショット・機械可読を意図する。実機検証後にここを差し替える。
 * - claude の `--print` 相当（非対話 1ショット）として `-p` を想定。プロンプト本文は stdin で渡すため
 *   `-p` には値を付けない版が無い場合は、buildArgs の方を実機に合わせて修正する。
 * - JSON 機械可読出力フラグも未確定（`--output-format json` 等）。無い版では extractText の
 *   フォールバックで素の stdout を本文採用する。
 */
const GEMINI_NONINTERACTIVE_FLAGS = ["-p"] as const;

/** checkAvailable 用の軽量 timeout（claudeRunner と同値）。 */
const VERSION_TIMEOUT_MS = 15_000;

function buildArgs(input: GenerateInput): string[] {
  // ⚠ 実フラグ未確定。非対話・機械可読を意図した暫定構成。
  const args: string[] = [...GEMINI_NONINTERACTIVE_FLAGS];

  // ツール許可（集中力ガード / 集約は config 側）。
  // ⚠ gemini CLI に allowed-tools 相当が無い版がある。フラグ名が違うため、実機確認まで
  //    「許可ツールが指定されたら拡張する」スロットだけ用意し、既定では何も足さない。
  const allowed = input.allowedTools ?? [];
  if (allowed.length > 0) {
    // 例: args.push("--allowed-tools", allowed.join(",")); ← フラグ名は実機で要確認
  }

  // system プロンプトの渡し方も版依存。claude の `--append-system-prompt` 相当が無ければ
  // run() 側で stdin プロンプトの先頭に畳み込む（下記参照）。
  return args;
}

/**
 * gemini CLI 出力から本文を抽出。
 * 1) JSON（`{ "result": ... }` / `{ "response": ... }` / `{ "text": ... }`）ならその文字列を採用。
 * 2) JSON でなければ素の stdout を本文扱い（機械可読フラグが無い版のフォールバック）。
 */
function extractText(stdout: string): { text: string; isError: boolean } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", isError: false };

  // まず JSON として解釈を試みる（機械可読モードがある版）。
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    // 版によりキーが異なるため候補を順に見る。
    const candidate = obj["result"] ?? obj["response"] ?? obj["text"];
    if (typeof candidate === "string") {
      return { text: candidate, isError: obj["is_error"] === true };
    }
    // JSON だがテキストキーが無い → 構造未知。素の stdout は使わず空（E_LLM_COMM 寄せ）。
    return { text: "", isError: true };
  } catch {
    // JSON でない＝機械可読フラグ非対応版とみなし、素の stdout を本文採用（フォールバック）。
    return { text: trimmed, isError: false };
  }
}

function spawnGemini(args: string[], promptStdin: string, timeoutMs: number): Promise<GenerateOutput> {
  return new Promise<GenerateOutput>((resolve, reject) => {
    const child = spawn("gemini", args, {
      shell: IS_WIN, // Windows は gemini.cmd を PATH から解決させる
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
      reject(new Error(`spawn gemini failed: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`gemini CLI timed out after ${timeoutMs}ms`));
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

    // プロンプトは stdin で渡す（argv クオート地獄を回避 / claude と同方針）。
    child.stdin.on("error", () => {
      /* EPIPE 等は無視（close で処理） */
    });
    child.stdin.write(promptStdin);
    child.stdin.end();
  });
}

/**
 * system プロンプトを stdin プロンプト先頭に畳み込む。
 * gemini CLI に `--append-system-prompt` 相当が無い版での代替（claude は argv で渡す）。
 */
function composePrompt(input: GenerateInput): string {
  if (input.system) {
    return `${input.system}\n\n${input.prompt}`;
  }
  return input.prompt;
}

export const geminiRunner: Runtime = {
  name: "gemini",

  async run(input: GenerateInput): Promise<GenerateOutput> {
    return spawnGemini(buildArgs(input), composePrompt(input), input.timeoutMs);
  },

  async checkAvailable(): Promise<{ ok: boolean; hint?: string }> {
    try {
      const out = await spawnGemini(["--version"], "", VERSION_TIMEOUT_MS);
      return out.exitCode === 0
        ? { ok: true }
        : { ok: false, hint: `gemini --version exit ${out.exitCode}` };
    } catch (e) {
      return { ok: false, hint: e instanceof Error ? e.message : String(e) };
    }
  },
};

// テスト用に純ロジックを named export（外部プロセス非依存）。
export { extractText, composePrompt, buildArgs };
