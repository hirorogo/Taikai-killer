/**
 * じゃんけん数値パラメータ戦略の進化（D18 ① 数値最適化＝LLM不要 の実証）。
 * 正本: docs/decisions.md「進化（D18）①」/ docs/architecture.md S6「② 対戦型 win_rate」。
 *
 * ★スコープ: D18 ① の実証デモ。本番の進化ループには未配線で、orchestrator からの
 *   呼び出し配線は評価器 D3 が確定するまで行わない
 *   （directory-structure.md「評価器確定まで進化は起動しない」）。
 *
 * 何をするか:
 * - jankenStrategy の {rock,paper,scissors} 重みを numericOptimizer（ヒルクライム）で進化させる。
 * - **評価関数＝固定相手群との対戦勝率（win_rate）**（architecture.md S6 ② 対戦型）。
 *   これは LLM 非依存の純評価関数。「対戦させて勝った戦略のパラメータを数万回チューニング」を回す。
 *
 * 譲れない条件:
 * - **LLM を一切呼ばない**。すべて普通のコード（最適化＋対戦シミュレーション）。
 * - **決定的（seed 固定で完全再現）**。乱数は numericOptimizer.createRng のみ。Date.now/Math.random 非依存。
 *   対戦で使う乱数の seed も opts.seed から決定的に導出する（同 opts → 同 win_rate）。
 *
 * 対戦器の合成方針（重複排除）:
 * - 1手の決着と総当たりの集計は orchestrator/battle.ts の jankenMatch / runRoundRobin を
 *   そのまま再利用する（共有ファイルは編集せず import のみで合成）。優劣表・対戦ループを
 *   ここで再実装しない（評価器 battle.ts と進化器でロジックが食い違う二重メンテを防ぐ）。
 * - ただし評価形は battle.ts の総当たり結果（win_rate = wins/全試合, draw は敗扱い）ではなく、
 *   **固定相手群それぞれに対する 1対1 win_rate の平均（draw=0.5 換算）**を採る。これは
 *   「進化対象 1 体 vs 固定相手 N 体」という非対称設定で「最適応答が突けているか」を測るため、
 *   対称な総当たり集計ではなく相手ごとの 2 体 round-robin（rounds=roundsPerMatch）を回し、
 *   その record から draw=0.5 換算の勝率を取り出している（runRoundRobin の対戦実体は共有）。
 */
import { optimize, createRng } from "./numericOptimizer.ts";
import type { Params, OptimizeResult } from "./numericOptimizer.ts";
import { makeJankenPlayer } from "./jankenStrategy.ts";
import type { JankenParams } from "./jankenStrategy.ts";
// 対戦実体（1手決着＋総当たり集計）は battle.ts を再利用（共有・編集禁止）。
import { runRoundRobin, jankenMatch } from "../orchestrator/battle.ts";
import type { Janken } from "../orchestrator/battle.ts";

/** 固定相手の1体。識別子＋その戦略パラメータ（重み）。 */
export interface JankenOpponent {
  id: string;
  params: JankenParams;
}

/** evolveJanken のオプション。すべて決定性に寄与（seed 固定で完全再現）。 */
export interface EvolveJankenOptions {
  /** 進化させる初期パラメータ（重み）。破壊しない。 */
  initial: JankenParams;
  /** 固定相手群（この全員に対する総合勝率を最大化する）。空なら勝率は 0 とみなす。 */
  opponents: JankenOpponent[];
  /** 1 対戦あたりのラウンド数（多いほど勝率推定が安定）。既定 200。 */
  roundsPerMatch?: number;
  /** 最適化の反復回数（= 近傍評価回数）。既定 300。 */
  iterations?: number;
  /** 擬似乱数 seed（固定で完全再現）。既定 1。 */
  seed?: number;
  /** 近傍ステップ幅スケール。既定 0.3。 */
  stepScale?: number;
  /** 連続停滞でリスタートする閾値（多峰性対策）。未指定なら純ヒルクライム。 */
  restartAfter?: number;
}

/** evolveJanken の結果。初期と最良を並べて「上がったか」を検証可能にする。 */
export interface EvolveJankenResult {
  /** 進化後の最良パラメータ。 */
  bestParams: JankenParams;
  /** 最良パラメータの固定相手群への総合勝率（0..1）。 */
  bestWinRate: number;
  /** 初期パラメータの固定相手群への総合勝率（0..1）。比較基準。 */
  initialWinRate: number;
  /** numericOptimizer の生結果（履歴・評価回数・リスタート数）。 */
  optimize: OptimizeResult;
}

/**
 * 1試合（roundsPerMatch ラウンド）の player 視点 勝率を返す。draw は 0.5 換算。
 *
 * 対戦実体は battle.ts の runRoundRobin + jankenMatch を再利用する（優劣表・対戦ループを
 * 自前で持たない）。player と opponent を 2 体の participant として総当たり（実質 1 ペア）に
 * 投入し、roundsPerMatch ラウンド対戦させて player の record を取り出す。
 * runRoundRobin の win_rate は draw を敗扱い（wins/全試合）なので、draw=0.5 換算の
 * 本評価形は record から自前で算出する。
 */
export function matchWinRate(
  playerParams: JankenParams,
  opponentParams: JankenParams,
  roundsPerMatch: number,
  matchSeed: number,
): number {
  const rounds = Math.max(1, Math.trunc(roundsPerMatch));
  // player と opponent で独立した乱数系列を持たせる（seed をずらして相関を避ける）。
  // rng は各 play クロージャに閉じ込めるので、battle.ts は Math.random 非依存のまま決定的。
  const playerRng = createRng(matchSeed);
  const opponentRng = createRng(matchSeed ^ 0x9e3779b9);
  const playerPlay = makeJankenPlayer(playerParams, playerRng);
  const opponentPlay = makeJankenPlayer(opponentParams, opponentRng);

  const rr = runRoundRobin<number, Janken>(
    [
      { id: "player", play: playerPlay },
      { id: "opponent", play: opponentPlay },
    ],
    jankenMatch,
    rounds,
  );
  const playerResult = rr.results.find((r) => r.id === "player");
  if (playerResult === undefined) {
    return 0; // 実際には起こらない（必ず player が結果に含まれる）。
  }
  const { wins, draws } = playerResult.record;
  // draw を 0.5 勝として win_rate に算入（1対1 評価の慣習）。分母は実施ラウンド数。
  return (wins + draws * 0.5) / rounds;
}

/**
 * player パラメータの「固定相手群 全員」に対する総合勝率（= 各試合勝率の平均）。
 * これが評価関数の本体（architecture.md S6 ② win_rate）。LLM 非依存・決定的。
 *
 * @param baseSeed 各対戦の seed をここから決定的に導出（同 baseSeed → 同 win_rate）。
 */
export function overallWinRate(
  playerParams: JankenParams,
  opponents: JankenOpponent[],
  roundsPerMatch: number,
  baseSeed: number,
): number {
  if (opponents.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < opponents.length; i++) {
    const opp = opponents[i];
    if (opp === undefined) {
      continue; // noUncheckedIndexedAccess 対策（実際には起こらない）。
    }
    // 相手ごとに seed をずらして決定的に分散（順序固定で再現性を保つ）。
    const matchSeed = (baseSeed + i * 0x1000193) >>> 0;
    sum += matchWinRate(playerParams, opp.params, roundsPerMatch, matchSeed);
  }
  return sum / opponents.length;
}

/** Params(Record<string,number>) → JankenParams（欠損は 0）。 */
function toJankenParams(p: Params): JankenParams {
  return {
    rock: p["rock"] ?? 0,
    paper: p["paper"] ?? 0,
    scissors: p["scissors"] ?? 0,
  };
}

/** JankenParams → Params（numericOptimizer に渡す形）。 */
function toParams(p: JankenParams): Params {
  return { rock: p.rock, paper: p.paper, scissors: p.scissors };
}

/**
 * じゃんけんの数値パラメータ戦略を進化させ、固定相手群への勝率を最大化する。
 *
 * - **LLM を呼ばない**。numericOptimizer（ヒルクライム）＋ 自前対戦器のみ。
 * - **seed 固定で完全再現**（評価関数も seed 由来で決定的）。
 *
 * @returns 初期勝率と進化後勝率を含む結果（「上がったか / 同等以上か」を呼び出し側で検証可能）。
 */
export async function evolveJanken(opts: EvolveJankenOptions): Promise<EvolveJankenResult> {
  const roundsPerMatch = opts.roundsPerMatch ?? 200;
  const iterations = opts.iterations ?? 300;
  const seed = opts.seed ?? 1;
  const stepScale = opts.stepScale ?? 0.3;
  // 評価用の baseSeed は最適化 seed と分離（探索の乱数と評価の乱数を混ぜない）。
  const evalBaseSeed = (seed ^ 0x5bd1e995) >>> 0;

  // 評価関数: パラメータ → 固定相手群への総合勝率（大きいほど良い＝max 方向。optimizer と整合）。
  const evaluate = async (p: Params): Promise<number> => {
    return overallWinRate(toJankenParams(p), opts.opponents, roundsPerMatch, evalBaseSeed);
  };

  const initialWinRate = await evaluate(toParams(opts.initial));

  const optimizeOpts =
    opts.restartAfter !== undefined
      ? { iterations, seed, stepScale, restartAfter: opts.restartAfter }
      : { iterations, seed, stepScale };

  const result = await optimize(toParams(opts.initial), evaluate, optimizeOpts);

  return {
    bestParams: toJankenParams(result.best),
    bestWinRate: result.bestScore,
    initialWinRate,
    optimize: result,
  };
}
