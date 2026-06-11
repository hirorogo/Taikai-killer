/**
 * S6 対戦モード（②battle）のフロー。
 * 正本: docs/architecture.md「S6 の2評価モード」表②／orchestrator/types.ts BenchResult.battle。
 *
 * 方針（譲れない条件）:
 * - 本モジュールは「総当たり結果 → BenchResult[] への集計・変換」が主。
 *   実プロセス対戦（spawn）は battleRunner.ts（runBattleTournament）に **委譲**（読むだけ）。
 *   勝敗集計・record/opponents/win_rate の式は battleRunner / battle.ts が唯一の真実源。
 * - **rank 付与・同率処理・空入力ガードは純ロジック** `toBenchResults(battleResults, rubricRef)`
 *   に切り出してテストする。win_rate 降順で rank を振り、同率は同 rank（standard competition
 *   ranking, "1224"）。決定的（同じ入力→同じ出力）。
 * - eval_mode は常に "battle"。score は一次指標 win_rate をそのまま採用（architecture.md ②）。
 * - LLM 非依存・決定的。Date.now / Math.random に依存しない。
 */

import { runBattleTournament, type BattlePlayer } from "./battleRunner.ts";
import type { BenchResult, ScoringRubric } from "./types.ts";

/** runBattleEval の入力プレイヤー（projects/{id}/ の実行情報）。BattlePlayer と同形。 */
export type BattleEvalPlayer = BattlePlayer;

/**
 * toBenchResults の入力 1 件（battleRunner.runBattleTournament の entries 要素と同形）。
 * id / battle 形 / win_rate を素のまま受け、BenchResult に詰め直す。
 */
export interface BattleEvalEntry {
  id: string;
  battle: NonNullable<BenchResult["battle"]>;
  win_rate: number;
}

/**
 * BenchResult 変換に必要な rubric 参照。BenchResult.rubric_ref / eval_mode の唯一の出所。
 * ScoringRubric をそのまま渡してもよいよう、必要フィールドだけの構造的部分型にしておく。
 */
export interface RubricRef {
  /** BenchResult.rubric_ref に入る（どの ScoringRubric で測ったか）。 */
  derived_from: string;
  /** BenchResult.eval_mode。battle 評価では "battle" 固定が前提（防御的に受けるだけ）。 */
  eval_mode: ScoringRubric["eval_mode"];
}

/** runBattleEval のオプション（result_id プレフィックス / spawn timeout）。 */
export interface BattleEvalOptions {
  /** 各 BenchResult.result_id の組み立てに使う run-id（既定 "battle"）。 */
  runId?: string;
  /** 1 手 spawn あたりのハード timeout（ms）。battleRunner に委譲。 */
  moveTimeoutMs?: number;
}

// ───────── 純ロジック（テスト対象）─────────

/**
 * 総当たり結果（id / battle / win_rate の配列）を BenchResult[] に変換する。
 *
 * - rank は **win_rate 降順**で付与。同率は同 rank（standard competition ranking, "1224"）:
 *   次の rank は同率件数ぶん飛ばす（例: 0.9,0.9,0.5 → rank 1,1,3）。
 * - 入力順は保持する（戻り配列の並びは battleResults と同順）。rank だけ win_rate 由来で振る。
 * - 空入力は空配列を返す（ガード）。id 重複は来歴を壊すので弾く。
 * - score は win_rate をそのまま採用、metrics.win_rate にも同値を入れる（一次指標）。
 * - eval_mode / rubric_ref は rubricRef から取る（外部化ルブリック / コードに埋めない）。
 *
 * 決定的: 同じ battleResults + rubricRef → 同じ BenchResult[]（Date/Random 非依存）。
 *
 * @param battleResults runBattleTournament の entries（id / battle 形 / win_rate）。
 * @param rubricRef     eval_mode / rubric_ref の出所（ScoringRubric 互換）。
 * @param runId         result_id プレフィックス（既定 "battle"）。
 */
export function toBenchResults(
  battleResults: BattleEvalEntry[],
  rubricRef: RubricRef,
  runId = "battle",
): BenchResult[] {
  if (battleResults.length === 0) return [];

  // id 重複の早期失敗（来歴保護）。battleRunner でも弾くが純変換側でも守る。
  const seen = new Set<string>();
  for (const e of battleResults) {
    if (seen.has(e.id)) throw new Error(`toBenchResults: duplicate strategy id "${e.id}"`);
    seen.add(e.id);
  }

  // rank 算出用に win_rate 降順の索引を作る（入力順は保持したいので別配列で順位だけ求める）。
  // 同率は同 rank。tie-break は win_rate のみ（id でのさらなる順序付けはしない＝決定的に同 rank）。
  const sorted = battleResults.map((e, idx) => ({ idx, win_rate: e.win_rate })).sort((a, b) => {
    if (b.win_rate !== a.win_rate) return b.win_rate - a.win_rate; // 降順
    return a.idx - b.idx; // 安定化（同率内の並びは入力順）
  });

  // idx → rank（1 始まり, standard competition ranking）。
  const rankByIdx = new Map<number, number>();
  let prevRate: number | null = null;
  let prevRank = 0;
  for (let pos = 0; pos < sorted.length; pos++) {
    const s = sorted[pos];
    if (s === undefined) continue; // noUncheckedIndexedAccess
    const rank = prevRate !== null && s.win_rate === prevRate ? prevRank : pos + 1;
    rankByIdx.set(s.idx, rank);
    prevRate = s.win_rate;
    prevRank = rank;
  }

  return battleResults.map((e, idx) => {
    const rank = rankByIdx.get(idx) ?? idx + 1;
    const result: BenchResult = {
      result_id: `${runId}:${e.id}`,
      strategy_id: e.id,
      rubric_ref: rubricRef.derived_from,
      eval_mode: "battle",
      score: e.win_rate,
      rank,
      metrics: { win_rate: e.win_rate },
      win_rate: e.win_rate,
      battle: {
        opponents: e.battle.opponents.slice(),
        record: {
          wins: e.battle.record.wins,
          losses: e.battle.record.losses,
          draws: e.battle.record.draws,
        },
        format: e.battle.format,
      },
      threshold: [],
    };
    return result;
  });
}

// ───────── フロー層（spawn を battleRunner に委譲）─────────

/**
 * S6 対戦評価フロー: 戦略プログラム同士を総当たり対戦させ、各戦略の BenchResult[] を返す。
 *
 * 流れ:
 *  1) runBattleTournament（battleRunner.ts）に players を渡し、実プロセス対戦で
 *     id / battle 形 / win_rate を集計（spawn の非決定性はここに閉じ込まる）。
 *  2) toBenchResults で win_rate 降順 rank・BenchResult 形へ変換（純ロジック・決定的）。
 *
 * 本ファイルは (2) の集計→変換が主。(1) の I/O は委譲。
 *
 * @param players 参加戦略（id / run_cmd / cwd）。
 * @param rubric  eval_mode / rubric_ref の出所（ScoringRubric 互換）。
 * @param rounds  各ペアの対戦ラウンド数（>=1。既定 1）。
 * @param options runId / moveTimeoutMs（result_id プレフィックス・spawn timeout）。
 */
export async function runBattleEval(
  players: BattleEvalPlayer[],
  rubric: RubricRef,
  rounds = 1,
  options: BattleEvalOptions = {},
): Promise<BenchResult[]> {
  if (players.length === 0) return [];

  const r = Math.max(1, Math.trunc(rounds));
  const tournament = await runBattleTournament(players, {
    rounds: r,
    ...(options.moveTimeoutMs !== undefined ? { moveTimeoutMs: options.moveTimeoutMs } : {}),
  });

  return toBenchResults(tournament.entries, rubric, options.runId ?? "battle");
}
