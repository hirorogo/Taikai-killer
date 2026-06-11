/**
 * run のアーカイブ（docs/directory-structure.md「archiver.ts: run のアーカイブ」/
 * docs/steal-from-speca.md E-6「大容量生データは GitHub Release に zstd tarball、
 * sidecar manifest（archive_sha256/ファイル数）で復元検証」）。
 *
 * 方針（譲れない条件）:
 * - **マニフェスト生成は純関数 buildArchiveManifest(files) に切り出す**（fs 非依存＝テスト対象）。
 *   入力は「相対パス＋サイズ＋sha256」のファイル記述子配列、出力は集計済みマニフェスト。
 * - 実ファイル走査（fs を歩いて記述子を作る）と実コピー/tar は副作用関数 archiveRun() 側。
 * - sha256 は node:crypto（標準）で計算。外部 npm 依存は足さない。
 * - speca 同型: manifest に file_count / total_bytes / archive 全体の集約ハッシュを持たせ、
 *   復元検証（タグの sidecar manifest）に使えるようにする。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** マニフェストに載せる1ファイルの記述子（純関数の入力単位）。 */
export interface ArchiveFile {
  /** run ディレクトリ起点の相対パス（POSIX 区切りに正規化済み）。 */
  path: string;
  /** バイトサイズ。 */
  bytes: number;
  /** 内容の sha256（hex）。改ざん検出・復元検証に使う。 */
  sha256: string;
}

/** run のアーカイブマニフェスト（sidecar manifest 相当）。 */
export interface ArchiveManifest {
  /** ファイル記述子（path 昇順で安定ソート＝決定的なマニフェスト）。 */
  files: ArchiveFile[];
  /** 総ファイル数（= files.length。検証の冗長チェック用）。 */
  file_count: number;
  /** 総バイト数。 */
  total_bytes: number;
  /**
   * マニフェスト全体の集約ハッシュ（各 path+sha256 を連結した sha256）。
   * 「同じ中身の run か」を1値で照合できる（speca の archive_sha256 と同役）。
   */
  manifest_sha256: string;
}

/**
 * ファイル記述子配列から決定的なアーカイブマニフェストを組む純関数。
 *
 * - files を path 昇順で安定ソート（入力順に依存しない決定的出力）。
 * - file_count / total_bytes を集計。
 * - manifest_sha256 = sha256( join("\n", `${path}:${sha256}`) )。
 *   path と内容ハッシュ両方を畳むので、同名で中身違い・別名で同内容を区別できる。
 *
 * 副作用なし（fs を触らない）＝テスト対象。
 */
export function buildArchiveManifest(files: readonly ArchiveFile[]): ArchiveManifest {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let total = 0;
  for (const f of sorted) total += f.bytes;

  const h = createHash("sha256");
  for (const f of sorted) {
    h.update(`${f.path}:${f.sha256}\n`);
  }

  return {
    files: sorted,
    file_count: sorted.length,
    total_bytes: total,
    manifest_sha256: h.digest("hex"),
  };
}

/** パス区切りを POSIX("/") に正規化（OS 非依存なマニフェストにするため）。 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** 1ファイルの sha256（hex）を計算する副作用関数（読み取りのみ）。 */
export function hashFile(absPath: string): string {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * run ディレクトリ配下を再帰走査し、ファイルの記述子（相対 path/bytes/sha256）を集める副作用関数。
 *
 * - excludeDirs に挙げた直下ディレクトリ名はスキップ（既定: なし）。
 * - シンボリックリンク・読めないファイルはスキップ（best-effort）。
 * - 戻り値は buildArchiveManifest にそのまま渡せる ArchiveFile[]（未ソート＝純関数側でソート）。
 */
export function collectArchiveFiles(
  runDir: string,
  opts: { excludeDirs?: readonly string[] } = {},
): ArchiveFile[] {
  const exclude = new Set(opts.excludeDirs ?? []);
  const out: ArchiveFile[] = [];

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // 読めないディレクトリは飛ばす
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // 直下の除外指定だけでなく、どの階層でも同名ディレクトリは除外
        if (exclude.has(name)) continue;
        walk(abs);
      } else if (st.isFile()) {
        try {
          out.push({
            path: toPosixPath(relative(runDir, abs)),
            bytes: st.size,
            sha256: hashFile(abs),
          });
        } catch {
          // ハッシュ計算に失敗したファイルは除外（best-effort）
        }
      }
    }
  };

  walk(runDir);
  return out;
}

/**
 * run ディレクトリの成果物一覧マニフェストを作る（副作用＝走査、集計は純関数に委譲）。
 *
 * - collectArchiveFiles で記述子を集め → buildArchiveManifest で決定的に集計。
 * - 実 tar/zstd 圧縮や Release への publish はここでは行わない（MVP は「マニフェストを作る」まで。
 *   docs E-6 の publish は workflow_dispatch 手動）。
 *
 * @param runDir 走査する run ディレクトリ（絶対パス推奨）。
 * @param opts.excludeDirs マニフェストから外すディレクトリ名（例: ["node_modules"]）。
 */
export function archiveRun(
  runDir: string,
  opts: { excludeDirs?: readonly string[] } = {},
): ArchiveManifest {
  const files = collectArchiveFiles(runDir, opts);
  return buildArchiveManifest(files);
}
