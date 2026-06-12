/**
 * questFramework: 汎用クエスト実行ループ（initialize → evaluate → optimize → select → submit）。
 * 正本: docs/decisions.md「進化（D18）」/ docs/architecture.md S6。
 *
 * 役割:
 * - QuestAdapter<Candidate> を受け、候補を進化させ最良候補を返す。
 * - Candidate が数値 Record（{k:number}、adapter.mutateNumeric=true）のときは既存
 *   numericOptimizer（createRng/optimize）を **import して読むだけ** で再利用する
 *   （ヒルクライム＋任意リスタートの本体を再実装しない＝車輪の再発明禁止）。
 * - 非数値クエストでも同じ外形（最良候補＋スコア＋提出物生成）で回せるよう、
 *   汎用ループ（初期候補1点を評価して最良として返す）を持つ。実際の探索は
 *   numericOptimizer 経路に集約する（数値以外は将来 adapter 側で mutate を持つ拡張余地）。
 *
 * 譲れない条件:
 * - **LLM を呼ばない**。adapter.evaluate / adapter.buildSubmission のみを呼ぶ。
 * - **決定的**: seed 固定で完全再現（numericOptimizer の決定性をそのまま継承）。
 *   Date.now / Math.random 非依存。
 * - **fitness は大きいほど良い**（max 方向）。符号の責務は adapter（評価器）側。
 */

import { optimize } from "../../evolution/numericOptimizer.ts";
import type { Params } from "../../evolution/numericOptimizer.ts";
import { populationGA } from "./populationGA.ts";
import type { NumericCandidate, QuestAdapter } from "./adapter.ts";

/** runQuest のオプション。すべて決定性に寄与する（seed 固定で完全再現）。 */
export interface RunQuestOptions {
  /** 擬似乱数 seed（固定で完全再現。numericOptimizer.createRng に渡る）。 */
  seed: number;
  /**
   * 世代数（= 近傍評価の反復回数）。numericOptimizer.iterations に対応。
   * 0 なら初期候補をそのまま最良として返す（評価1回のみ）。
   */
  generations: number;
  /**
   * 個体数の上限（GA 的な個体管理を将来差し込むための上限ヒント）。
   * 現状のヒルクライム経路では近傍探索のステップ幅スケールに反映する
   * （popLimit が大きいほど探索を広げる）。未指定なら既定スケール。
   * exactOptionalPropertyTypes: 値があるときだけ載せる。
   */
  popLimit?: number;
  /**
   * 提出物の出力先ディレクトリ。指定時のみ adapter.buildSubmission を呼ぶ
   * （未指定なら提出物を作らず最良候補だけ返す＝探索だけ回したいとき用）。
   */
  submissionDir?: string;
  /**
   * 近傍ステップ幅スケール（numericOptimizer.stepScale）。未指定なら popLimit から
   * 導出（なければ既定 0.3）。決定性に影響するので明示できるよう公開する。
   */
  stepScale?: number;
  /**
   * 停滞時のランダムリスタート閾値（numericOptimizer.restartAfter）。
   * 未指定なら純ヒルクライム（リスタートなし）。
   */
  restartAfter?: number;
  /**
   * 指定すると本格GA（populationGA: 個体群+交叉+突然変異+エリート保存）で探索する。
   * 未指定ならヒルクライム（numericOptimizer）。多峰・広域探索はGAが有利。
   */
  gaPopSize?: number;
}

/** runQuest の結果。来歴を辿れるよう最良候補・スコア・評価回数を含む。 */
export interface RunQuestResult<Candidate> {
  /** 見つかった最良候補。 */
  best: Candidate;
  /** 最良候補の fitness（高いほど良い）。 */
  bestScore: number;
  /** adapter.evaluate を呼んだ総回数。 */
  evaluations: number;
  /** 提出物を生成したか（submissionDir 指定時のみ true）。 */
  submitted: boolean;
}

/** 既定の近傍ステップ幅スケール（numericOptimizer のデモ値に揃える）。 */
const DEFAULT_STEP_SCALE = 0.3;

/**
 * popLimit から探索ステップ幅を導出する（決定的）。
 * 大きい個体数 = 広い探索、という直感を単調増加で反映（過大にならないよう緩く効かせる）。
 */
function deriveStepScale(popLimit: number | undefined, explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  if (popLimit === undefined) return DEFAULT_STEP_SCALE;
  const n = Math.max(1, Math.trunc(popLimit));
  // 個体数の対数で緩やかに広げる（pop=1→0.3, pop=20→約0.5, pop=100→約0.6）。
  return DEFAULT_STEP_SCALE * (1 + Math.log(n) / 10);
}

/**
 * 数値候補（NumericCandidate）を numericOptimizer.optimize で進化させる内部経路。
 * adapter.evaluate を Params 評価関数にそのままラップして渡す（型は構造的に一致）。
 */
async function runNumeric<Candidate extends NumericCandidate>(
  adapter: QuestAdapter<Candidate>,
  opts: RunQuestOptions,
): Promise<{ best: Candidate; bestScore: number; evaluations: number }> {
  const initial = adapter.initialCandidate();

  // paramKeys が与えられていればそのキーだけを初期点に含める（探索対象を明示）。
  // 未指定なら initialCandidate のキーをそのまま使う。
  const params0: Params = {};
  const keys = adapter.paramKeys ?? Object.keys(initial);
  for (const k of keys) {
    params0[k] = initial[k] ?? 0;
  }

  const stepScale = deriveStepScale(opts.popLimit, opts.stepScale);

  // optimize は Promise<number> を返す evaluate を期待する。adapter.evaluate に委譲。
  // Params → Candidate は構造的に同一（NumericCandidate = Record<string, number>）。
  const evaluate = (p: Params): Promise<number> => adapter.evaluate(p as Candidate);

  // gaPopSize 指定時は本格GA（個体群探索）。多峰・広域に強い。
  if (opts.gaPopSize !== undefined && opts.gaPopSize > 1) {
    const ga = await populationGA(evaluate as (c: Record<string, number>) => Promise<number>, {
      seed: opts.seed,
      generations: Math.max(0, Math.trunc(opts.generations)),
      popSize: Math.trunc(opts.gaPopSize),
      initial: params0,
    });
    return { best: ga.best as Candidate, bestScore: ga.bestScore, evaluations: ga.evaluations };
  }

  const res = await optimize(params0, evaluate, {
    iterations: Math.max(0, Math.trunc(opts.generations)),
    seed: opts.seed,
    stepScale,
    // exactOptionalPropertyTypes: restartAfter は値があるときだけ載せる。
    ...(opts.restartAfter !== undefined ? { restartAfter: opts.restartAfter } : {}),
  });

  return {
    best: res.best as Candidate,
    bestScore: res.bestScore,
    evaluations: res.evaluations,
  };
}

/**
 * 非数値クエストの汎用経路（initialize → evaluate → select）。
 * 現状は初期候補を1点評価して最良として返す（数値以外の mutate は adapter 拡張に委ねる）。
 * 数値クエストは runNumeric に集約するので、ここは「探索なしでも外形を保つ」フォールバック。
 */
async function runGeneric<Candidate>(
  adapter: QuestAdapter<Candidate>,
): Promise<{ best: Candidate; bestScore: number; evaluations: number }> {
  const best = adapter.initialCandidate();
  const bestScore = await adapter.evaluate(best);
  return { best, bestScore, evaluations: 1 };
}

/**
 * クエストを実行する（フレームワークのエントリポイント）。
 *
 * 流れ: initialize（adapter.initialCandidate）→ evaluate（adapter.evaluate を fitness に）
 *      → optimize（数値は numericOptimizer、それ以外は汎用）→ select（最良）→ submit
 *      （submissionDir 指定時のみ adapter.buildSubmission）。
 *
 * - **LLM を呼ばない**。adapter のメソッドのみを呼ぶ。
 * - **決定的**: adapter.evaluate が決定的なら seed 固定で best/score まで完全再現する。
 * - **fitness は大きいほど良い**（max 方向）。
 *
 * @param adapter クエスト固有の候補生成・評価・提出物組み立て。
 * @param opts    seed / generations（/ popLimit / submissionDir / stepScale / restartAfter）。
 */
export async function runQuest<Candidate>(
  adapter: QuestAdapter<Candidate>,
  opts: RunQuestOptions,
): Promise<RunQuestResult<Candidate>> {
  // optimize: 数値候補なら numericOptimizer をそのまま使う。
  const core =
    adapter.mutateNumeric === true
      ? await runNumeric(adapter as QuestAdapter<Candidate & NumericCandidate>, opts)
      : await runGeneric(adapter);

  // submit: 出力先が指定されたときだけ提出物を生成（不可逆な submit/publish はしない）。
  let submitted = false;
  if (opts.submissionDir !== undefined) {
    adapter.buildSubmission(core.best, opts.submissionDir);
    submitted = true;
  }

  return {
    best: core.best,
    bestScore: core.bestScore,
    evaluations: core.evaluations,
    submitted,
  };
}
