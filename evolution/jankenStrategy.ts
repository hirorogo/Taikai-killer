/**
 * じゃんけんの数値パラメータ戦略（D18 ① 数値最適化トラックの実証用）。
 * 正本: docs/decisions.md「進化（D18）①数値最適化＝LLM不要」/
 *       docs/architecture.md S6「② 対戦型（battle / win_rate）」/
 *       docs/directory-structure.md「D18 注（2トラック分離）①」。
 *
 * ★スコープ: これは D18 ① の実証デモ。本番の進化ループには未配線で、
 *   orchestrator からの呼び出し配線は評価器 D3 が確定するまで行わない
 *   （directory-structure.md「評価器確定まで進化は起動しない」）。
 *
 * 方針（譲れない条件）:
 * - **LLM を一切呼ばない**。手の選択は数値パラメータ {rock,paper,scissors}（重み）だけで決まる。
 * - **決定的**: seed 付き擬似乱数（numericOptimizer.ts の createRng）を注入し、同 seed → 同系列。
 *   Date.now / Math.random には依存しない。
 * - 重みは numericOptimizer が任意の実数（負含む）に動かしうるため、選択側で頑健に正規化する
 *   （負・NaN・全0 でも必ず合法な手を返す）。これが無いと最適化の探索で例外死する。
 * - **勝敗ロジックは再実装しない**: 優劣表は orchestrator/battle.ts の jankenCompare が唯一の正。
 *   ここの judge はその薄いアダプタ（a/b/draw → win/loss/draw 変換）に過ぎず、表を持たない。
 *   こうして「優劣表が将来 battle.ts 側だけ直されて評価器と進化器が食い違う」二重メンテを防ぐ。
 */

// 優劣表の唯一の正は orchestrator/battle.ts（共有・編集禁止、import のみで合成）。
import { jankenCompare } from "../orchestrator/battle.ts";
import type { Janken, MatchOutcome } from "../orchestrator/battle.ts";

/** じゃんけんの手（battle.ts の Janken と同一。エイリアスで再公開）。 */
export type Move = Janken;

/** 1手の対戦結果（player 視点）。 */
export type Outcome = "win" | "loss" | "draw";

/** 手の固定順序（決定性のため挿入順でなくこの順に固定）。 */
export const MOVES: readonly Move[] = ["rock", "paper", "scissors"] as const;

/**
 * 戦略パラメータ。各手の「重み」。大きいほどその手を出しやすい。
 * numericOptimizer.Params（Record<string,number>）と互換のキーを持つ。
 */
export interface JankenParams {
  rock: number;
  paper: number;
  scissors: number;
}

/** 1手を返すプレイヤー。引数なし（状態は rng クロージャに閉じ込める）。 */
export type JankenPlayer = () => Move;

/**
 * 重みを「非負かつ合計1」の確率分布に正規化する。
 * - 非有限・負は 0 に丸める（探索が負へ振れても合法に保つ）。
 * - 全て 0（または非有限）なら一様分布にフォールバック（必ず合法な手を出せる）。
 */
export function normalizeWeights(params: JankenParams): Record<Move, number> {
  const raw: Record<Move, number> = {
    rock: cleanWeight(params.rock),
    paper: cleanWeight(params.paper),
    scissors: cleanWeight(params.scissors),
  };
  const total = raw.rock + raw.paper + raw.scissors;
  if (total <= 0) {
    // 全 0 → 一様。決定性を保ちつつ常に合法。
    return { rock: 1 / 3, paper: 1 / 3, scissors: 1 / 3 };
  }
  return {
    rock: raw.rock / total,
    paper: raw.paper / total,
    scissors: raw.scissors / total,
  };
}

/** 負・非有限を 0 に丸めた重み。 */
function cleanWeight(w: number): number {
  return Number.isFinite(w) && w > 0 ? w : 0;
}

/**
 * パラメータ＋seed付き乱数から決定的なじゃんけんプレイヤーを作る。
 *
 * - rng は [0,1) を返す決定的乱数（numericOptimizer.createRng を渡す想定）。
 *   同一 rng 系列 → 同一の手の列（再現性◎）。
 * - 重みを確率分布に正規化し、rng のドローで手を選ぶ（混合戦略）。
 *   累積分布の境界は MOVES 順に固定（決定性）。
 *
 * @param params 戦略パラメータ（重み）。破壊しない。
 * @param rng    [0,1) を返す決定的乱数生成器。
 */
export function makeJankenPlayer(params: JankenParams, rng: () => number): JankenPlayer {
  const dist = normalizeWeights(params);
  // 累積しきい値を MOVES 順に事前計算（毎手の分岐を固定）。
  const cumulative: { move: Move; upTo: number }[] = [];
  let acc = 0;
  for (const move of MOVES) {
    acc += dist[move];
    cumulative.push({ move, upTo: acc });
  }
  return function play(): Move {
    const r = rng();
    for (const entry of cumulative) {
      if (r < entry.upTo) {
        return entry.move;
      }
    }
    // 浮動小数の誤差で全しきい値を超えた場合の安全弁（最後の手）。
    return MOVES[MOVES.length - 1] as Move;
  };
}

/**
 * player の手が opponent の手に対して勝ち/負け/引き分けかを返す（player 視点）。
 * 優劣表は持たず、battle.ts の jankenCompare（a=第1引数勝ち）の結果を
 * player 視点の win/loss/draw に写すだけ（唯一の優劣表を共有）。
 */
export function judge(playerMove: Move, opponentMove: Move): Outcome {
  const outcome: MatchOutcome = jankenCompare(playerMove, opponentMove);
  if (outcome === "draw") {
    return "draw";
  }
  // jankenCompare は第1引数(=player)が勝つと "a" を返す。
  return outcome === "a" ? "win" : "loss";
}
