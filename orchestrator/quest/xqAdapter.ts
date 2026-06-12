/**
 * X Quest「七並べ（xq-7narabe）」を questFramework の QuestAdapter として
 * Taikai-killer の数値最適化トラック（D18 ①: LLM 不要）に繋ぐ TS ブリッジ。
 *
 * 正本: orchestrator/quest/adapter.ts（QuestAdapter<Candidate> の契約）/
 *       orchestrator/quest/runQuest.ts（数値候補は mutateNumeric=true で numericOptimizer 直結）/
 *       orchestrator/crawl.ts・orchestrator/battleRunner.ts の Python サイドカー spawn 作法。
 *
 * 方針（譲れない条件）:
 * - 評価本体は Python サイドカー（quests/xq-7narabe/evaluate.py）に委譲。ここは spawn して
 *   候補（数値 param の Record）を stdin に 1 行 JSON（{params,games,seed,opponents}）で渡し、
 *   stdout の {win_rate} を読むだけ。win_rate は「大きいほど良い」fitness としてそのまま返す。
 * - crawl.ts / battleRunner.ts と同形: spawn / stdin 投入 / ハード timeout（超過は SIGKILL）/
 *   純ロジック（payload 構築 buildEvalPayload・結果パース parseEvalResult）を named export して
 *   vitest で固める。spawn 自体はテスト対象外（実プロセス）。
 * - 堅牢性: 壊れた JSON / タイムアウト / 異常終了 / spawn 失敗は throw せず **低 fitness（既定 0）**
 *   を返す（CLAUDE.md「単一ワーカーの失敗でループを止めない」＝1 候補の評価失敗で最適化を止めない）。
 *
 * QuestAdapter 型（adapter.ts）を import（読むだけ）して xqAdapter がその契約を満たす。
 * runQuest は mutateNumeric=true を見て numericOptimizer（ヒルクライム）でこの候補を進化させる。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { NumericCandidate, QuestAdapter } from "./adapter.ts";

const IS_WIN = process.platform === "win32";

/** サイドカー実行パス（リポジトリルートからの相対）。crawl.ts の SIDECAR_REL と同形。 */
const EVALUATE_REL = join("quests", "xq-7narabe", "evaluate.py");

/** buildSubmission が dir 内に書く提出ファイル名。 */
export const SUBMISSION_FILENAME = "best_params.json";

/**
 * 候補のチューニング対象 paramKey（8 個・evaluate.py PARAM_KEYS と 1:1・同順）。
 * runQuest はこのキー集合を初期点に使い numericOptimizer で摂動する。
 */
export const paramKeys = [
  "w_edge_distance", // 場の端からの距離が大きい札を優先（道を早く開ける）
  "w_blocking", // 自分が止めると相手が困る境界札を温存
  "w_rank_extreme", // A/K 寄り（端ランク）を早めに出す
  "w_hold_seven_adj", // 7 隣接（6/8）を保持して主導権を握る
  "w_suit_balance", // 手札が多いスートを優先して捌く
  "w_pass_reserve", // パスを温存する傾向（出せても保留する閾値）
  "w_release_urgency", // 終盤に出し切りを急ぐ
  "w_random_jitter", // わずかな探索ノイズ（決定的 rng で再現）
] as const;

/** paramKeys の要素型。 */
export type ParamKey = (typeof paramKeys)[number];

/** 候補＝数値 param の Record（adapter.NumericCandidate = Record<string, number> と互換）。 */
export type Candidate = NumericCandidate;

/**
 * 初期候補（2025 既定値・evaluate.py default_params と 1:1・同値）。
 * QuestAdapter.initialCandidate() がこのコピーを返す。
 *
 * 注意: これらの既定符号は**最適とは限らない**（手動チューニングの局所点）。例えば
 * w_edge_distance を反転（-10）させると win_rate が default を上回る計測がある（seed=3, games=200）。
 * 初期点は探索の出発点に過ぎず、numericOptimizer（ヒルクライム＋リスタート）が
 * この局所点を脱出して符号・大きさを直す前提（手動 700 を自動探索で超える、の核）。
 */
export const initialCandidate: Readonly<Record<ParamKey, number>> = {
  w_edge_distance: 1.0,
  w_blocking: 0.5,
  w_rank_extreme: 0.3,
  w_hold_seven_adj: 0.4,
  w_suit_balance: 0.2,
  w_pass_reserve: 0.1,
  w_release_urgency: 0.6,
  w_random_jitter: 0.05,
} as const;

/** evaluate() のオプション（局数・seed・対戦相手数・timeout・サイドカーパス差し替え）。 */
export interface EvalOptions {
  /** 評価する局数（>=1）。多いほど分散が減るが遅い。既定 100。 */
  games?: number;
  /** 乱数 seed（決定性の要。固定すれば win_rate も固定）。既定 0。 */
  seed?: number;
  /** 候補以外の対戦相手の人数（>=1）。本番は 3 人戦なので既定 2（候補 1 + 相手 2）。
   *  evaluate.py は players_num = opponents + 1 で人数を決めるので、ここを 2 に揃えると 3 人戦。 */
  opponents?: number;
  /** サイドカー（evaluate.py）のパス。テスト/差し替え用。既定 cwd/quests/xq-7narabe/evaluate.py。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定 "python"）。 */
  python?: string;
  /** spawn 失敗/壊れ JSON/タイムアウト時に返す低 fitness。既定 0。 */
  failFitness?: number;
}

/** サイドカーに stdin で渡す 1 行 JSON ペイロードの形（evaluate.py の入力契約と 1:1）。 */
export interface EvalPayload {
  params: Candidate;
  games: number;
  seed: number;
  opponents: number;
}

// ───────── 純ロジック（テスト対象）─────────

/**
 * 候補とオプションから stdin ペイロード（JSON 文字列）を構築する。
 * 改行を含まない（stdin は 1 行 = 1 リクエストの契約）。決定的。
 *
 * - params は paramKeys に載るキーだけを抽出。有限な数値だけを載せ、**非有限値（NaN/Inf）も
 *   欠損キーも『載せない』＝evaluate.py が default_params で補完する**。これにより非有限入力の
 *   扱いが serializeSubmission（非有限→initialCandidate 既定）と同方針（＝default へ寄せる）になり、
 *   payload と submission で補完が非対称（旧: payload は 0、submission は既定）になる問題を解消する。
 *   Python の JSON.parse は NaN/Inf を含まないので壊れない（載せないことで二重に保証）。
 * - games/opponents は 1 以上に、seed は整数に正規化（決定性のため）。
 * - opponents 既定 2（本番 3 人戦 = 候補 1 + 相手 2）。evaluate.py の _OPPONENTS_DEFAULT と一致。
 */
export function buildEvalPayload(candidate: Candidate, opts: EvalOptions = {}): string {
  const params: Candidate = {};
  for (const key of paramKeys) {
    const v = candidate[key];
    // 有限な数値のみ載せる。非有限（NaN/Inf）も欠損も載せない＝Python の default_params に委ねる
    // （serializeSubmission と同じ「default へ寄せる」方針で補完を対称化）。
    if (typeof v === "number" && Number.isFinite(v)) {
      params[key] = v;
    }
  }

  const payload: EvalPayload = {
    params,
    games: Math.max(1, Math.trunc(opts.games ?? 100)),
    seed: Math.trunc(opts.seed ?? 0),
    opponents: Math.max(1, Math.trunc(opts.opponents ?? 2)),
  };
  return JSON.stringify(payload);
}

/**
 * サイドカー stdout（{win_rate} の JSON）を fitness（0..1）にパースする。純ロジック・決定的。
 *
 * - 壊れた JSON / win_rate 欠如 / 数値でない / 非有限 → throw せず failFitness（既定 0）を返す
 *   （CLAUDE.md「単一ワーカーの失敗でループを止めない」＝低 fitness で最適化を続行）。
 * - win_rate は [0,1] にクランプ（評価器の汚染値が optimize を壊さないよう防御）。
 */
export function parseEvalResult(stdout: string, failFitness = 0): number {
  const trimmed = stdout.trim();
  if (!trimmed) return failFitness;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return failFitness; // 壊れ JSON は低 fitness（throw しない）
  }

  if (typeof parsed !== "object" || parsed === null) return failFitness;
  const wr = (parsed as Record<string, unknown>)["win_rate"];
  if (typeof wr !== "number" || !Number.isFinite(wr)) return failFitness;

  // [0,1] にクランプ（汚染値ガード）。
  return Math.min(1, Math.max(0, wr));
}

/**
 * best 候補を提出形（paramKeys 順・安定 diff）の JSON 文字列に整える。純ロジック・テスト対象。
 * 欠けキー/非有限は initialCandidate の既定値で補完する（提出物が常に 8 キー揃う）。
 */
export function serializeSubmission(best: Candidate): string {
  const ordered: Candidate = {};
  for (const key of paramKeys) {
    const v = best[key];
    ordered[key] = typeof v === "number" && Number.isFinite(v) ? v : initialCandidate[key];
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

// ───────── spawn I/O 層（テスト対象外・実プロセス）─────────

/**
 * 候補を評価して win_rate（= fitness, 大きいほど良い）を返す。numericOptimizer.EvaluateFn 互換。
 *
 * - spawn("python", ["quests/xq-7narabe/evaluate.py"]) に buildEvalPayload を stdin 投入。
 * - ハード timeout（crawl.ts と同方針: 超過で SIGKILL）。
 * - spawn 失敗 / 異常終了 / タイムアウト / 壊れ JSON は throw せず failFitness（既定 0）を返す。
 *   1 候補の評価が失敗しても最適化ループを止めない（partial-first / CLAUDE.md）。
 *
 * @param candidate 評価する数値 param の Record。
 * @param timeoutMs サイドカープロセスのハード timeout（ms）。
 * @param opts      games / seed / opponents / sidecarPath / python / failFitness。
 */
export function evaluate(
  candidate: Candidate,
  timeoutMs: number,
  opts: EvalOptions = {},
): Promise<number> {
  const sidecarPath = opts.sidecarPath ?? join(process.cwd(), EVALUATE_REL);
  const python = opts.python ?? "python";
  const failFitness = opts.failFitness ?? 0;
  const payload = buildEvalPayload(candidate, opts);

  return new Promise<number>((resolve) => {
    const child = spawn(python, [sidecarPath], {
      shell: IS_WIN, // Windows は python.exe / py ランチャを PATH 解決（crawl.ts と同形）。
      windowsHide: true,
    });

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
    // stderr は診断用（読み捨て）。win_rate は stdout のみ。
    child.stderr.on("data", () => {
      /* 診断は使わない（crawl.ts と同方針） */
    });
    child.on("error", () => {
      // spawn 失敗（python 不在等）。止めずに低 fitness。
      clearTimeout(timer);
      finish(failFitness);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        finish(failFitness); // タイムアウトは低 fitness
        return;
      }
      if (code !== 0 && code !== null) {
        finish(failFitness); // 非 0 終了（evaluate.py の致命エラー）は低 fitness
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

/**
 * 最良候補を提出物（dir/best_params.json）に書き出す。QuestAdapter.buildSubmission の同期実体。
 * 不可逆な submit/publish はしない（ファイル生成のみ＝CLAUDE.md レビューゲート）。
 * 書き出す JSON は serializeSubmission（paramKeys 順・8 キー保証・安定 diff）。
 */
export function writeSubmission(best: Candidate, dir: string): string {
  const path = join(dir, SUBMISSION_FILENAME);
  writeFileSync(path, serializeSubmission(best), "utf8");
  return path;
}

/**
 * questFramework に渡す QuestAdapter 実体（数値候補＝mutateNumeric:true）。
 * runQuest はこれを受け、mutateNumeric を見て numericOptimizer（ヒルクライム）で
 * paramKeys のベクタを seed 固定・決定的に進化させる。
 *
 * - evaluate は候補だけ受ける単引数版に閉じてある（timeout/games/seed 等は本アダプタ既定に固定）。
 *   framework は候補を渡すだけでよい（adapter は最適化器を知らない）。
 * - 既定 timeout は 30s（1 候補 = 多数局のシミュレーションでも十分・crawl/battle と同オーダー）。
 */
export const xqAdapter: QuestAdapter<Candidate> = {
  questId: "xq-7narabe",
  paramKeys: [...paramKeys],
  mutateNumeric: true,
  initialCandidate(): Candidate {
    return { ...initialCandidate };
  },
  evaluate(c: Candidate): Promise<number> {
    return evaluate(c, 30_000);
  },
  buildSubmission(best: Candidate, dir: string): void {
    writeSubmission(best, dir);
  },
};
