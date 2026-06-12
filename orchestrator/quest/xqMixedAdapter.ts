/**
 * X Quest「七並べ」**混合フィールド**版 QuestAdapter（intransitivity drift 対策 / docs/quests.md §7.6）。
 *
 * 背景: 自己対戦のみの coevolution champion は混合多人数卓で既定ヒューリスティックに負ける（§7.6 実測）。
 * 原因は trainer の相手分布が本番と乖離していること。本アダプタは候補を **evaluate_mixed.py
 * （random/medium/heuristic が混ざる卓）** で評価し、fitness を本番に近い相手分布での順位点にする。
 * これを numericOptimizer / populationGA で最大化すれば「混合卓で強い params」が得られる、の検証。
 *
 * 設計: 車輪の再発明を避け、xqAdapter の純ロジック（buildEvalPayload / parseEvalResult /
 * serializeSubmission / paramKeys）を **import して再利用**する。違いは (1) spawn 先が
 * evaluate_mixed.py、(2) 出発点が強い既定（ai_param default＝混合卓での現状最強）、(3) 提出名が
 * mixed_champion_params.json、の3点だけ。spawn I/O 作法は xqAdapter.evaluate と同形。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { NumericCandidate, QuestAdapter } from "./adapter.ts";
import {
  paramKeys,
  buildEvalPayload,
  parseEvalResult,
  serializeSubmission,
  type Candidate,
  type EvalOptions,
} from "./xqAdapter.ts";

const IS_WIN = process.platform === "win32";

/** 混合評価サイドカー（リポジトリルートからの相対）。 */
const EVALUATE_MIXED_REL = join("quests", "xq-7narabe", "evaluate_mixed.py");

/** buildSubmission が書く提出ファイル名（xqAdapter の best_params.json と分ける）。 */
export const MIXED_SUBMISSION_FILENAME = "mixed_champion_params.json";

/**
 * 出発点 = ai_param の強い既定（= coevolve.initialChampion・混合卓での現状最強＝§7.6 heuristic）。
 * xqAdapter.initialCandidate は弱い手動局所点なので、混合最適化は「現状最強を超える」ため強い既定から開始する。
 */
export const initialCandidate: Readonly<Record<(typeof paramKeys)[number], number>> = {
  w_edge_distance: 1.0,
  w_blocking: 1.5,
  w_rank_extreme: 0.3,
  w_hold_seven_adj: 0.4,
  w_suit_balance: 2.5,
  w_pass_reserve: 1.0,
  w_release_urgency: 1.2,
  w_random_jitter: 0.05,
} as const;

/** 候補を混合フィールドで評価し win_rate（順位点 fitness）を返す。xqAdapter.evaluate と同形の spawn I/O。 */
export function evaluateMixed(
  candidate: Candidate,
  timeoutMs: number,
  opts: EvalOptions = {},
): Promise<number> {
  const sidecarPath = opts.sidecarPath ?? join(process.cwd(), EVALUATE_MIXED_REL);
  const python = opts.python ?? "python";
  const failFitness = opts.failFitness ?? 0;
  const payload = buildEvalPayload(candidate, opts); // 入力契約は evaluate.py と互換（再利用）。

  return new Promise<number>((resolve) => {
    const child = spawn(python, [sidecarPath], { shell: IS_WIN, windowsHide: true });
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const finish = (fitness: number): void => {
      if (settled) return;
      settled = true;
      resolve(fitness);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", () => {
      /* 診断は読み捨て（xqAdapter と同方針） */
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(failFitness);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        finish(failFitness);
        return;
      }
      if (code !== 0 && code !== null) {
        finish(failFitness);
        return;
      }
      finish(parseEvalResult(stdout, failFitness));
    });
    child.stdin.on("error", () => {
      /* EPIPE 等は close 側で処理 */
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** 最良候補を dir/mixed_champion_params.json に書き出す（serializeSubmission 再利用＝8 キー保証）。 */
export function writeMixedSubmission(best: Candidate, dir: string): string {
  const path = join(dir, MIXED_SUBMISSION_FILENAME);
  writeFileSync(path, serializeSubmission(best), "utf8");
  return path;
}

/**
 * 混合フィールド版 QuestAdapter（数値候補＝mutateNumeric:true）。
 * runQuest が numericOptimizer / populationGA でこの候補を進化させる（評価は evaluate_mixed.py）。
 */
export const xqMixedAdapter: QuestAdapter<NumericCandidate> = {
  questId: "xq-7narabe-mixed",
  paramKeys: [...paramKeys],
  mutateNumeric: true,
  initialCandidate(): NumericCandidate {
    return { ...initialCandidate };
  },
  evaluate(c: NumericCandidate): Promise<number> {
    return evaluateMixed(c, 60_000);
  },
  buildSubmission(best: NumericCandidate, dir: string): void {
    writeMixedSubmission(best, dir);
  },
};
