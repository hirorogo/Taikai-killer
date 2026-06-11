/**
 * 数値最適化トラック（D18 ①: LLM 不要）。
 * 正本: docs/decisions.md「進化（D18）」/ docs/directory-structure.md「D18 注（2トラック分離）①」。
 *
 * 方針（譲れない条件）:
 * - **LLM を一切呼ばない**。閾値・パラメータ・重み（例: じゃんけん AI の出す確率）を
 *   普通のコード（ヒルクライム＋ランダムリスタート）で回す。
 * - **決定的**: seed 固定で同結果（再現性◎）。Date.now / Math.random には依存しない。
 *   乱数は seed 付き擬似乱数を自前実装（mulberry32）。
 * - **evaluate（= S6 評価関数）を呼ぶだけ**。スコアは大きいほど良い（max 方向）前提で最大化する。
 *   direction:"min" の指標は呼び出し側が符号反転して渡す（評価器の責務、ここは中立）。
 *
 * 用途: 生成済みプログラムを実行してスコアを返すだけの評価関数に対し、
 * 数十回ではなく数万回のパラメータチューニングを回す（LLM 進化との対比）。
 */

/** パラメータベクタ。キー＝チューニング対象の名前、値＝数値。 */
export type Params = Record<string, number>;

/** S6 評価関数。パラメータを受けスコア（大きいほど良い）を返す。非同期（実行を伴うため）。 */
export type EvaluateFn = (params: Params) => Promise<number>;

/** 最適化オプション。すべて決定性に寄与する（seed 固定で完全再現）。 */
export interface OptimizeOptions {
  /** 反復回数（= evaluate 呼び出し回数の上限。初期評価1回 + iterations 回の近傍評価）。 */
  iterations: number;
  /** 擬似乱数 seed。固定すれば結果も固定（再現性の要）。 */
  seed: number;
  /** 近傍生成のステップ幅スケール。各パラメータの摂動 = stepScale * gauss。 */
  stepScale: number;
  /**
   * 改善が止まったとき再スタートする連続停滞回数。未指定なら無効（純ヒルクライム）。
   * リスタートは best から seed 由来の乱数で再ジャンプする（多峰性対策）。
   */
  restartAfter?: number;
}

/** 最適化結果。来歴を辿れるよう履歴と統計を含む。 */
export interface OptimizeResult {
  /** 見つかった最良パラメータ。 */
  best: Params;
  /** 最良スコア。 */
  bestScore: number;
  /** 実際に evaluate を呼んだ回数（初期1 + 反復）。 */
  evaluations: number;
  /** 各反復で best が更新された (iteration, score) の履歴（採用された改善のみ）。 */
  history: { iteration: number; score: number }[];
  /** リスタート発生回数（restartAfter 指定時のみ >0 になりうる）。 */
  restarts: number;
}

/**
 * mulberry32: 32bit seed の決定的擬似乱数。0以上1未満を返す。
 * Date.now / Math.random 非依存。同一 seed → 同一系列。
 */
export function createRng(seed: number): () => number {
  // seed を 32bit 符号なしに正規化（負数・小数・NaN を弾く）。
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Box-Muller で標準正規分布乱数を1つ生成（決定的 rng を使用）。
 * 近傍探索のステップに使う（一様より局所探索が滑らかになる）。
 */
function gaussian(rng: () => number): number {
  // u1 が 0 だと log(0) = -Inf になるため下限をクランプ。
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** params のキー順を固定（決定性のため挿入順でなくソート順に固定）。 */
function sortedKeys(params: Params): string[] {
  return Object.keys(params).sort();
}

/** base の各キーを gauss * stepScale で摂動した近傍を作る（非破壊）。 */
function neighbor(base: Params, keys: string[], stepScale: number, rng: () => number): Params {
  const next: Params = { ...base };
  for (const key of keys) {
    const current = base[key] ?? 0;
    next[key] = current + gaussian(rng) * stepScale;
  }
  return next;
}

/** best から大きめにジャンプした再スタート点を作る（多峰性対策、stepScale の数倍）。 */
function restartPoint(best: Params, keys: string[], stepScale: number, rng: () => number): Params {
  const jump: Params = { ...best };
  for (const key of keys) {
    const current = best[key] ?? 0;
    // 通常ステップの 5 倍幅でジャンプして局所最適から脱出。
    jump[key] = current + gaussian(rng) * stepScale * 5;
  }
  return jump;
}

/**
 * ヒルクライム（＋任意ランダムリスタート）でパラメータを最適化する。
 *
 * - LLM を呼ばない。evaluate のみを呼ぶ。
 * - seed 固定で完全に決定的（乱数系列・評価順序が再現する）。evaluate 自体が
 *   決定的なら結果も bit 一致する。
 * - スコアは「大きいほど良い」前提で最大化する。
 *
 * @param params0  初期パラメータ（破壊しない。コピーして使う）。
 * @param evaluate S6 評価関数。
 * @param opts     反復回数・seed・ステップ幅（・任意のリスタート閾値）。
 */
export async function optimize(
  params0: Params,
  evaluate: EvaluateFn,
  opts: OptimizeOptions,
): Promise<OptimizeResult> {
  const iterations = Math.max(0, Math.trunc(opts.iterations));
  const stepScale = opts.stepScale;
  const rng = createRng(opts.seed);
  const keys = sortedKeys(params0);

  // 現在地と最良を初期化。初期点を1回評価する。
  let current: Params = { ...params0 };
  let currentScore = await evaluate(current);
  let evaluations = 1;

  let best: Params = { ...current };
  let bestScore = currentScore;

  const history: { iteration: number; score: number }[] = [];
  let restarts = 0;
  let stagnation = 0;

  for (let i = 0; i < iterations; i++) {
    const candidate = neighbor(current, keys, stepScale, rng);
    const candidateScore = await evaluate(candidate);
    evaluations++;

    if (candidateScore > currentScore) {
      // 改善（厳密に大きい時のみ採用＝決定的。同値は採らず stall を進める）。
      current = candidate;
      currentScore = candidateScore;
      stagnation = 0;
      if (candidateScore > bestScore) {
        best = { ...candidate };
        bestScore = candidateScore;
        history.push({ iteration: i, score: bestScore });
      }
    } else {
      stagnation++;
      // リスタート条件: 連続停滞が閾値に達したら best から大きくジャンプ。
      if (opts.restartAfter !== undefined && stagnation >= opts.restartAfter) {
        current = restartPoint(best, keys, stepScale, rng);
        currentScore = await evaluate(current);
        evaluations++;
        stagnation = 0;
        restarts++;
        if (currentScore > bestScore) {
          best = { ...current };
          bestScore = currentScore;
          history.push({ iteration: i, score: bestScore });
        }
      }
    }
  }

  return { best, bestScore, evaluations, history, restarts };
}
