/**
 * Resume（D9 / docs/decisions.md「状態モデル(D9)」）。
 *
 * partial = resume の唯一の真実源。状態DB・UUID は持たず、
 * outputs/{run}/partials/ を **glob スキャンするだけ**で「どの {worker,batch} まで
 * 済んだか」を復元する（append-only イベントログは resume には使わない＝write-only）。
 *
 * - scanCompleted(runDir, phase): 当該フェーズの完了済み {worker,batch,id} 集合を返す。
 *   status==="error" の partial は「スキップ確定」ではなく失敗証跡なので **未完扱い**
 *   （次起動が再試行できるよう除外）。status が "ok"/"partial" のものを完了とみなす。
 * - isDone(runDir, phase, worker, batch): 特定の {worker,batch} が完了済みか（冪等キーhit 判定）。
 *
 * fs は readdir（同期）で実装。partial の命名規約は paths.ts と一体
 * （`{phase}_PARTIAL_W{worker}B{batch}_{ISO8601}.json`）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { partialsDir } from "./paths.ts";
import type { PhaseArtifact, PhaseStatus } from "./types.ts";

/** 完了済みワーク1件（resume の最小単位）。 */
export interface CompletedItem {
  worker: number;
  batch: number;
  id: string;
}

/**
 * partial ファイル名 `{phase}_PARTIAL_W{worker}B{batch}_{ISO}.json` を解析。
 * phase が一致し worker/batch が数値で取れたものだけを返す（不一致は null）。
 */
function parsePartialName(
  fileName: string,
  phase: string,
): { worker: number; batch: number } | null {
  // ISO 部分は ":" を "-" 正規化済み（任意文字）。phase は完全一致でガード。
  const re = new RegExp(`^${escapeRegExp(phase)}_PARTIAL_W(\\d+)B(\\d+)_.+\\.json$`);
  const m = re.exec(fileName);
  if (!m) return null;
  const worker = Number(m[1]);
  const batch = Number(m[2]);
  if (!Number.isInteger(worker) || !Number.isInteger(batch)) return null;
  return { worker, batch };
}

/** 正規表現メタ文字をエスケープ（phase は通常 "S5" 等だが防御的に）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * partial の JSON を読み status を取得。読めない/壊れている partial は
 * 「未完（=エラー扱い）」とみなして "error" を返す（resume は取りこぼさない方を選ぶ）。
 */
function readStatus(path: string): { status: PhaseStatus; id: string } {
  try {
    const art = JSON.parse(readFileSync(path, "utf8")) as Partial<PhaseArtifact<unknown>>;
    const status: PhaseStatus = art.status ?? "error";
    const id = typeof art.id === "string" ? art.id : "";
    return { status, id };
  } catch {
    return { status: "error", id: "" };
  }
}

/**
 * 当該フェーズの完了済み {worker,batch,id} 集合を返す（D9）。
 * status!=="error"（= "ok" / "partial"）のものだけを完了とみなす。
 * 同一 {worker,batch} に複数 partial（リトライで複数 ISO）があれば、
 * 1つでも非 error があれば完了扱い（最後に書けたものが真）。
 */
export function scanCompleted(runDir: string, phase: string): CompletedItem[] {
  const dir = partialsDir(runDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // partials ディレクトリ未作成 = 何も完了していない（初回起動）
    return [];
  }

  // {worker,batch} ごとに「非 error の partial が1つでもあるか」を集約
  const byKey = new Map<string, { worker: number; batch: number; id: string; done: boolean }>();
  for (const name of names) {
    const parsed = parsePartialName(name, phase);
    if (!parsed) continue;
    const { worker, batch } = parsed;
    const { status, id } = readStatus(join(dir, name));
    const key = `${worker}.${batch}`;
    const prev = byKey.get(key);
    const isDoneRecord = status !== "error";
    if (prev === undefined) {
      byKey.set(key, { worker, batch, id, done: isDoneRecord });
    } else if (isDoneRecord && !prev.done) {
      // error だった key に後から非 error が来たら完了に昇格し id を採用
      prev.done = true;
      prev.id = id;
    }
  }

  const out: CompletedItem[] = [];
  for (const v of byKey.values()) {
    if (v.done) out.push({ worker: v.worker, batch: v.batch, id: v.id });
  }
  // 安定した順序で返す（worker→batch 昇順）。下流の決定論性のため。
  out.sort((a, b) => (a.worker - b.worker) || (a.batch - b.batch));
  return out;
}

/**
 * 特定 {worker,batch} が完了済みか（冪等キーhit 判定 / 局所スキップに使う）。
 * scanCompleted のサブセット問い合わせ。CB の recordSkip(冪等hit) と組で使う想定。
 */
export function isDone(runDir: string, phase: string, worker: number, batch: number): boolean {
  return scanCompleted(runDir, phase).some((c) => c.worker === worker && c.batch === batch);
}
