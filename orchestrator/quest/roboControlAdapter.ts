/**
 * Robo Quest「2輪到達タスク（robo-control）」を questFramework の QuestAdapter として
 * Taikai-killer の数値最適化トラック（D18 ①: LLM 不要）に繋ぐ TS ブリッジ。
 *
 * これは「標準ハーネスの汎用性証明 2」: X Quest（7並べ・対戦ゲーム）と全く違う毛色の
 * ロボ制御（自己完結シミュ）を、**同じ QuestAdapter<NumericCandidate> 契約**で実装できる
 * ことを示す。最適化器・runQuest・provenance は無改変で共有し、差分は本アダプタ＋
 * Python サイドカー（quests/robo-control/evaluate.py）だけに閉じる（docs/quests.md §2.1）。
 *
 * 正本: orchestrator/quest/adapter.ts（QuestAdapter<Candidate> の契約）/
 *       orchestrator/quest/runQuest.ts（数値候補は mutateNumeric=true で numericOptimizer 直結）/
 *       orchestrator/quest/xqAdapter.ts・orchestrator/crawl.ts の Python サイドカー spawn 作法。
 *
 * 方針（譲れない条件・xqAdapter.ts と同形）:
 * - 評価本体は Python サイドカー（quests/robo-control/evaluate.py）に委譲。ここは spawn して
 *   候補（制御ゲインの Record）を stdin に 1 行 JSON（{params,episodes,seed}）で渡し、
 *   stdout の {score} を読むだけ。score は「大きいほど良い」fitness としてそのまま返す。
 * - crawl.ts / xqAdapter.ts と同形: spawn / stdin 投入 / ハード timeout（超過は SIGKILL）/
 *   純ロジック（payload 構築 buildEvalPayload・結果パース parseEvalResult・提出整形
 *   serializeSubmission）を named export して vitest で固める。spawn 自体はテスト対象外。
 * - 堅牢性: 壊れた JSON / タイムアウト / 異常終了 / spawn 失敗は throw せず **低 fitness（既定 0）**
 *   を返す（CLAUDE.md「単一ワーカーの失敗でループを止めない」＝1 候補の評価失敗で最適化を止めない）。
 *
 * QuestAdapter 型（adapter.ts）を import（読むだけ）して roboControlAdapter がその契約を満たす。
 * runQuest は mutateNumeric=true を見て numericOptimizer（ヒルクライム）でこの候補を進化させる。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { NumericCandidate, QuestAdapter } from "./adapter.ts";

const IS_WIN = process.platform === "win32";

/** サイドカー実行パス（リポジトリルートからの相対）。xqAdapter.ts の EVALUATE_REL と同形。 */
const EVALUATE_REL = join("quests", "robo-control", "evaluate.py");

/** buildSubmission が dir 内に書く提出ファイル名。 */
export const SUBMISSION_FILENAME = "best_params.json";

/**
 * 候補のチューニング対象 paramKey（5 個・evaluate.py / sim.py PARAM_KEYS と 1:1・同順）。
 * runQuest はこのキー集合を初期点に使い numericOptimizer で摂動する。
 */
export const paramKeys = [
  "kp_lin", // 距離 → 前進速度の比例ゲイン（大きいほど積極的に前進）。
  "kp_ang", // 角度差 → 角速度の比例ゲイン（大きいほど速く向きを合わせる）。
  "kd_ang", // 角度差の微分ゲイン（旋回の振動抑制・オーバーシュート軽減）。
  "align_thresh", // この角度差（rad）を超える間は前進を絞り旋回優先（向き合わせの保守度）。
  "v_cruise", // 前進速度の上限スケール（0..1・v_max への割合。攻め/守りのトレードオフ）。
] as const;

/** paramKeys の要素型。 */
export type ParamKey = (typeof paramKeys)[number];

/** 候補＝数値 param の Record（adapter.NumericCandidate = Record<string, number> と互換）。 */
export type Candidate = NumericCandidate;

/**
 * 初期候補（既定ゲイン・sim.py default_params と 1:1・同値）。
 * QuestAdapter.initialCandidate() がこのコピーを返す。
 *
 * 注意: これらの既定ゲインは**最適とは限らない**（手調整の局所点）。初期点は探索の出発点に
 * 過ぎず、numericOptimizer（ヒルクライム＋リスタート）がこの局所点を脱出してゲイン・閾値を
 * 直す前提（手動チューニングを自動探索で超える、の核）。
 */
export const initialCandidate: Readonly<Record<ParamKey, number>> = {
  kp_lin: 0.8,
  kp_ang: 2.0,
  kd_ang: 0.3,
  align_thresh: 0.6,
  v_cruise: 0.7,
} as const;

/** evaluate() のオプション（エピソード数・seed・timeout・サイドカーパス差し替え）。 */
export interface EvalOptions {
  /** 評価するエピソード数（>=1）。多いほど分散が減るが遅い。既定 100。 */
  episodes?: number;
  /** 乱数 seed（決定性の要。固定すれば score も固定）。既定 0。 */
  seed?: number;
  /** サイドカー（evaluate.py）のパス。テスト/差し替え用。既定 cwd/quests/robo-control/evaluate.py。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定 "python"）。 */
  python?: string;
  /** spawn 失敗/壊れ JSON/タイムアウト時に返す低 fitness。既定 0。 */
  failFitness?: number;
}

/** サイドカーに stdin で渡す 1 行 JSON ペイロードの形（evaluate.py の入力契約と 1:1）。 */
export interface EvalPayload {
  params: Candidate;
  episodes: number;
  seed: number;
}

// ───────── 純ロジック（テスト対象）─────────

/**
 * 候補とオプションから stdin ペイロード（JSON 文字列）を構築する。
 * 改行を含まない（stdin は 1 行 = 1 リクエストの契約）。決定的。
 *
 * - params は paramKeys に載るキーだけを抽出。有限な数値だけを載せ、**非有限値（NaN/Inf）も
 *   欠損キーも『載せない』＝evaluate.py が default_params で補完する**（serializeSubmission の
 *   「default へ寄せる」方針と対称）。Python の JSON.parse は NaN/Inf を含まないので壊れない。
 * - episodes は 1 以上に、seed は整数に正規化（決定性のため）。
 */
export function buildEvalPayload(candidate: Candidate, opts: EvalOptions = {}): string {
  const params: Candidate = {};
  for (const key of paramKeys) {
    const v = candidate[key];
    // 有限な数値のみ載せる。非有限（NaN/Inf）も欠損も載せない＝Python の default_params に委ねる。
    if (typeof v === "number" && Number.isFinite(v)) {
      params[key] = v;
    }
  }

  const payload: EvalPayload = {
    params,
    episodes: Math.max(1, Math.trunc(opts.episodes ?? 100)),
    seed: Math.trunc(opts.seed ?? 0),
  };
  return JSON.stringify(payload);
}

/**
 * サイドカー stdout（{score} の JSON）を fitness にパースする。純ロジック・決定的。
 *
 * - 壊れた JSON / score 欠如 / 数値でない / 非有限 → throw せず failFitness（既定 0）を返す
 *   （CLAUDE.md「単一ワーカーの失敗でループを止めない」＝低 fitness で最適化を続行）。
 * - score は下限 0 にクランプ（評価器の汚染値が optimize を壊さないよう防御）。報酬は到達時に
 *   1 付近、未到達で 0 付近なので上限クランプは設けない（将来 base_success 変更に追従するため）。
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

  // 下限 0 にクランプ（負の汚染値ガード）。
  return Math.max(0, score);
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
 * 候補を評価して score（= fitness, 大きいほど良い）を返す。numericOptimizer.EvaluateFn 互換。
 *
 * - spawn("python", ["quests/robo-control/evaluate.py"]) に buildEvalPayload を stdin 投入。
 * - ハード timeout（crawl.ts / xqAdapter.ts と同方針: 超過で SIGKILL）。
 * - spawn 失敗 / 異常終了 / タイムアウト / 壊れ JSON は throw せず failFitness（既定 0）を返す。
 *   1 候補の評価が失敗しても最適化ループを止めない（partial-first / CLAUDE.md）。
 *
 * @param candidate 評価する制御ゲインの Record。
 * @param timeoutMs サイドカープロセスのハード timeout（ms）。
 * @param opts      episodes / seed / sidecarPath / python / failFitness。
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
      shell: IS_WIN, // Windows は python.exe / py ランチャを PATH 解決（xqAdapter.ts と同形）。
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
 * paramKeys のベクタを seed 固定・決定的に進化させる。
 *
 * - evaluate は候補だけ受ける単引数版に閉じてある（timeout/episodes/seed 等は本アダプタ既定に固定）。
 *   framework は候補を渡すだけでよい（adapter は最適化器を知らない）。
 * - 既定 timeout は 30s（1 候補 = 多数エピソードのシミュでも十分・crawl/xq と同オーダー）。
 */
export const roboControlAdapter: QuestAdapter<Candidate> = {
  questId: "robo-control",
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
