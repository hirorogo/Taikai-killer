/**
 * coevolve: X Quest「七並べ」自己対戦コオエボリューション本体（FunSearch/AlphaEvolve 型）。
 * 正本: docs/quests.md §4（X Quest・自己対戦の順位点 fitness）/ docs/decisions.md「進化（D18）」/
 *       orchestrator/quest/populationGA.ts（個体群 GA・import して読むだけ）/
 *       orchestrator/quest/xqAdapter.ts・orchestrator/crawl.ts（Python サイドカー spawn 作法）。
 *
 * 位置づけ:
 * - numericOptimizer（ヒルクライム）/ populationGA（個体群 GA）は「固定の評価器に対し候補を
 *   最大化」する。本モジュールは一段上の **コオエボリューション**: 「現 champion に勝つ challenger
 *   を探し、勝ち越したら champion を交代（世代交代）」を round で繰り返す自己対戦ループ。
 *   1 round 内の challenger 探索には populationGA を **無改変で再利用**する（評価器に
 *   「候補 → 対 champion 勝率」を渡すだけ）。
 *
 * 流れ（決定的・seed 固定で完全再現）:
 *   (1) champion = ai_param の default params（initialChampion）から開始。
 *   (2) 各 round: populationGA で「challenger を現 champion に対して勝率最大化」探索する。
 *       fitness は evaluate_coevo.py を spawn（stdin {challenger,opponent:champion,games,seed}
 *       → win_rate）して得る。
 *   (3) round 終了後、最良 challenger を champion に対して再評価し、win_rate > 0.5 + promoteMargin
 *       なら champion を交代する（世代交代）。
 *   (4) 各 round の champion 勝率推移を返し、最終 champion を
 *       quests/xq-7narabe/champion_params.json に書く。
 *
 * 譲れない条件（CLAUDE.md / xqAdapter.ts を継承）:
 * - **LLM を一切呼ばない純ロジック**。spawn するのは evaluate_coevo.py（決定的）のみ。
 * - **決定的**: seed・round・generation から派生する seed で全乱数を固定（bit 一致再現）。
 *   Date.now / Math.random 非依存（populationGA 内部は createRng=mulberry32）。
 * - **spawn I/O は throw しない**。壊れ JSON / タイムアウト / 異常終了 / spawn 失敗は低 fitness
 *   （既定 0）を返し、1 候補の評価失敗でコオエボリューションを止めない（partial-first）。
 * - **純ロジック（buildCoevoPayload / parseCoevoResult / shouldPromote / 推移整形）を named
 *   export してテスト**。spawn 自体はテスト対象外（実プロセス）。
 *
 * CLI 配線（index.ts）は別担当。本ファイルは関数 export のみ（default 禁止）。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { populationGA } from "./populationGA.ts";
import type { GACandidate } from "./populationGA.ts";
import { mapConcurrent } from "./parallelEval.ts";

const IS_WIN = process.platform === "win32";

/** サイドカー実行パス（リポジトリルートからの相対）。xqAdapter.EVALUATE_REL と同形。 */
const EVALUATE_COEVO_REL = join("quests", "xq-7narabe", "evaluate_coevo.py");

/** writeChampion が書く提出ファイル名。 */
export const CHAMPION_FILENAME = "champion_params.json";

/** 提出先 dir（既定）。quests/xq-7narabe/。 */
const CHAMPION_DIR_REL = join("quests", "xq-7narabe");

/**
 * チューニング対象 paramKey（8 個・ai_param.PARAM_KEYS / xqAdapter.paramKeys と 1:1・同順）。
 * champion / challenger はこのキー集合の数値 Record。
 */
export const paramKeys = [
  "w_edge_distance",
  "w_blocking",
  "w_rank_extreme",
  "w_hold_seven_adj",
  "w_suit_balance",
  "w_pass_reserve",
  "w_release_urgency",
  "w_random_jitter",
] as const;

/** paramKeys の要素型。 */
export type ParamKey = (typeof paramKeys)[number];

/** 候補＝数値 param の Record（populationGA.GACandidate と互換）。 */
export type Params = GACandidate;

/**
 * 初期 champion（ai_param.default_params() と 1:1・同値）。
 * default は対 random 勝率を実測で最大化した手調整の出発点（ai_param.py docstring 参照）。
 * コオエボリューションはここから「自分自身に勝つ」探索を round で重ねて強くしていく。
 */
export const initialChampion: Readonly<Record<ParamKey, number>> = {
  w_edge_distance: 1.0,
  w_blocking: 1.5,
  w_rank_extreme: 0.3,
  w_hold_seven_adj: 0.4,
  w_suit_balance: 2.5,
  w_pass_reserve: 1.0,
  w_release_urgency: 1.2,
  w_random_jitter: 0.05,
} as const;

// ───────── 純ロジック（テスト対象）─────────

/** evaluate_coevo.py に stdin で渡す 1 行 JSON ペイロードの形（評価器の入力契約と 1:1）。 */
export interface CoevoPayload {
  challenger: Params;
  opponent: Params;
  games: number;
  seed: number;
}

/** buildCoevoPayload / evaluateCoevo のオプション。 */
export interface CoevoEvalOptions {
  /** 評価する局数（>=1）。多いほど分散が減るが遅い。既定 100。 */
  games?: number;
  /** 乱数 seed（決定性の要）。既定 0。 */
  seed?: number;
  /** サイドカー（evaluate_coevo.py）のパス。テスト/差し替え用。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定 "python"）。 */
  python?: string;
  /** spawn 失敗/壊れ JSON/タイムアウト時に返す低 fitness。既定 0。 */
  failFitness?: number;
}

/**
 * params から paramKeys に載るキーだけを抽出し、有限な数値のみ載せた Record を返す。純ロジック。
 * 非有限（NaN/Inf）も欠損キーも『載せない』＝evaluate_coevo.py / ai_param が default_params で補完。
 * xqAdapter.buildEvalPayload と同方針（payload に NaN/Inf を混ぜず Python JSON.parse を壊さない）。
 */
function pickFiniteParams(params: Params): Params {
  const out: Params = {};
  for (const key of paramKeys) {
    const v = params[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = v;
    }
  }
  return out;
}

/**
 * challenger / champion と opts から stdin ペイロード（1 行 JSON 文字列）を構築する。純ロジック・決定的。
 *
 * - challenger / opponent は paramKeys のみ・有限値のみ載せる（Python default に委ねる補完を対称化）。
 * - games は 1 以上に、seed は整数に正規化（決定性のため）。
 * - 改行を含まない（stdin は 1 行 = 1 リクエストの契約）。
 */
export function buildCoevoPayload(
  challenger: Params,
  champion: Params,
  opts: CoevoEvalOptions = {},
): string {
  const payload: CoevoPayload = {
    challenger: pickFiniteParams(challenger),
    opponent: pickFiniteParams(champion),
    games: Math.max(1, Math.trunc(opts.games ?? 100)),
    seed: Math.trunc(opts.seed ?? 0),
  };
  return JSON.stringify(payload);
}

/**
 * サイドカー stdout（{win_rate} の JSON）を fitness（0..1）にパースする。純ロジック・決定的。
 * xqAdapter.parseEvalResult と同形:
 * - 壊れた JSON / win_rate 欠如 / 非数値 / 非有限 → throw せず failFitness（既定 0）。
 * - win_rate は [0,1] にクランプ（汚染値ガード）。
 */
export function parseCoevoResult(stdout: string, failFitness = 0): number {
  const trimmed = stdout.trim();
  if (!trimmed) return failFitness;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return failFitness;
  }

  if (typeof parsed !== "object" || parsed === null) return failFitness;
  const wr = (parsed as Record<string, unknown>)["win_rate"];
  if (typeof wr !== "number" || !Number.isFinite(wr)) return failFitness;

  return Math.min(1, Math.max(0, wr));
}

/**
 * 昇格判定（世代交代するか）。純ロジック・決定的。
 *
 * 最良 challenger の対 champion 勝率（順位点 fitness, [0,1]）が 0.5 + promoteMargin を**厳密に
 * 上回る**とき true（＝champion を challenger に置き換える）。自己対戦の中位（互角）は順位点 0.5
 * なので、0.5 + margin を超えてはじめて「明確に勝ち越した」とみなす。
 *
 * - promoteMargin は [0, 0.5) にクランプ（負値や 0.5 以上は無意味＝閾値が [0.5,1) に収まるよう保護）。
 * - 非有限な winRate は false（評価失敗で誤って昇格しない）。
 *
 * @param challengerWinRate 最良 challenger の対 champion 勝率（順位点 fitness）。
 * @param promoteMargin     0.5 に上乗せする昇格マージン（既定 0.02）。
 */
export function shouldPromote(
  challengerWinRate: number,
  promoteMargin = 0.02,
): boolean {
  if (!Number.isFinite(challengerWinRate)) return false;
  const margin = Math.min(0.5 - Number.EPSILON, Math.max(0, promoteMargin));
  return challengerWinRate > 0.5 + margin;
}

/**
 * 殿堂（Hall of Fame）= 過去 champion のアーカイブを上限 size に保つ。純ロジック・決定的。
 *
 * 単一の latest champion だけを相手にすると、A に勝つ B・B に勝つ C・C に勝つ A …という
 * **循環（intransitivity）**で champion が振動し、過去に倒した相手に再び負ける「忘却」が起きる
 * （実測: champion 対 medium が default 0.480→0.458 と微減した drift の正体）。アーカイブに
 * 過去 champion を保持し、昇格判定をアーカイブ平均勝率にすることで「古い強者にも勝てる」ことを
 * 要求し、循環的な後退を抑える（co-evolution の標準対策＝対戦相手の多様化）。
 *
 * - 直近を優先して末尾 size 件を残す（古い順に押し出す＝FIFO で最新世代を厚く保つ）。
 * - size<=0 は空配列（アーカイブ無効＝latest だけで戦う旧挙動に縮退できるよう保護）。
 * - 各要素は呼び出し側でコピー済み前提だが、防御的に shallow copy して返す（共有参照汚染を断つ）。
 */
export function capArchive(archive: readonly Params[], size: number): Params[] {
  const n = Math.max(0, Math.trunc(size));
  if (n === 0) return [];
  const kept = archive.length > n ? archive.slice(archive.length - n) : archive.slice();
  return kept.map((p) => ({ ...p }));
}

/**
 * 勝率配列の平均（アーカイブ平均勝率）を返す。純ロジック・決定的。
 * 空配列は 0.5（互角＝中立。アーカイブが空のとき昇格を「明確な勝ち越し」要求で誤判定しない）。
 * 非有限値は 0.5 に丸めてから平均（評価失敗を中立に倒し、NaN 伝播で平均を壊さない）。
 */
export function meanWinRate(rates: readonly number[]): number {
  if (rates.length === 0) return 0.5;
  let sum = 0;
  for (const r of rates) sum += Number.isFinite(r) ? r : 0.5;
  return sum / rates.length;
}

/** 1 round の結果（来歴・推移整形のための素データ）。 */
export interface CoevoRound {
  /** round 番号（1-based）。 */
  round: number;
  /** この round の最良 challenger の対（round 開始時）champion 勝率。 */
  challengerWinRate: number;
  /**
   * 最良 challenger の殿堂（アーカイブ）平均勝率（昇格判定に使った値）。
   * アーカイブ無効（archiveSize<=0）のときは challengerWinRate と同値。
   */
  archiveWinRate: number;
  /** 昇格したか（shouldPromote の結果）。 */
  promoted: boolean;
  /** この round 終了時点の champion（昇格していれば新 champion、しなければ据え置き）。 */
  champion: Params;
  /** この round 終了時点の殿堂サイズ（保持している過去 champion 数）。 */
  archiveSize: number;
}

/** coevolveXq の結果。 */
export interface CoevolveResult {
  /** 最終 champion（全 round 後）。 */
  champion: Params;
  /** 各 round の素データ（昇格判定・challenger 勝率・その時点 champion）。 */
  rounds: CoevoRound[];
  /**
   * champion 勝率の推移（整形済み）。各 round で「昇格したら新 champion の殿堂平均勝率
   * （=archiveWinRate）、昇格しなければ 0.5（互角＝据え置き champion の自己対戦中位）」を
   * 並べた配列。「champion がどれだけ強くなっていったか」の単調傾向を読むための系列。
   */
  trajectory: number[];
  /** 最終的な殿堂（Hall of Fame）= 保持している過去 champion 群（直近優先・末尾が最新）。 */
  archive: Params[];
  /** 提出物（champion_params.json）を書いたパス（書いていなければ undefined）。 */
  submissionPath?: string;
}

/**
 * round 群から champion 勝率の推移（trajectory）を整形する。純ロジック・決定的。
 *
 * 各 round について:
 * - 昇格した round は challengerWinRate（新 champion がその時点で示した勝ち越し勝率）を載せる。
 * - 昇格しなかった round は 0.5（champion 据え置き＝互角に押し返した＝自己対戦中位）を載せる。
 *
 * これにより「champion がどの round で・どれだけ勝ち越して交代したか」が系列で読める
 * （>0.5 のスパイク＝世代交代、0.5 ＝防衛）。昇格は殿堂平均勝率で判定するので、スパイク値も
 * archiveWinRate（過去 champion 群への総合的な勝ち越し）を採る。
 */
export function summarizeTrajectory(rounds: readonly CoevoRound[]): number[] {
  return rounds.map((r) => (r.promoted ? r.archiveWinRate : 0.5));
}

/**
 * best challenger を提出形（paramKeys 順・安定 diff）の JSON 文字列に整える。純ロジック・テスト対象。
 * 欠けキー/非有限は initialChampion の既定値で補完する（提出物が常に 8 キー揃う）。
 * xqAdapter.serializeSubmission と同方針。
 */
export function serializeChampion(champion: Params): string {
  const ordered: Params = {};
  for (const key of paramKeys) {
    const v = champion[key];
    ordered[key] =
      typeof v === "number" && Number.isFinite(v) ? v : initialChampion[key];
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}

// ───────── spawn I/O 層（テスト対象外・実プロセス）─────────

/**
 * challenger を champion に対して評価し win_rate（= fitness, 大きいほど良い）を返す。
 *
 * - spawn("python", ["quests/xq-7narabe/evaluate_coevo.py"]) に buildCoevoPayload を stdin 投入。
 * - ハード timeout（crawl.ts / xqAdapter.ts と同方針: 超過で SIGKILL）。
 * - spawn 失敗 / 異常終了 / タイムアウト / 壊れ JSON は throw せず failFitness（既定 0）を返す
 *   （CLAUDE.md「単一ワーカーの失敗でループを止めない」）。
 */
export function evaluateCoevo(
  challenger: Params,
  champion: Params,
  timeoutMs: number,
  opts: CoevoEvalOptions = {},
): Promise<number> {
  const sidecarPath = opts.sidecarPath ?? join(process.cwd(), EVALUATE_COEVO_REL);
  const python = opts.python ?? "python";
  const failFitness = opts.failFitness ?? 0;
  const payload = buildCoevoPayload(challenger, champion, opts);

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
    child.stderr.on("data", () => {
      /* 診断は使わない（crawl.ts と同方針） */
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(failFitness); // spawn 失敗（python 不在等）。止めずに低 fitness。
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
      finish(parseCoevoResult(stdout, failFitness));
    });

    child.stdin.on("error", () => {
      /* EPIPE 等は close 側で処理 */
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/**
 * 最終 champion を提出物（dir/champion_params.json）に書き出す。同期・ファイル生成のみ。
 * 不可逆な submit/publish はしない（CLAUDE.md レビューゲート）。
 * 書き出す JSON は serializeChampion（paramKeys 順・8 キー保証・安定 diff）。
 */
export function writeChampion(champion: Params, dir: string): string {
  const path = join(dir, CHAMPION_FILENAME);
  writeFileSync(path, serializeChampion(champion), "utf8");
  return path;
}

// ───────── コオエボリューション本体 ─────────

/** coevolveXq のオプション。 */
export interface CoevolveOptions {
  /** 擬似乱数 seed（固定で完全再現。round/generation 派生 seed の基点）。 */
  seed: number;
  /** round 数（>=1）。各 round で challenger 探索 → 昇格判定。 */
  rounds: number;
  /** 1 round の populationGA の個体数（>=1）。 */
  popSize: number;
  /** 1 round の populationGA の世代数（>=0）。 */
  generations: number;
  /** 1 候補評価あたりの対戦局数（>=1・evaluate_coevo.py に渡す games）。 */
  games: number;
  /**
   * 昇格マージン（0.5 に上乗せ・[0,0.5) にクランプ）。既定 0.02。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  promoteMargin?: number;
  /**
   * 殿堂（Hall of Fame）サイズ = 昇格判定で対戦する過去 champion の保持上限。既定 4。
   * 最良 challenger は「直近 champion に勝つ」だけでなく「保持中の過去 champion 群への平均勝率が
   * 0.5+margin を超える」ことを要求され、循環的な後退（intransitivity drift）を抑える。
   * 0 にすると殿堂無効＝直近 champion だけで戦う旧挙動に縮退する。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  archiveSize?: number;
  /**
   * 殿堂評価の並行度（best challenger を各殿堂メンバーに対し並行 spawn する上限）。既定 4。
   * 各メンバー評価は独立 Python プロセスで I/O 律速なので並行化で壁時計を縮める（parallelEval）。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  archiveConcurrency?: number;
  /**
   * 提出物（champion_params.json）の書き出し先 dir。既定 quests/xq-7narabe。
   * 書き出しを抑止したいテスト等は writeSubmission:false を使う。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  submissionDir?: string;
  /** champion_params.json を書くか（既定 true）。テストで副作用を抑止できる。 */
  writeSubmission?: boolean;
  /** evaluate_coevo.py のパス（テスト/差し替え用）。 */
  sidecarPath?: string;
  /** 起動する python 実行ファイル（既定 "python"）。 */
  python?: string;
  /** 1 候補評価のハード timeout（ms）。既定 60_000。 */
  timeoutMs?: number;
  /**
   * 評価関数の差し替え（テスト用 = spawn を回避して決定的に駆動する）。
   * (challenger, champion, seed) → win_rate を返す。未指定なら evaluateCoevo（spawn）を使う。
   * exactOptionalPropertyTypes: 値があるときだけ渡す。
   */
  evalFn?: (challenger: Params, champion: Params, seed: number) => Promise<number>;
}

/**
 * 1 round の探索 seed を seed/round から決定的に派生する（round ごとに違う系列・再現可能）。
 * populationGA に渡す seed。Date.now 非依存。
 */
function roundSeed(baseSeed: number, round: number): number {
  // 32bit に畳んで populationGA.createRng（mulberry32）が扱える整数にする。
  return (Math.trunc(baseSeed) * 1_000_003 + round * 2_654_435_761) >>> 0;
}

/**
 * 自己対戦コオエボリューション本体（FunSearch/AlphaEvolve 型）。
 *
 * 各 round:
 *   1. 現 champion を相手に「challenger を勝率最大化」する探索を populationGA で回す
 *      （fitness = evalFn(challenger, champion, seed)＝対 champion の順位点勝率）。探索の
 *      勾配は直近 champion で取る（強いシグナル・spawn 最小）。
 *   2. 最良 challenger を**殿堂（Hall of Fame）= 保持中の過去 champion 群**それぞれに対して
 *      並行評価し、平均勝率（archiveWinRate）を取る（昇格ゲートを多様な相手に広げる）。
 *   3. shouldPromote（archiveWinRate > 0.5 + promoteMargin）なら champion を交代し、新 champion を
 *      殿堂に追加（上限 archiveSize で直近優先に間引く）。これにより「直近にだけ勝つが古い強者に
 *      負ける」循環的後退を弾き、実測 drift（対 medium 微減）を抑える。
 *   4. round の素データを記録。
 * 最後に推移を整形して返し、最終 champion を champion_params.json に書く。
 *
 * 決定的: seed 固定で champion・rounds・trajectory が bit 一致再現する
 *   （populationGA の seed は roundSeed(seed, round) で派生・evalFn の seed も round 派生）。
 *
 * @param opts seed / rounds / popSize / generations / games（/ promoteMargin / submissionDir 等）。
 */
export async function coevolveXq(opts: CoevolveOptions): Promise<CoevolveResult> {
  const rounds = Math.max(1, Math.trunc(opts.rounds));
  const popSize = Math.max(1, Math.trunc(opts.popSize));
  const generations = Math.max(0, Math.trunc(opts.generations));
  const games = Math.max(1, Math.trunc(opts.games));
  const promoteMargin = opts.promoteMargin ?? 0.02;
  const archiveSize = Math.max(0, Math.trunc(opts.archiveSize ?? 4));
  const archiveConcurrency = Math.max(1, Math.trunc(opts.archiveConcurrency ?? 4));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const writeSub = opts.writeSubmission ?? true;
  const submissionDir = opts.submissionDir ?? join(process.cwd(), CHAMPION_DIR_REL);

  // 評価関数: テストは evalFn を注入、本番は evaluateCoevo（spawn）を使う。
  const evalFn =
    opts.evalFn ??
    ((challenger: Params, champion: Params, seed: number): Promise<number> => {
      const evalOpts: CoevoEvalOptions = { games, seed, failFitness: 0 };
      if (opts.sidecarPath !== undefined) evalOpts.sidecarPath = opts.sidecarPath;
      if (opts.python !== undefined) evalOpts.python = opts.python;
      return evaluateCoevo(challenger, champion, timeoutMs, evalOpts);
    });

  let champion: Params = { ...initialChampion };
  // 殿堂（Hall of Fame）: 過去 champion 群。初期 champion を起点に入れる
  // （archiveSize=0 のときは空＝直近 champion だけで戦う旧挙動に縮退）。
  let archive: Params[] = capArchive([{ ...champion }], archiveSize);
  const roundRecords: CoevoRound[] = [];

  for (let r = 1; r <= rounds; r++) {
    const rSeed = roundSeed(opts.seed, r);
    // この round の champion を固定参照（探索中は据え置き＝challenger だけが動く）。
    const frozenChampion: Params = { ...champion };

    // populationGA で challenger を frozenChampion に対して勝率最大化（探索の勾配は直近で取る）。
    // evaluate に「候補 → 対 champion 勝率」を渡す（GA は fitness スカラしか見ない）。
    const gaResult = await populationGA(
      (challenger: Params) => evalFn(challenger, frozenChampion, rSeed),
      {
        seed: rSeed,
        generations,
        popSize,
        initial: { ...frozenChampion },
      },
    );

    // 探索 fitness（対 frozenChampion 勝率）。決定的なので gaResult.bestScore と一致する。
    const challengerWinRate = await evalFn(gaResult.best, frozenChampion, rSeed);

    // 昇格ゲート: 最良 challenger を殿堂の各メンバーに対して並行評価し、平均勝率を取る。
    // 殿堂が空（archiveSize=0）のときは latest（frozenChampion）への勝率にフォールバック。
    let archiveWinRate: number;
    if (archive.length === 0) {
      archiveWinRate = challengerWinRate;
    } else {
      // メンバーごとに seed を派生（同一 challenger でも相手別の対戦系列にする＝決定的）。
      const rates = await mapConcurrent(
        archive,
        (member, i) => evalFn(gaResult.best, member, (rSeed + i * 0x9e3779b1) >>> 0),
        archiveConcurrency,
      );
      archiveWinRate = meanWinRate(rates);
    }

    const promoted = shouldPromote(archiveWinRate, promoteMargin);
    if (promoted) {
      champion = { ...gaResult.best };
      // 新 champion を殿堂へ（上限で直近優先に間引く）。次 round 以降の昇格相手が増える。
      archive = capArchive([...archive, { ...champion }], archiveSize);
    }

    roundRecords.push({
      round: r,
      challengerWinRate,
      archiveWinRate,
      promoted,
      champion: { ...champion },
      archiveSize: archive.length,
    });
  }

  const trajectory = summarizeTrajectory(roundRecords);

  const result: CoevolveResult = {
    champion: { ...champion },
    rounds: roundRecords,
    trajectory,
    archive,
  };

  if (writeSub) {
    result.submissionPath = writeChampion(champion, submissionDir);
  }

  return result;
}
