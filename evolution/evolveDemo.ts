/**
 * D18 ①（数値最適化＝LLM 不要）の end-to-end デモ。
 * 正本: docs/decisions.md「進化（D18）①数値最適化＝LLM不要」/
 *       docs/architecture.md S6「② 対戦型（battle / win_rate）」。
 *
 * 何をするか:
 * - じゃんけんの数値パラメータ戦略 {rock,paper,scissors}（重み）を、固定相手群への
 *   対戦勝率（win_rate）を評価関数として numericOptimizer（ヒルクライム）で進化させる。
 * - 本体の最適化・対戦・評価は evolution/jankenEvolve.ts（→ numericOptimizer.ts /
 *   jankenStrategy.ts / orchestrator/battle.ts）に委譲する。**薄いラッパ**であり、
 *   最適化ループ・対戦器・優劣表をここで再実装しない（二重メンテ防止＝車輪の再発明禁止）。
 *
 * このデモが追加する value:
 * - 「固定相手群」を関数で内蔵（既定: 常に rock / cycle / paper・scissors 偏重）。
 *   呼び出し側が相手を用意しなくても 1 行で end-to-end が回る。
 * - 戻り値を「初期 vs 進化後」を素直に並べた形 {initialParams, initialWinRate,
 *   evolvedParams, evolvedWinRate, improved} に整える（デモ／検証で読みやすい）。
 *
 * 譲れない条件:
 * - **LLM を一切呼ばない**。すべて普通のコード（最適化＋対戦シミュレーション）。
 * - **決定的（seed 固定で完全再現）**。乱数は numericOptimizer.createRng のみ。
 *   Date.now / Math.random には依存しない（jankenEvolve が保証する性質をそのまま継承）。
 */

import { evolveJanken } from "./jankenEvolve.ts";
import type { JankenOpponent } from "./jankenEvolve.ts";
import type { JankenParams } from "./jankenStrategy.ts";

/** evolveJankenDemo のオプション。すべて決定性に寄与（seed 固定で完全再現）。 */
export interface EvolveDemoOptions {
  /** 擬似乱数 seed（固定で完全再現）。 */
  seed: number;
  /** 最適化の反復回数（= 近傍評価回数）。 */
  iterations: number;
  /**
   * 固定相手群。未指定なら内蔵の既定相手群（defaultOpponents）を使う。
   * 空配列を渡すと勝率は 0 とみなされる（jankenEvolve の仕様）。
   */
  opponents?: JankenOpponent[];
  /** 進化させる初期パラメータ（重み）。未指定なら一様（rock=paper=scissors=1）。 */
  initial?: JankenParams;
  /** 1 対戦あたりのラウンド数（多いほど勝率推定が安定）。既定 300。 */
  roundsPerMatch?: number;
  /** 近傍ステップ幅スケール。既定 0.4。 */
  stepScale?: number;
}

/** evolveJankenDemo の結果。初期と進化後を素直に並べる（デモ／検証で読みやすい形）。 */
export interface EvolveDemoResult {
  /** 進化前の初期パラメータ（重み）。 */
  initialParams: JankenParams;
  /** 初期パラメータの固定相手群への総合勝率（0..1）。比較基準。 */
  initialWinRate: number;
  /** 進化後の最良パラメータ（重み）。 */
  evolvedParams: JankenParams;
  /** 進化後パラメータの固定相手群への総合勝率（0..1）。 */
  evolvedWinRate: number;
  /** 進化後勝率が初期勝率を厳密に上回ったか（同等は false）。 */
  improved: boolean;
}

/** 一様分布（rock=paper=scissors）。デモの既定の初期パラメータ。 */
const UNIFORM: JankenParams = { rock: 1, paper: 1, scissors: 1 };

/**
 * デモ用の固定相手群を返す（関数で内蔵。LLM 非依存・純データ）。
 *
 * 顔ぶれ（最適応答が分かりやすいよう偏らせてある）:
 * - always-rock: 常にグー（最適応答＝パー）。デモの主役（進化後にパー寄りになる）。
 * - rock-heavy: グー偏重（ゆるめ）。
 * - cycle-ish: 三手をならす（rock/paper/scissors を均等に近く）。混合戦略の相手。
 * - paper-heavy: パー偏重（最適応答＝チョキ）。単一相手に過適合しないよう逆向きも混ぜる。
 * - scissors-heavy: チョキ偏重（最適応答＝グー）。
 *
 * 注: パラメータは jankenStrategy.normalizeWeights で「非負・合計1」に正規化されるので、
 *     ここでは相対的な重みだけ与えればよい（0 は「その手を出さない」を意味する）。
 */
export function defaultOpponents(): JankenOpponent[] {
  return [
    { id: "always-rock", params: { rock: 1, paper: 0, scissors: 0 } },
    { id: "rock-heavy", params: { rock: 6, paper: 1, scissors: 1 } },
    { id: "cycle-ish", params: { rock: 1, paper: 1, scissors: 1 } },
    { id: "paper-heavy", params: { rock: 1, paper: 6, scissors: 1 } },
    { id: "scissors-heavy", params: { rock: 1, paper: 1, scissors: 6 } },
  ];
}

/**
 * D18 ① の end-to-end デモ: じゃんけんの数値パラメータ戦略を、固定相手群への
 * 対戦勝率を最大化するよう進化させる。**LLM を呼ばない・seed 固定で決定的**。
 *
 * 実体は evolveJanken に委譲（最適化・対戦・評価の再実装はしない）。本関数は
 * 「相手群の内蔵」と「初期 vs 進化後を並べた戻り値整形」だけを足す薄いラッパ。
 *
 * @returns {initialParams, initialWinRate, evolvedParams, evolvedWinRate, improved}
 */
export async function evolveJankenDemo(opts: EvolveDemoOptions): Promise<EvolveDemoResult> {
  const initial = opts.initial ?? UNIFORM;
  const opponents = opts.opponents ?? defaultOpponents();
  const roundsPerMatch = opts.roundsPerMatch ?? 300;
  const stepScale = opts.stepScale ?? 0.4;

  const res = await evolveJanken({
    initial,
    opponents,
    roundsPerMatch,
    iterations: opts.iterations,
    seed: opts.seed,
    stepScale,
  });

  return {
    initialParams: initial,
    initialWinRate: res.initialWinRate,
    evolvedParams: res.bestParams,
    evolvedWinRate: res.bestWinRate,
    // 厳密に上回った時だけ improved=true（同等は false。jankenEvolve は厳密改善のみ採用）。
    improved: res.bestWinRate > res.initialWinRate,
  };
}
