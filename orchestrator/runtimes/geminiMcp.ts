/**
 * Gemini MCP/ACP 経路の検証スタブ（D4 補論）。詳細な検証記録は docs/gemini-mcp.md。
 *
 * 背景: ユーザー要望「gemini を MCP として動かせば（認証問題が）解決できる」。
 * geminiRunner（CLI 直叩き）は認証未設定だと `error.code=41` を返す（実機確認済み）。
 *
 * ✅ 実機検証の結論（gemini CLI v0.41.2, 2026-06-11）— 詳細出力は docs/gemini-mcp.md:
 * - `gemini mcp` は **gemini を MCP クライアント（ホスト）にする**サブコマンド群
 *   （add/remove/list/enable/disable）。**gemini を MCP サーバとして公開する機能ではない。**
 *   `gemini mcp serve` 等は存在しない。
 * - `gemini --acp` は gemini を **ACP（Agent Client Protocol）エージェント**として stdio で起動する。
 *   MCP とは別プロトコル（IDE/エディタ統合用）。MCP ツールとして orchestrator から呼ぶ口ではない。
 * - gemini を「MCP サーバ」として Claude/orchestrator から呼ぶには **コミュニティ製ラッパ**
 *   （例: gemini-cli-mcp）が必要で、その実体は内部で同じ `gemini -p` を spawn するだけ。
 *
 * ⛔ 重要結論: **MCP/ACP は認証問題を解決しない。**
 *   ラッパ越しでも最終的に同じ `gemini` バイナリを起動するため、認証が無ければ同じ
 *   `error.code=41`（"Please set an Auth method ... GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI,
 *   GOOGLE_GENAI_USE_GCA"）が中で発生する。MCP は transport であって credential ではない。
 *   → 認証は (a) 対話 OAuth ログイン（無料枠/Code Assist）, (b) GEMINI_API_KEY,
 *     (c) GOOGLE_GENAI_USE_GCA（Code Assist サブスク経路）+ 必要なら GOOGLE_CLOUD_PROJECT,
 *     (d) GOOGLE_GENAI_USE_VERTEXAI のいずれかを **CLI 側に与える**ことでしか解けない。
 *
 * したがって本ファイルは「動くフリ」をせず、Runtime 互換の **薄い checkAvailable のみ**を提供する。
 * 既存の純生成は geminiRunner（CLI subprocess 型）を正とし、MCP 経路は本スタブで availability/
 * 認証レディネスを診断するに留める（実 dispatch は将来ラッパが安定したら追加）。
 */
import { spawn } from "node:child_process";
import type { GenerateInput, GenerateOutput, Runtime } from "../runtimeRegistry.ts";

const IS_WIN = process.platform === "win32";

/** checkAvailable 用の軽量 timeout（claudeRunner/geminiRunner と同値）。 */
const VERSION_TIMEOUT_MS = 15_000;

/**
 * gemini CLI が受け付ける認証環境変数（実機の error.code=41 メッセージが列挙する3種）。
 * OAuth 対話ログイン（~/.gemini/oauth_creds.json）はこれらとは別経路だが、本スタブの env 判定は
 * 「無認証で 41 になる」状態を早期に説明するためのもの（OAuth 済みかは env では判らない）。
 */
export const GEMINI_AUTH_ENV_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GENAI_USE_GCA",
] as const;

/** 環境に認証 env が1つでも与えられているか（純ロジック・テスト可能）。 */
export function hasAuthEnv(env: NodeJS.ProcessEnv): boolean {
  return GEMINI_AUTH_ENV_VARS.some((k) => {
    const v = env[k];
    return typeof v === "string" && v.trim() !== "";
  });
}

/**
 * gemini CLI の出力/stderr が「認証未設定（code=41）」かを判定（純ロジック・テスト可能）。
 * JSON（`{ error: { code: 41 } }`）と素テキストの両方を見る。MCP/ACP ラッパ越しでも
 * 最終的にこの 41 が表面化するため、診断メッセージを一意化する。
 */
export function isAuthError(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  try {
    const obj = JSON.parse(text) as { error?: { code?: unknown } };
    if (obj.error && obj.error.code === 41) return true;
  } catch {
    /* JSON でなければテキスト走査にフォールバック */
  }
  return /Please set an Auth method/i.test(text) || /\bcode["\s:]*41\b/.test(text);
}

function spawnGemini(args: string[], stdin: string, timeoutMs: number): Promise<GenerateOutput> {
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
      resolve({
        text: "",
        raw: stdout || stderr,
        exitCode: code ?? -1,
        emptyResult: stdout.trim() === "",
      });
    });

    child.stdin.on("error", () => {
      /* EPIPE 等は無視（close で処理） */
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Gemini MCP 経路 Runtime スタブ。
 *
 * - name は registry の `"claude" | "gemini"` と衝突しないよう **登録しない**前提の検証用。
 *   （runtimeRegistry の Runtime.name 型は2値に固定のため、本スタブは register() に渡さず
 *    単体診断ユーティリティとして使う。実 dispatch を正式採用する際は registry 拡張＋
 *    ラッパ接続コードを別途実装する。）
 * - run() は **意図的に未実装**。MCP/ACP が認証を解決しない以上、geminiRunner と二重化させない。
 */
export const geminiMcp = {
  name: "gemini-mcp" as const,

  /**
   * 実 dispatch は未提供。MCP/ACP 経路は認証を解決しないため、純生成は geminiRunner を使う。
   * 将来コミュニティ製 MCP ラッパ（gemini-cli-mcp 等）を採用したらここに stdio JSON-RPC 接続を実装する。
   */
  async run(_input: GenerateInput): Promise<GenerateOutput> {
    void _input;
    throw new Error(
      "geminiMcp.run() は未実装: MCP/ACP は認証問題を解決しないため、純生成は geminiRunner を使用。" +
        " 詳細は docs/gemini-mcp.md。",
    );
  },

  /**
   * availability 自己診断。CLI 存在（--version）に加え、認証 env レディネスも報告する
   * （MCP/ACP 越しでも未認証なら同じ code=41 で詰まるため、ここで先に可視化する）。
   */
  async checkAvailable(): Promise<{ ok: boolean; hint?: string }> {
    try {
      const out = await spawnGemini(["--version"], "", VERSION_TIMEOUT_MS);
      if (out.exitCode !== 0) {
        return { ok: false, hint: `gemini --version exit ${out.exitCode}` };
      }
      if (!hasAuthEnv(process.env)) {
        return {
          ok: false,
          hint:
            "gemini CLI は存在するが認証 env 未設定（GEMINI_API_KEY / GOOGLE_GENAI_USE_VERTEXAI /" +
            " GOOGLE_GENAI_USE_GCA のいずれか、または対話 OAuth ログインが必要）。" +
            " MCP/ACP 経路でもこの認証は解決しない。docs/gemini-mcp.md 参照。",
        };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, hint: e instanceof Error ? e.message : String(e) };
    }
  },
} satisfies Omit<Runtime, "name"> & { name: "gemini-mcp" };
