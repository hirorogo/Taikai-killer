/**
 * populationGA: 本格 GA（個体群 + 交叉 + 突然変異 + エリート保存）の純ロジック実装。
 * 正本: docs/decisions.md「進化（D18）①数値最適化＝LLM 不要」/ docs/quests.md §3
 *       「numericOptimizer は GA ではなくヒルクライム」（GA は未実装と明記）→ 本ファイルで補う。
 *
 * 位置づけ:
 * - numericOptimizer.ts（ヒルクライム＋ランダムリスタート）より強い、個体群ベースの本格 GA。
 *   単一の現在地を摂動するヒルクライムに対し、個体群を持ち交叉で情報を混ぜるため
 *   多峰性・条件数の悪い谷に強い（局所解脱出が個体群の多様性で効く）。
 * - 数値候補（Record<string, number>）専用。fitness は大きいほど良い（max 方向）。
 *   direction:"min" の指標は呼び出し側が符号反転して渡す（評価器の責務・ここは中立）。
 *
 * 譲れない条件（CLAUDE.md / numericOptimizer.ts を継承）:
 * - **LLM を一切呼ばない純ロジック**。evaluate のみを呼ぶ。
 * - **決定的**: seed 固定で完全再現（乱数系列・評価順序・選択・交叉・突然変異が再現）。
 *   Date.now / Math.random 非依存。乱数は numericOptimizer.createRng（mulberry32）に統一する
 *   （共有 .ts を **import して読むだけ**＝決定的乱数の単一実装に揃える）。
 * - **評価回数が決定的**: popSize × (generations + 1)。世代ごとに全個体を評価する
 *   （エリートも毎世代再評価＝決定的なので結果不変、評価回数の公式を単純に保つ）。
 *
 * 設計の正: docs/quests.md。本モジュールは独立完結（runQuest への配線は別途・共有ファイル不触）。
 */

import { createRng } from "../../evolution/numericOptimizer.ts";

/** 数値候補。キー＝チューニング対象の名前、値＝数値（numericOptimizer.Params と構造同一）。 */
export type GACandidate = Record<string, number>;

/** GA 評価関数。候補を受け fitness（大きいほど良い）を返す。非同期（実行を伴うため）。 */
export type GAEvaluateFn = (c: GACandidate) => Promise<number>;

/** populationGA のオプション。すべて決定性に寄与する（seed 固定で完全再現）。 */
export interface PopulationGAOptions {
  /** 擬似乱数 seed（固定で完全再現。createRng に渡る）。 */
  seed: number;
  /** 世代数（>=0）。0 なら初期個体群のみ評価して最良を返す。 */
  generations: number;
  /** 個体数（>=1）。1 世代あたり popSize 個を評価する。 */
  popSize: number;
  /** 進化の出発点（破壊しない。コピーして使う）。この値も初期個体群に必ず含める。 */
  initial: GACandidate;
  /**
   * エリート保存割合（0..1）。各世代で上位 floor(popSize*eliteFrac) を無改変で次世代へ残す。
   * 既定 0.2。最低 1 個体は必ずエリートにする（最良を取りこぼさない）。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  eliteFrac?: number;
  /**
   * ガウス突然変異のスケール（標準偏差）。既定 0.3。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  mutationScale?: number;
}

/** populationGA の結果。来歴を辿れるよう最良候補・スコア・評価回数を含む。 */
export interface PopulationGAResult {
  /** 見つかった最良候補（非破壊コピー）。 */
  best: GACandidate;
  /** 最良 fitness（大きいほど良い）。 */
  bestScore: number;
  /** evaluate を呼んだ総回数（= popSize × (generations + 1)）。 */
  evaluations: number;
  /** 各世代の最良スコア（世代 0＝初期個体群を先頭に、generations+1 要素）。 */
  history: { generation: number; bestScore: number }[];
}

/** 個体群の探索キー順を固定（決定性のため挿入順でなくソート順に固定）。 */
function sortedKeys(c: GACandidate): string[] {
  return Object.keys(c).sort();
}

/**
 * Box-Muller で標準正規分布乱数を 1 つ生成（決定的 rng を使用）。
 * numericOptimizer.gaussian と同方式（共有関数は export されていないため同方式で再実装）。
 */
function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 評価済み個体（候補＋スコア）。スコアでソートして選択・エリートに使う。 */
interface Scored {
  candidate: GACandidate;
  score: number;
}

/**
 * fitness 降順 → キー安定（同点は候補値の文字列で決定的に並べる）でソート。
 * 同点時の順序を seed/挿入順に依存させないため、tie-break を値で決定的に固定する。
 */
function sortByFitness(pop: Scored[], keys: string[]): Scored[] {
  return [...pop].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // 同点 tie-break: ソート済みキー順に値を比較（決定的・seed 非依存）。
    for (const k of keys) {
      const av = a.candidate[k] ?? 0;
      const bv = b.candidate[k] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  });
}

/**
 * トーナメント選択（サイズ 2）。個体群から 2 個を引き、勝者（高スコア）を返す。
 * rng を使うため決定的。圧の弱い size=2 で多様性を保つ。
 */
function tournamentSelect(pop: Scored[], rng: () => number): Scored {
  const n = pop.length;
  const i = Math.min(n - 1, Math.floor(rng() * n));
  const j = Math.min(n - 1, Math.floor(rng() * n));
  const a = pop[i] as Scored;
  const b = pop[j] as Scored;
  return a.score >= b.score ? a : b;
}

/**
 * 交叉。各キーごとに rng で一様交叉（親のどちらかを採る）か算術平均かを選ぶ。
 * 一様/算術平均の 2 方式を混ぜることで、離散的な乗り換えと滑らかな補間の双方を効かせる。
 */
function crossover(
  p1: GACandidate,
  p2: GACandidate,
  keys: string[],
  rng: () => number,
): GACandidate {
  const child: GACandidate = {};
  for (const k of keys) {
    const v1 = p1[k] ?? 0;
    const v2 = p2[k] ?? 0;
    if (rng() < 0.5) {
      // 算術平均（滑らかな補間）。
      child[k] = (v1 + v2) / 2;
    } else {
      // 一様（親のどちらかを採用）。
      child[k] = rng() < 0.5 ? v1 : v2;
    }
  }
  return child;
}

/** ガウス突然変異。各キーに gauss * mutationScale を加える（非破壊）。 */
function mutate(
  c: GACandidate,
  keys: string[],
  mutationScale: number,
  rng: () => number,
): GACandidate {
  const next: GACandidate = {};
  for (const k of keys) {
    next[k] = (c[k] ?? 0) + gaussian(rng) * mutationScale;
  }
  return next;
}

/**
 * 個体群ベースの本格 GA（交叉 + ガウス突然変異 + エリート保存）でパラメータを最適化する。
 *
 * 流れ（決定的・seed 固定で完全再現）:
 *   1. 初期個体群を生成（initial を 1 個体 + 残りを initial へのガウス摂動）し評価。
 *   2. 各世代: 上位 elite を無改変で残し、残りをトーナメント選択→交叉→突然変異で生成、再評価。
 *   3. generations 回繰り返し、全世代を通じた最良候補を返す。
 *
 * - **LLM を呼ばない**。evaluate のみを呼ぶ。
 * - 評価回数は popSize × (generations + 1)（毎世代 popSize 個を評価。エリートも再評価＝
 *   決定的なので結果不変、公式を単純に保つ）。
 *
 * @param evaluate fitness 評価関数（大きいほど良い・決定的）。
 * @param opts     seed / generations / popSize / initial（/ eliteFrac / mutationScale）。
 */
export async function populationGA(
  evaluate: GAEvaluateFn,
  opts: PopulationGAOptions,
): Promise<PopulationGAResult> {
  const popSize = Math.max(1, Math.trunc(opts.popSize));
  const generations = Math.max(0, Math.trunc(opts.generations));
  const mutationScale = opts.mutationScale ?? 0.3;
  const eliteFrac = opts.eliteFrac ?? 0.2;
  const rng = createRng(opts.seed);
  const keys = sortedKeys(opts.initial);

  // エリート数: 最低 1、最大 popSize-1（全員エリートだと進化が止まるため上限を引く。
  // ただし popSize=1 のときは 1）。
  const rawElite = Math.floor(popSize * eliteFrac);
  const eliteCount =
    popSize <= 1 ? 1 : Math.min(popSize - 1, Math.max(1, rawElite));

  // 1. 初期個体群: 先頭は initial そのもの、残りは initial へのガウス摂動（多様性確保）。
  let population: Scored[] = [];
  for (let i = 0; i < popSize; i++) {
    const candidate =
      i === 0 ? { ...opts.initial } : mutate(opts.initial, keys, mutationScale, rng);
    const score = await evaluate(candidate);
    population.push({ candidate, score });
  }

  let sorted = sortByFitness(population, keys);
  let bestEntry = sorted[0] as Scored;
  let best: GACandidate = { ...bestEntry.candidate };
  let bestScore = bestEntry.score;

  const history: { generation: number; bestScore: number }[] = [
    { generation: 0, bestScore },
  ];

  // 2. 世代ループ。
  for (let g = 1; g <= generations; g++) {
    const nextCandidates: GACandidate[] = [];

    // エリート保存: 上位 eliteCount をそのまま次世代へ（無改変）。
    for (let e = 0; e < eliteCount; e++) {
      nextCandidates.push({ ...(sorted[e] as Scored).candidate });
    }

    // 残りを選択→交叉→突然変異で生成。
    while (nextCandidates.length < popSize) {
      const p1 = tournamentSelect(sorted, rng);
      const p2 = tournamentSelect(sorted, rng);
      const child = crossover(p1.candidate, p2.candidate, keys, rng);
      nextCandidates.push(mutate(child, keys, mutationScale, rng));
    }

    // 全個体を評価（決定的・評価回数を popSize で固定）。
    const nextPop: Scored[] = [];
    for (const candidate of nextCandidates) {
      const score = await evaluate(candidate);
      nextPop.push({ candidate, score });
    }

    population = nextPop;
    sorted = sortByFitness(population, keys);
    const genBest = sorted[0] as Scored;
    if (genBest.score > bestScore) {
      best = { ...genBest.candidate };
      bestScore = genBest.score;
    }
    history.push({ generation: g, bestScore });
  }

  return {
    best,
    bestScore,
    evaluations: popSize * (generations + 1),
    history,
  };
}
