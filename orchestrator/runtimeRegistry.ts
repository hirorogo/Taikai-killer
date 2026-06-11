/**
 * マルチモデル統一層（D19/D4）。Claude/Gemini の CLI runner を登録。
 * 移植元: dashboard/server/services/chat_runtime_cli.py（vendor済み speca, Python→TS）。
 * MVP は Claude 1モデルのみ実装。codex/ollama/copilot は将来（未実装は exit 2）。
 */

export interface GenerateInput {
  system?: string;
  prompt: string;
  timeoutMs: number;
}
export interface GenerateOutput {
  text: string; // CLI の機械可読出力から抽出した本文
  raw: string; // 生 stdout（監査用）
  exitCode: number;
  emptyResult: boolean; // returncode 0 でも実質空か（E_LLM_COMM）
}

/** 1つの runtime（CLI subprocess 型）。 */
export interface Runtime {
  name: "claude" | "gemini";
  /** プロンプト投入→機械可読出力。各 subprocess にハード timeout 必須。 */
  run(input: GenerateInput): Promise<GenerateOutput>;
  /** availability 自己診断（--list-runtimes 相当）。 */
  checkAvailable(): Promise<{ ok: boolean; hint?: string }>;
}

const registry = new Map<string, Runtime>();

export function register(rt: Runtime): void {
  registry.set(rt.name, rt);
}

export function resolve(name: string): Runtime {
  const rt = registry.get(name);
  if (!rt) {
    // 未実装 runtime は silent fallback でなく fail-fast（D4）
    console.error(`[runtimeRegistry] runtime "${name}" は未登録/未実装`);
    process.exit(2);
  }
  return rt;
}

/** Reflexion ループ等が共有する1 seam（D22）。 */
export function runCLISubprocess(model: string, input: GenerateInput): Promise<GenerateOutput> {
  return resolve(model).run(input);
}
