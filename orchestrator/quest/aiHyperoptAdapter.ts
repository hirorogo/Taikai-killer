/**
 * AI Quest「ハイパーパラメータ最適化（ai-hyperopt）」を questFramework の QuestAdapter として
 * Taikai-killer の数値最適化トラック（D18 ①: LLM 不要）に繋ぐ TS ブリッジ。
 *
 * これは「QuestAdapter フレームワークの汎用性証明」: ゲーム AI（xqAdapter）と全く同じ抽象
 * （候補→評価→最適化→提出）で、毛色の違う ML ハイパラ最適化を回せることを示す。差分は
 * 「候補キー（ハイパラ）・評価サイドカー（evaluate.py = held-out 精度）・提出物」だけで、
 * 最適化器（numericOptimizer）・runQuest は xqAdapter と完全共有する。
 *
 * 正本: orchestrator/quest/adapter.ts（QuestAdapter<Candidate> の契約）/
 *       orchestrator/quest/runQuest.ts（数値候補は mutateNumeric=true で numericOptimizer 直結）/
 *       orchestrator/quest/xqAdapter.ts・orchestrator/crawl.ts の Python サイドカー spawn 作法。
 * 設計の正: docs/quests.md（AI = ハイパラ + 検証精度 / held-out / fitness は大きいほど良い）。
 *
 * 方針（譲れない条件・xqAdapter と同形）:
 * - 評価本体は Python サイドカー（quests/ai-hyperopt/evaluate.py）に委譲。ここは spawn して
 *   候補（数値ハイパラの Record）を stdin に 1 行 JSON（{params,seed}）で渡し、stdout の
 *   {score}（= held-out 検証精度）を読むだけ。score は「大きいほど良い」fitness としてそのまま返す。
 * - crawl.ts / xqAdapter.ts と同形: spawn / stdin 投入 / ハード timeout（超過は SIGKILL）/
 *   純ロジック（payload 構築 buildEvalPayload・結果パース parseEvalResult・提出物整形
 *   serializeSubmission）を named export して vitest で固める。spawn 自体はテスト対象外。
 * - 外部データセット不要の自己完結: evaluate.py が seed 固定で合成データを生成するので、
 *   このアダプタは候補ハイパラと seed を渡すだけ。決定的（seed 固定で score bit 一致）。
 * - 堅牢性: 壊れた JSON / タイムアウト / 異常終了 / spawn 失敗は throw せず **低 fitness（既定 0）**
 *   を返す（CLAUDE.md「単一ワーカーの失敗でループを止めない」）。
 *
 * default 禁止 ＝ named export、.ts 拡張子 import、型は import type（verbatimModuleSyntax）。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { NumericCandidate, QuestAdapter } from "./adapter.ts";

const IS_WIN = process.platform === "win32";

/** サイドカー実行パス（リポジトリルートからの相対）。crawl.ts/xqAdapter.ts の REL と同形。 */
const EVALUATE_REL = join("quests", "ai-hyperopt", "evaluate.py");

/** buildSubmission が dir 内に書く提出ファイル名（best ハイパラ）。 */
export const SUBMISSION_FILENAME = "best_params.json";

/**
 * 候補のチューニング対象 paramKey（5 個・evaluate.py PARAM_KEYS と 1:1・同順）。
 * runQuest はこのキー集合を初期点に使い numericOptimizer で摂動する。
 */
export const paramKeys = [
  "lr", // 学習率（>0。大きすぎると発散、小さすぎると未収束）
  "reg", // L2 正則化係数（>=0。過学習抑制）
  "hidden", // 隠れ層ユニット数（0 = 線形ロジスティック回帰、>0 = 1 隠れ層 MLP）
  "epochs", // 全バッチ勾配降下の反復回数（>=1）
  "init_scale", // 重み初期化スケール（>0）
] as const;

/** paramKeys の要素型。 */
export type ParamKey = (typeof paramKeys)[number];

/** 候補＝数値ハイパラの Record（adapter.NumericCandidate = Record<string, number> と互換）。 */
export type Candidate = NumericCandidate;

/**
 * 初期候補（evaluate.py _DEFAULT_PARAMS と 1:1・同値）。QuestAdapter.initialCandidate() が
 * このコピーを返す。numericOptimizer がこの出発点からヒルクライムで held-out 精度を上げる。
 *
 * 注意: 初期点は探索の出発点に過ぎず最適ではない。合成データは XOR 風の非線形構造を持つので
 * hidden を上げる/epochs を増やす/lr を調整する方向に score が伸びる勾配がある（README 参照）。
 */
export const initialCandidate: Readonly<Record<ParamKey, number>> = {
  lr: 0.05,
  reg: 0.001,
  hidden: 8,
  epochs: 200,
  init_scale: 0.1,
} as const;

/** evaluate() のオプション（seed・timeout・サイドカーパス差し替え）。 */
export interface EvalOptions {
  /** 乱数 seed（決定性の要。固定すれば合成データ・初期重みが固定され score も固定）。既定 0。 */
  seed?: number;
  /** サイドカー（evaluate.py）のパス。テスト/差し替え用。既定 cwd/quests/ai-hyperopt/evaluate.py。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定 "python"）。 */
  python?: string;
  /** spawn 失敗/壊れ JSON/タイムアウト時に返す低 fitness。既定 0。 */
  failFitness?: number;
}

/** サイドカーに stdin で渡す 1 行 JSON ペイロードの形（evaluate.py の入力契約と 1:1）。 */
export interface EvalPayload {
  params: Candidate;
  seed: number;
}

// ───────── 純ロジック（テスト対象）─────────

/**
 * 候補とオプションから stdin ペイロード（JSON 文字列）を構築する。
 * 改行を含まない（stdin は 1 行 = 1 リクエストの契約）。決定的。
 *
 * - params は paramKeys に載るキーだけを抽出。有限な数値だけを載せ、**非有限値（NaN/Inf）も
 *   欠損キーも『載せない』＝evaluate.py が _DEFAULT_PARAMS で補完する**（serializeSubmission の
 *   「非有限→initialCandidate 既定」と同方針で補完を対称化する。xqAdapter と同設計）。
 *   Python の JSON.parse は NaN/Inf を含まないので壊れない（載せないことで二重に保証）。
 * - seed は整数に正規化（決定性のため）。
 */
export function buildEvalPayload(candidate: Candidate, opts: EvalOptions = {}): string {
  const params: Candidate = {};
  for (const key of paramKeys) {
    const v = candidate[key];
    // 有限な数値のみ載せる。非有限（NaN/Inf）も欠損も載せない＝Python の _DEFAULT_PARAMS に委ねる。
    if (typeof v === "number" && Number.isFinite(v)) {
      params[key] = v;
    }
  }

  const payload: EvalPayload = {
    params,
    seed: Math.trunc(opts.seed ?? 0),
  };
  return JSON.stringify(payload);
}

/**
 * サイドカー stdout（{score} の JSON）を fitness（0..1）にパースする。純ロジック・決定的。
 *
 * - 壊れた JSON / score 欠如 / 数値でない / 非有限 → throw せず failFitness（既定 0）を返す
 *   （CLAUDE.md「単一ワーカーの失敗でループを止めない」＝低 fitness で最適化を続行）。
 * - score（held-out 精度）は [0,1] にクランプ（評価器の汚染値が optimize を壊さないよう防御）。
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
  const score = (parsed as Record<string, unknown>)["score"];
  if (typeof score !== "number" || !Number.isFinite(score)) return failFitness;

  // [0,1] にクランプ（汚染値ガード。精度なので本来 [0,1] だが防御的に丸める）。
  return Math.min(1, Math.max(0, score));
}

/**
 * best 候補を提出形（paramKeys 順・安定 diff）の JSON 文字列に整える。純ロジック・テスト対象。
 * 欠けキー/非有限は initialCandidate の既定値で補完する（提出物が常に 5 キー揃う）。
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
 * 候補を評価して score（= held-out 検証精度, 大きいほど良い fitness）を返す。
 * numericOptimizer.EvaluateFn 互換。
 *
 * - spawn("python", ["quests/ai-hyperopt/evaluate.py"]) に buildEvalPayload を stdin 投入。
 * - ハード timeout（crawl.ts/xqAdapter.ts と同方針: 超過で SIGKILL）。
 * - spawn 失敗 / 異常終了 / タイムアウト / 壊れ JSON は throw せず failFitness（既定 0）を返す。
 *   1 候補の評価が失敗しても最適化ループを止めない（partial-first / CLAUDE.md）。
 *
 * @param candidate 評価する数値ハイパラの Record。
 * @param timeoutMs サイドカープロセスのハード timeout（ms）。
 * @param opts      seed / sidecarPath / python / failFitness。
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
    // stderr は診断用（読み捨て）。score は stdout のみ。
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
 * 書き出す JSON は serializeSubmission（paramKeys 順・5 キー保証・安定 diff）。
 */
export function writeSubmission(best: Candidate, dir: string): string {
  const path = join(dir, SUBMISSION_FILENAME);
  writeFileSync(path, serializeSubmission(best), "utf8");
  return path;
}

/**
 * questFramework に渡す QuestAdapter 実体（数値候補＝mutateNumeric:true）。
 * runQuest はこれを受け、mutateNumeric を見て numericOptimizer（ヒルクライム）で
 * paramKeys のベクタを seed 固定・決定的に進化させる（xqAdapter と完全共有の最適化器）。
 *
 * - evaluate は候補だけ受ける単引数版に閉じてある（timeout/seed 等は本アダプタ既定に固定）。
 *   framework は候補を渡すだけでよい（adapter は最適化器を知らない）。
 * - 既定 timeout は 30s（1 候補 = 合成データ学習でも十分・crawl/xq と同オーダー）。
 */
export const aiHyperoptAdapter: QuestAdapter<Candidate> = {
  questId: "ai-hyperopt",
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
