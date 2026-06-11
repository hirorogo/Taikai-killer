/**
 * 成果物バックアップ（欠落6 / docs/mvp-vertical-slice.md「欠落6: outputs のバックアップ」）。
 *
 * 正本:
 * - 「各周回の result.json 確定時に、result.json + run_manifest.json + 最新 partial を
 *    TAIKAI_BACKUP_DIR（別ディスク/クラウド同期フォルダ）へ複製」
 * - 「Windows/USB 宛ては C: ステージ経由でバルク転送（exFAT 小ファイル多数は致命的に遅い
 *    → 一旦 C: に置き robocopy /MT:32 で一括）」（MEMORY 既知）。
 *
 * 方針（譲れない条件）:
 * - **TAIKAI_BACKUP_DIR が無ければ no-op で false を返す**（best-effort。本体を止めない）。
 * - **計画は純関数 planBackup(srcFiles, destDir, platform) に切り出す**（プラットフォーム分岐を
 *   テスト可能に）。実コピー executeBackupPlan() は副作用関数（fs を触る）。
 * - Windows 宛て（特に exFAT/USB）は「C: ステージ → robocopy /MT で一括転送」のコマンド計画を返す。
 *   それ以外（posix）は単純なファイル単位コピー計画を返す。
 * - events.ts / notify.ts のスタイル（純整形＋薄い副作用ラッパ）に合わせる。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { partialsDir, resultPath } from "./paths.ts";

/** バックアップ宛先ディレクトリの env キー（欠落6）。 */
export const BACKUP_DIR_ENV = "TAIKAI_BACKUP_DIR";

/** C: ステージのベースディレクトリ（Windows/USB バルク転送の中継）。 */
export const STAGE_BASE = "C:\\taikai-stage";

/** robocopy のマルチスレッド数（MEMORY 既知: /MT:32 で一括転送）。 */
export const ROBOCOPY_MT = 32;

/** 計画対象のプラットフォーム（process.platform のサブセット）。 */
export type BackupPlatform = "win32" | "posix";

/** 1 ファイルの単純コピー（src→dest 絶対パス）。posix 計画で使う。 */
export interface CopyStep {
  kind: "copy";
  src: string;
  dest: string;
}

/**
 * Windows/USB 向け「C: ステージ → robocopy /MT 一括」計画。
 * - copies: src ファイルを stageDir へ一旦コピーするステップ（小ファイルを C: に集約）。
 * - command: stageDir → destDir をまとめて転送する robocopy コマンド（argv 形式＝シェル非依存）。
 */
export interface RobocopyPlan {
  kind: "robocopy";
  stageDir: string;
  destDir: string;
  /** stage へ集約するためのファイル単位コピー（C: ローカル＝高速）。 */
  stageCopies: CopyStep[];
  /** robocopy の実行 argv（[exe, ...args]）。/MT でバルク転送。 */
  command: string[];
}

/** posix 向け「宛先へ直接ファイルコピー」計画。 */
export interface DirectCopyPlan {
  kind: "direct";
  destDir: string;
  copies: CopyStep[];
}

/** planBackup の戻り値（プラットフォーム分岐の結果）。 */
export type BackupPlan = RobocopyPlan | DirectCopyPlan;

/** robocopy の stage ディレクトリ名（run ごとに分離。衝突回避用に dest を畳む）。 */
function stageDirFor(destDir: string): string {
  // dest のパス文字をファイル名安全な1階層に畳む（衝突を避けつつ決定的）。
  const slug = destDir.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return join(STAGE_BASE, slug || "default");
}

/**
 * バックアップ計画を組む純関数（副作用なし＝テスト対象）。
 *
 * - platform==="win32": exFAT/USB 宛ての小ファイル多数を避けるため、
 *   いったん C: ステージへ集約 → robocopy /MT:32 で destDir へバルク転送する計画を返す。
 *   robocopy はディレクトリ単位なので、ステージに集めてからまとめて1回で転送する。
 * - platform==="posix": 宛先へファイル単位で直接コピーする計画を返す。
 *
 * srcFiles は **絶対パス**前提。空配列でも空の計画を返す（呼び出し側が no-op 判定する）。
 * basename が衝突する src は後勝ち（同名は1つに畳む＝robocopy の宛先と整合）。
 */
export function planBackup(
  srcFiles: readonly string[],
  destDir: string,
  platform: BackupPlatform,
): BackupPlan {
  // 同名 basename は1つに畳む（dest 側ファイル名は basename 固定のため）。
  const byName = new Map<string, string>();
  for (const src of srcFiles) {
    byName.set(basename(src), src);
  }

  if (platform === "win32") {
    const stageDir = stageDirFor(destDir);
    const stageCopies: CopyStep[] = [];
    for (const [name, src] of byName) {
      stageCopies.push({ kind: "copy", src, dest: join(stageDir, name) });
    }
    // robocopy <src> <dest> [files...] /MT:N
    // ファイルを明示列挙して「stage 配下のうちこの run のものだけ」を転送する。
    const command = [
      "robocopy",
      stageDir,
      destDir,
      ...byName.keys(),
      `/MT:${ROBOCOPY_MT}`,
    ];
    return { kind: "robocopy", stageDir, destDir, stageCopies, command };
  }

  const copies: CopyStep[] = [];
  for (const [name, src] of byName) {
    copies.push({ kind: "copy", src, dest: join(destDir, name) });
  }
  return { kind: "direct", destDir, copies };
}

/** process.platform を BackupPlatform に正規化（win32 以外は posix 扱い）。 */
export function normalizePlatform(p: NodeJS.Platform): BackupPlatform {
  return p === "win32" ? "win32" : "posix";
}

/**
 * partials/ の中で **最新の partial**（mtime 最大）を1つ返す。無ければ undefined。
 * resume の glob スキャンとは別目的（ここは「最新1件だけ複製」する欠落6 の要件）。
 * ファイル名の ISO ではなく mtime を使う（リトライで複数 ISO がある時も「最後に書けた」を採る）。
 */
export function latestPartial(runDir: string): string | undefined {
  const dir = partialsDir(runDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let best: { path: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (best === undefined || st.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: st.mtimeMs };
      }
    } catch {
      // 消えた/読めないファイルは無視（best-effort）
    }
  }
  return best?.path;
}

/** run_manifest.json の絶対パス（paths.ts に helper が無いのでここで規約を固定）。 */
export function runManifestPath(runDir: string): string {
  return join(runDir, "run_manifest.json");
}

/**
 * 複製対象の存在するファイルを集める純寄りロジック（fs.existsSync のみ）。
 * 順序固定: result.json → run_manifest.json → 最新 partial（無いものは飛ばす）。
 */
export function collectBackupSources(runDir: string): string[] {
  const candidates = [resultPath(runDir), runManifestPath(runDir)];
  const out: string[] = [];
  for (const c of candidates) {
    if (existsSync(c)) out.push(c);
  }
  const lp = latestPartial(runDir);
  if (lp !== undefined) out.push(lp);
  return out;
}

/** バックアップ実行の結果（観測/テスト用）。 */
export interface BackupOutcome {
  /** 1件でも複製したか（no-op なら false）。 */
  backedUp: boolean;
  /** no-op の理由（env 未設定 / 複製対象なし）。backedUp=true なら undefined。 */
  reason?: "no_backup_dir" | "no_sources";
  /** 実際に dest 側へ書いた絶対パス群（robocopy 計画では stage 経由後の最終 dest）。 */
  copied: string[];
  /** 採用した計画（観測用。env 未設定時は undefined）。 */
  plan?: BackupPlan;
}

/**
 * バックアップ計画を実行する副作用関数（fs を触る）。
 * - direct: copies を順にコピー。
 * - robocopy: stageCopies を C: ステージへコピーした上で、**stage→dest の最終コピーも fs で行う**
 *   （robocopy コマンドは MEMORY 方針として command に保持するが、テスト/非 Windows でも成立させるため
 *    実体コピーは copyFileSync で完結させる＝外部プロセス非依存。command は監査・本番置換用）。
 * 失敗したファイルは握り潰さず、コピーできたものだけ copied に積む（best-effort）。
 */
export function executeBackupPlan(plan: BackupPlan): string[] {
  const copied: string[] = [];
  if (plan.kind === "direct") {
    ensureDir(plan.destDir);
    for (const step of plan.copies) {
      if (tryCopy(step.src, step.dest)) copied.push(step.dest);
    }
    return copied;
  }
  // robocopy 計画: まず stage へ集約、その後 dest へ。
  ensureDir(plan.stageDir);
  ensureDir(plan.destDir);
  for (const step of plan.stageCopies) {
    if (!tryCopy(step.src, step.dest)) continue;
    const finalDest = join(plan.destDir, basename(step.dest));
    if (tryCopy(step.dest, finalDest)) copied.push(finalDest);
  }
  return copied;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function tryCopy(src: string, dest: string): boolean {
  try {
    ensureDir(dirOf(dest));
    copyFileSync(src, dest);
    return true;
  } catch {
    return false;
  }
}

function dirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx <= 0 ? p : p.slice(0, idx);
}

/**
 * result.json + run_manifest.json + 最新 partial を TAIKAI_BACKUP_DIR へ複製する（欠落6）。
 *
 * - TAIKAI_BACKUP_DIR 未設定 → no-op で { backedUp:false, reason:"no_backup_dir" }。
 * - 複製対象が1つも無い（result も manifest も partial も無い）→ no-op で
 *   { backedUp:false, reason:"no_sources" }。
 * - それ以外は planBackup（platform 分岐）→ executeBackupPlan を実行し、書けたものを返す。
 *
 * 戻り値の backedUp が「false=no-op」の真偽値（仕様の「無ければ no-op で false」）。
 * platform は注入可能（テストで win32/posix を切り替えるため）。既定は process.platform。
 */
export function backupResult(
  runDir: string,
  opts: { platform?: BackupPlatform; destDir?: string } = {},
): BackupOutcome {
  const destDir = opts.destDir ?? process.env[BACKUP_DIR_ENV];
  if (destDir === undefined || destDir === "") {
    return { backedUp: false, reason: "no_backup_dir", copied: [] };
  }
  const sources = collectBackupSources(runDir);
  if (sources.length === 0) {
    return { backedUp: false, reason: "no_sources", copied: [] };
  }
  const platform = opts.platform ?? normalizePlatform(process.platform);
  const plan = planBackup(sources, destDir, platform);
  const copied = executeBackupPlan(plan);
  return { backedUp: copied.length > 0, copied, plan };
}
