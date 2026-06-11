/**
 * S6 対戦評価（②対戦型 / architecture.md「S6 の2評価モード」/ BenchResult.battle）。
 * 正本: docs/architecture.md「S6 の2評価モード」表②、orchestrator/types.ts BenchResult.battle。
 *
 * 方針（譲れない条件）:
 * - **LLM を一切呼ばない純ロジック**。生成済みプログラム（戦略）同士を実際に対戦させ、
 *   勝率で採点する評価関数。数値最適化トラック（D18 ①）の評価器にそのまま使える。
 * - **決定的**: Date.now / Math.random には依存しない。乱数が要るゲームは seed 付き擬似乱数を
 *   自前で渡す（evolution/numericOptimizer.ts と同じ mulberry32）。同一入力→同一結果。
 * - **総当たり（round-robin）**: 各 participant が他全員と対戦し、{wins,losses,draws} と win_rate を集計。
 * - 戻り値は **BenchResult.battle 形**（opponents / record / format）に詰められる型にする。
 *
 * 用途: 「対戦させて勝った戦略のいいとこを交叉／パラメータを数万回チューニング」が回るよう、
 * 評価器を LLM 非依存・決定的にしておく（architecture.md ②対戦型の節）。
 */

import type { BenchResult } from "./types.ts";

/** 1 マッチの勝敗。引き分けは "draw"。 */
export type MatchOutcome = "a" | "b" | "draw";

/**
 * 1 手番でプレイヤーが状態を受けて手を返す関数。
 * S は対戦ゲームの状態（じゃんけんなら手の集合や履歴など）、M は手の型。
 * 純関数前提（同じ state には同じ move を返すと決定性が保たれる）。
 */
export type PlayFn<S, M> = (state: S) => M;

/** 総当たりに参加する1選手。id は strategy_id（来歴に使う）。 */
export interface Participant<S, M> {
  /** 戦略 id（BenchResult.battle.opponents / provenance.derived_from に入る）。 */
  id: string;
  /** 状態を受けて手を返す（LLM 非依存・決定的が望ましい）。 */
  play: PlayFn<S, M>;
}

/**
 * 2 選手のマッチ関数。両者の play を呼び、勝敗（a/b/draw）を返す。
 * 乱数が要るゲーム（複数ラウンド等）はここで seed 付き rng を使い決定性を保つ。
 * じゃんけん用の jankenMatch をこのモジュールが提供する。
 */
export type MatchFn<S, M> = (a: PlayFn<S, M>, b: PlayFn<S, M>, round: number) => MatchOutcome;

/** 1 選手の通算成績。 */
export interface Record_ {
  wins: number;
  losses: number;
  draws: number;
}

/** 1 選手の総当たり結果（成績＋勝率＋対戦相手）。 */
export interface ParticipantResult {
  /** この選手の strategy_id。 */
  id: string;
  /** 通算 {wins,losses,draws}（rounds を掛けた全マッチの合計）。 */
  record: Record_;
  /**
   * 勝率 = wins / (wins + losses + draws)。1 マッチも無ければ 0。
   * draws を分母に含む（「決着した中での勝率」ではなく「全対戦中の勝率」）。
   */
  win_rate: number;
  /** 対戦相手 id 群（自分以外、登場順）。 */
  opponents: string[];
}

/** 総当たり全体の結果。 */
export interface RoundRobinResult {
  /** 選手 id → 成績。participants と同じ順序を results 配列でも保持。 */
  results: ParticipantResult[];
  /** 総マッチ数（= C(n,2) * rounds）。検証用。 */
  totalMatches: number;
  /** ラウンド数（各ペアの対戦回数）。 */
  rounds: number;
}

/** prob を計算するためのゼロ除算ガード付き勝率。 */
function winRate(rec: Record_): number {
  const total = rec.wins + rec.losses + rec.draws;
  return total === 0 ? 0 : rec.wins / total;
}

/**
 * 総当たり（round-robin）で全 participant を対戦させ、各自の成績・勝率を集計する。
 *
 * - 各ペア (i<j) を `rounds` 回対戦させる。round 番号を matchFn に渡すので、
 *   matchFn 側で round を seed に混ぜれば複数ラウンドを決定的に変化させられる。
 * - LLM を呼ばない。matchFn / play が決定的なら結果も bit 一致する。
 * - participants は破壊しない（読むだけ）。
 *
 * @param participants 参加選手（id と play）。2 名未満なら全員 0 戦で返る。
 * @param matchFn      2 選手の勝敗を返すマッチ関数（jankenMatch など）。
 * @param rounds       各ペアの対戦回数（>=1。0 以下は 0 戦扱い）。既定 1。
 */
export function runRoundRobin<S, M>(
  participants: Participant<S, M>[],
  matchFn: MatchFn<S, M>,
  rounds = 1,
): RoundRobinResult {
  const n = participants.length;
  const r = Math.max(0, Math.trunc(rounds));

  // id 重複は来歴を壊すので弾く（決定的な早期失敗）。
  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p.id)) {
      throw new Error(`runRoundRobin: duplicate participant id "${p.id}"`);
    }
    seen.add(p.id);
  }

  // 各選手の成績を 0 初期化。
  const records: Record_[] = participants.map(() => ({ wins: 0, losses: 0, draws: 0 }));
  // 各選手の対戦相手集合（登場順を保つため配列＋Set 併用）。
  const opponentLists: string[][] = participants.map(() => []);
  const opponentSeen: Set<string>[] = participants.map(() => new Set<string>());

  let totalMatches = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = participants[i];
      const pj = participants[j];
      if (pi === undefined || pj === undefined) continue; // noUncheckedIndexedAccess ガード
      const reci = records[i];
      const recj = records[j];
      if (reci === undefined || recj === undefined) continue;

      // 対戦相手として登録（重複登録を避ける）。
      if (!opponentSeen[i]!.has(pj.id)) {
        opponentSeen[i]!.add(pj.id);
        opponentLists[i]!.push(pj.id);
      }
      if (!opponentSeen[j]!.has(pi.id)) {
        opponentSeen[j]!.add(pi.id);
        opponentLists[j]!.push(pi.id);
      }

      for (let round = 0; round < r; round++) {
        const outcome = matchFn(pi.play, pj.play, round);
        if (outcome === "a") {
          reci.wins += 1;
          recj.losses += 1;
        } else if (outcome === "b") {
          recj.wins += 1;
          reci.losses += 1;
        } else {
          reci.draws += 1;
          recj.draws += 1;
        }
        totalMatches += 1;
      }
    }
  }

  const results: ParticipantResult[] = participants.map((p, idx) => {
    const rec = records[idx] ?? { wins: 0, losses: 0, draws: 0 };
    return {
      id: p.id,
      record: rec,
      win_rate: winRate(rec),
      opponents: opponentLists[idx] ?? [],
    };
  });

  return { results, totalMatches, rounds: r };
}

/**
 * ParticipantResult を BenchResult.battle 形に詰める（round-robin 固定）。
 * BenchResult 本体の win_rate / score は呼び出し側（S6 collector）が同じ win_rate を使う。
 */
export function toBattleRecord(pr: ParticipantResult): NonNullable<BenchResult["battle"]> {
  return {
    opponents: pr.opponents,
    record: { wins: pr.record.wins, losses: pr.record.losses, draws: pr.record.draws },
    format: "round_robin",
  };
}

// ───────── じゃんけん用 matchFn ─────────

/** じゃんけんの手。 */
export type Janken = "rock" | "paper" | "scissors";

/** a が b に勝つか（じゃんけんの優劣表）。 */
function jankenBeats(a: Janken, b: Janken): boolean {
  return (
    (a === "rock" && b === "scissors") ||
    (a === "paper" && b === "rock") ||
    (a === "scissors" && b === "paper")
  );
}

/**
 * 2 手を比較して勝敗を返す（1 手対 1 手）。同じ手なら "draw"。
 * じゃんけんの最小単位。runRoundRobin の matchFn にラップして使う。
 */
export function jankenCompare(a: Janken, b: Janken): MatchOutcome {
  if (a === b) return "draw";
  return jankenBeats(a, b) ? "a" : "b";
}

/**
 * じゃんけん用の MatchFn。両者の play を round 番号付きの state で呼び、1 手で決着させる。
 * state は round 番号（決定的 play がラウンドごとに手を変えられるよう渡す）。
 * 乱数を使う play は呼び出し側が seed 付き rng を閉じ込めておく（このモジュールは Math.random 非依存）。
 */
export const jankenMatch: MatchFn<number, Janken> = (a, b, round) => {
  const ma = a(round);
  const mb = b(round);
  return jankenCompare(ma, mb);
};
