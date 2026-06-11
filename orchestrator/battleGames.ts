/**
 * S6 対戦評価の追加ゲーム集（じゃんけん以外の matchFn）。
 * 正本: orchestrator/battle.ts の MatchFn / jankenMatch（同形の純ロジックをここに増やす）。
 *
 * 方針（battle.ts と同じ譲れない条件）:
 * - **LLM を一切呼ばない純ロジック**。生成済み戦略同士の手を比較するだけ。
 * - **決定的**: Date.now / Math.random に依存しない。round 番号を play に渡すので、
 *   決定的 play がラウンドごとに手を変えられる（乱数が要るなら呼び出し側が seed 付き rng を閉じ込める）。
 * - **battle.ts の runRoundRobin にそのまま渡せる型**: MatchFn<S, M> を満たす named export。
 *   battle.ts は **編集せず**、ここに追加する（MatchFn / PlayFn / MatchOutcome を import type で借りる）。
 *
 * 提供物:
 *  (1) RPSLS（rock-paper-scissors-lizard-spock）: 手 Rpsls、優劣 rpslsCompare、MatchFn rpslsMatch。
 *  (2) Morra（モーラ簡易版）: 両者 1..5 を出し合計の偶奇で勝敗。手 Morra、比較 morraCompare、MatchFn morraMatch。
 */

import type { MatchFn, MatchOutcome, PlayFn } from "./battle.ts";

// 型を再エクスポートしない（battle.ts を唯一の真実源に保つ）。play 側で必要なら battle.ts から import する。
export type { MatchFn, MatchOutcome, PlayFn } from "./battle.ts";

// ───────── (1) RPSLS（rock-paper-scissors-lizard-spock）─────────

/** RPSLS の手（Sam Kass / Sheldon ルール）。 */
export type Rpsls = "rock" | "paper" | "scissors" | "lizard" | "spock";

/** 全 RPSLS の手（テスト・列挙の真実源）。 */
export const RPSLS_MOVES: readonly Rpsls[] = ["rock", "paper", "scissors", "lizard", "spock"];

/**
 * a が直接勝つ相手の集合（カノニカルな 10 関係）。
 * Scissors cut Paper, Paper covers Rock, Rock crushes Lizard, Lizard poisons Spock,
 * Spock smashes Scissors, Scissors decapitate Lizard, Lizard eats Paper, Paper disproves Spock,
 * Spock vaporizes Rock, Rock crushes Scissors.
 * 各手はちょうど 2 手に勝ち 2 手に負ける（対称・非引き分けは循環で決まる）。
 */
const RPSLS_BEATS: Readonly<Record<Rpsls, readonly Rpsls[]>> = {
  rock: ["scissors", "lizard"],
  paper: ["rock", "spock"],
  scissors: ["paper", "lizard"],
  lizard: ["spock", "paper"],
  spock: ["scissors", "rock"],
};

/** a が b に直接勝つか（RPSLS 優劣表）。同じ手は false（勝ちではない）。 */
function rpslsBeats(a: Rpsls, b: Rpsls): boolean {
  return RPSLS_BEATS[a].includes(b);
}

/**
 * 2 手を比較して勝敗を返す（1 手対 1 手）。同じ手なら "draw"。
 * RPSLS の最小単位。runRoundRobin の matchFn にラップして使う。
 */
export function rpslsCompare(a: Rpsls, b: Rpsls): MatchOutcome {
  if (a === b) return "draw";
  return rpslsBeats(a, b) ? "a" : "b";
}

/**
 * RPSLS 用の MatchFn。両者の play を round 番号付きの state で呼び、1 手で決着させる。
 * state は round 番号（決定的 play がラウンドごとに手を変えられるよう渡す）。jankenMatch と同形。
 */
export const rpslsMatch: MatchFn<number, Rpsls> = (a, b, round) => {
  const ma = a(round);
  const mb = b(round);
  return rpslsCompare(ma, mb);
};

// ───────── (2) Morra（モーラ簡易版）─────────

/**
 * Morra の手は出す指の本数 1..5。簡易ルールなので「合計の偶奇＋大小」で勝敗を決める
 * （本来の Morra は宣言した合計を当てるゲームだが、純ロジック・決定的・公平な評価器として
 *  最小化する。下の morraCompare 参照）。
 */
export type Morra = 1 | 2 | 3 | 4 | 5;

/** 合法な Morra の手（テスト・正規化の真実源）。 */
export const MORRA_MOVES: readonly Morra[] = [1, 2, 3, 4, 5];

/** 値が合法な Morra の手かどうか（型ガード）。1..5 の整数のみ。 */
export function isMorraMove(n: number): n is Morra {
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

/**
 * 2 手（指の本数）を比較して勝敗を返す。簡易ルール（公平＝反対称になるよう設計）:
 *  - 両者が同じ本数 → "draw"（鏡像は決着しない）。
 *  - 合計が偶数 → 本数が **大きい** 方の勝ち。
 *  - 合計が奇数 → 本数が **小さい** 方の勝ち。
 * 合計の偶奇は順序によらず（a+b=b+a）、大小は a/b を入れ替えると反転するので、
 * compare(a,b) と compare(b,a) は必ず互いに反転する＝どちらのプレイヤーにも構造的有利が無い。
 * 「合計の偶奇」という Morra 的味は残しつつ、座席(a/b)バイアスを排した最小決定的ルール。
 *
 * 範囲外の手（不正値）は clamp せず例外で決定的に早期失敗させる（評価の沈黙破綻を防ぐ）。
 * 評価を止めたくない呼び出し側は clampMorra で play を包んでから渡す。
 */
export function morraCompare(a: Morra, b: Morra): MatchOutcome {
  if (!isMorraMove(a) || !isMorraMove(b)) {
    throw new Error(`morraCompare: illegal Morra move (must be 1..5): a=${a}, b=${b}`);
  }
  if (a === b) return "draw";
  const sumEven = (a + b) % 2 === 0;
  const aIsBigger = a > b;
  // 偶数: 大きい方が勝ち / 奇数: 小さい方が勝ち。
  const aWins = sumEven ? aIsBigger : !aIsBigger;
  return aWins ? "a" : "b";
}

/**
 * Morra 用の MatchFn。両者の play を round 番号付きの state で呼び、合計の偶奇で決着させる。
 * state は round 番号（決定的 play がラウンドごとに本数を変えられるよう渡す）。jankenMatch と同形。
 */
export const morraMatch: MatchFn<number, Morra> = (a, b, round) => {
  const ma = a(round);
  const mb = b(round);
  return morraCompare(ma, mb);
};

/** 任意の PlayFn を「合法手だけ返す」ようにラップしたい呼び出し側のための補助（任意使用）。 */
export function clampMorra(play: PlayFn<number, number>): PlayFn<number, Morra> {
  return (round: number): Morra => {
    const raw = play(round);
    if (isMorraMove(raw)) return raw;
    // 不正値は最小の合法手 1 に丸める（決定的）。評価を止めたくない呼び出し側用。
    return 1;
  };
}
