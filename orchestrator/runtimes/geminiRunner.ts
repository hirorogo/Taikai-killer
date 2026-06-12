/**
 * Gemini CLI runner（CLI subprocess 型 / D4）。
 * 移植元: dashboard/server/services/chat_runtime_gemini.py（speca, Python→TS）。
 * 構造は claudeRunner.ts と同形に揃える（spawn / stdin プロンプト / ハード timeout / 本文抽出 / --version 存在確認）。
 *
 * ✅ 実機検証済み（gemini CLI v0.41.2, 2026-06-13 再検証）:
 * - 非対話: `-p ""` ＋ プロンプトは stdin（`-p` の値は stdin 入力に追記される仕様＝空にして純 stdin）。
 * - 機械可読: `-o json`。成功時 `{ "response": "<text>", "stats": {...}, "session_id": ... }`、
 *   エラー時 `{ "session_id": ..., "error": { "type", "message", "code" } }`（認証未設定は code=41）。
 * - 自動承認: `--approval-mode yolo`（ツール確認を出さない・純生成では未使用）。
 * - ⚠ **Windows の spawn 作法（重要・2026-06-13 修正）**: `shell:true` は空文字引数 `-p ""` を連結時に
 *   落とし「Not enough arguments following: p」で実発火しなかった。`cmd.exe /c gemini …args`（shell:false・
 *   明示 args 配列）に変更して空引数を保つ（実機で認証 error.code=41 まで到達を確認）。spawnGemini 参照。
 * - ⚠ 認証は別途必要: GEMINI_API_KEY / GOOGLE_GENAI_USE_GCA(Gemini Code Assist=サブスク) 等。
 *   未設定だと error.code=41 を返す（`taikai probe-gemini` が明示）。checkAvailable は `--version` の
 *   存在確認のみで認証は見ない。
 * - ⚠ `--approval-mode yolo` は「folder not trusted」だと既定に上書きされる（ツール使用フェーズで要注意。
 *   純生成は影響なし）。
 */
import { spawn } from "node:child_process";
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

const IS_WIN = process.platform === "win32";

/**
 * ✅ 実機検証済みフラグ（gemini v0.41.2）。
 * `-p ""`（非対話・プロンプトは stdin）/ `-o json`（機械可読）/ `--approval-mode yolo`（自動承認）。
 */
const GEMINI_NONINTERACTIVE_FLAGS = ["-p", "", "-o", "json", "--approval-mode", "yolo"] as const;

/** checkAvailable 用の軽量 timeout（claudeRunner と同値）。 */
const VERSION_TIMEOUT_MS = 15_000;

function buildArgs(input: GenerateInput): string[] {
  // 非対話・機械可読・自動承認（実機検証済み）。
  const args: string[] = [...GEMINI_NONINTERACTIVE_FLAGS];
  // ツールは MVP では使わない（純生成）。gemini は allowed-tools が deprecated→Policy Engine 移行のため、
  // 許可制御が要るフェーズでは --policy を使う（現状は未指定＝既定でツール確認なし＝yolo）。
  void input.allowedTools;
  // system は composePrompt で stdin 先頭に畳み込む（gemini は --append-system-prompt 相当が無い）。
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

/**
 * gemini CLI の機械可読エラー（{session_id, error:{type,message,code}}）を raw 出力から抽出する。純ロジック。
 * 認証未設定は stdout が空で **stderr 側に**この JSON が出る（警告行が前置されるため、最初の `{` から
 * 最後の `}` までを切り出してパースする）。error フィールドが無ければ null（＝エラーでない/構造未知）。
 */
function parseGeminiError(raw: string): { code?: number; message?: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const err = (obj as Record<string, unknown>)["error"];
  if (typeof err !== "object" || err === null) return null;
  const e = err as Record<string, unknown>;
  const out: { code?: number; message?: string } = {};
  if (typeof e["code"] === "number") out.code = e["code"];
  if (typeof e["message"] === "string") out.message = e["message"];
  return out;
}

function spawnGemini(args: string[], promptStdin: string, timeoutMs: number): Promise<GenerateOutput> {
  return new Promise<GenerateOutput>((resolve, reject) => {
    // Windows: gemini は gemini.cmd。**shell:true は空文字引数（`-p ""`）を連結で落とす**ため使えない
    // （v0.41.2 で「Not enough arguments following: p」になり実発火しなかった）。cmd.exe /c に明示 args
    // 配列で渡すと空引数が保たれる（実機検証: 認証 error.code=41 まで到達＝引数解釈は正しい）。
    // 非 Windows: gemini は実行可能ファイルなので直接 spawn（shell 不要・空引数も保たれる）。
    const child = IS_WIN
      ? spawn("cmd.exe", ["/c", "gemini", ...args], { windowsHide: true })
      : spawn("gemini", args, { windowsHide: true });

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
      const empty = text.trim() === "";
      // 空のときは機械可読エラー（認証 code=41 等）を stdout/stderr から拾って診断に載せる。
      const out: GenerateOutput = {
        text,
        raw: stdout || stderr,
        exitCode: code ?? -1,
        emptyResult: empty,
      };
      if (empty) {
        const err = parseGeminiError(stdout) ?? parseGeminiError(stderr);
        if (err?.code !== undefined) out.errorCode = err.code;
        if (err?.message !== undefined) out.errorMessage = err.message;
      }
      resolve(out);
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
export { extractText, composePrompt, buildArgs, parseGeminiError };
