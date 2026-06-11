/**
 * フェーズ×モデル割当・CB閾値・予算・進化ハイパラの正本（PhaseConfig）。
 * 数値はここに集約（docs に散らさない）。MVP の最小値のみ。
 */

export interface PhaseConfig {
  phase: string;
  promptPath: string;
  model: "claude" | "gemini";
  toolAllow: string[]; // 集中力ガード（推論品質のため）
  timeoutMs: number;
  maxAttempts?: number; // S5 の D22 ループ上限
}

/** Circuit Breaker しきい値（speca 流用）。 */
export const CB = {
  consecutiveFailures: 5,
  totalRetries: 20,
  consecutiveEmptyResults: 3,
} as const;

/** 縦串MVP のフェーズ定義（S2/S4 は薄くスキップ）。 */
export const MVP_PHASES: Record<string, PhaseConfig> = {
  S1: { phase: "S1", promptPath: "prompts/S1_rules.md", model: "claude", toolAllow: ["Read"], timeoutMs: 60_000 },
  S3: { phase: "S3", promptPath: "prompts/S3_strategy.md", model: "claude", toolAllow: ["Read"], timeoutMs: 120_000 },
  S5: {
    phase: "S5",
    promptPath: "prompts/S5_selfimprove.md",
    model: "claude",
    toolAllow: ["Read", "Write"],
    timeoutMs: 180_000,
    maxAttempts: 3, // D22 Reflexion ループ
  },
  S6: { phase: "S6", promptPath: "", model: "claude", toolAllow: [], timeoutMs: 120_000 },
};
