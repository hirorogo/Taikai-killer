import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildArchiveManifest,
  toPosixPath,
  hashFile,
  collectArchiveFiles,
  archiveRun,
  type ArchiveFile,
} from "../orchestrator/archiver.ts";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// ───────── buildArchiveManifest（純関数）─────────

describe("buildArchiveManifest", () => {
  const a: ArchiveFile = { path: "result.json", bytes: 10, sha256: sha("a") };
  const b: ArchiveFile = { path: "partials/x.json", bytes: 5, sha256: sha("b") };

  it("file_count / total_bytes を集計し path 昇順に並べる", () => {
    const m = buildArchiveManifest([a, b]);
    expect(m.file_count).toBe(2);
    expect(m.total_bytes).toBe(15);
    expect(m.files.map((f) => f.path)).toEqual(["partials/x.json", "result.json"]);
  });

  it("入力順に依存しない決定的な manifest_sha256（ソートで安定）", () => {
    const m1 = buildArchiveManifest([a, b]);
    const m2 = buildArchiveManifest([b, a]);
    expect(m1.manifest_sha256).toBe(m2.manifest_sha256);
  });

  it("内容ハッシュが変わると manifest_sha256 も変わる", () => {
    const base = buildArchiveManifest([a, b]);
    const changed = buildArchiveManifest([{ ...a, sha256: sha("a2") }, b]);
    expect(changed.manifest_sha256).not.toBe(base.manifest_sha256);
  });

  it("空入力は file_count=0 / total_bytes=0", () => {
    const m = buildArchiveManifest([]);
    expect(m.file_count).toBe(0);
    expect(m.total_bytes).toBe(0);
    expect(m.files).toEqual([]);
  });
});

describe("toPosixPath", () => {
  it("バックスラッシュを / に正規化", () => {
    expect(toPosixPath("partials\\S5_PARTIAL.json")).toBe("partials/S5_PARTIAL.json");
  });
});

// ───────── collectArchiveFiles / hashFile / archiveRun（副作用）─────────

describe("collectArchiveFiles / archiveRun", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "taikai-arch-"));
    mkdirSync(join(runDir, "partials"), { recursive: true });
    mkdirSync(join(runDir, "node_modules"), { recursive: true });
    writeFileSync(join(runDir, "result.json"), "RESULT", "utf8");
    writeFileSync(join(runDir, "partials", "p.json"), "PARTIAL", "utf8");
    writeFileSync(join(runDir, "node_modules", "junk.js"), "JUNK", "utf8");
  });

  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("再帰走査し相対 POSIX パス・サイズ・sha256 を集める", () => {
    const files = collectArchiveFiles(runDir);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.has("result.json")).toBe(true);
    expect(byPath.has("partials/p.json")).toBe(true);
    expect(byPath.get("result.json")!.bytes).toBe("RESULT".length);
    expect(byPath.get("result.json")!.sha256).toBe(sha("RESULT"));
  });

  it("excludeDirs のディレクトリは除外", () => {
    const files = collectArchiveFiles(runDir, { excludeDirs: ["node_modules"] });
    expect(files.some((f) => f.path.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.path === "result.json")).toBe(true);
  });

  it("hashFile は内容の sha256 と一致", () => {
    expect(hashFile(join(runDir, "result.json"))).toBe(sha("RESULT"));
  });

  it("archiveRun は走査結果を決定的マニフェストに畳む", () => {
    const m = archiveRun(runDir, { excludeDirs: ["node_modules"] });
    expect(m.file_count).toBe(2);
    expect(m.total_bytes).toBe("RESULT".length + "PARTIAL".length);
    // 純関数に同じ記述子を渡せば同じ manifest_sha256（実装の自己整合）
    const rebuilt = buildArchiveManifest(
      collectArchiveFiles(runDir, { excludeDirs: ["node_modules"] }),
    );
    expect(rebuilt.manifest_sha256).toBe(m.manifest_sha256);
  });
});
