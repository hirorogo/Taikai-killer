import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  planBackup,
  normalizePlatform,
  latestPartial,
  collectBackupSources,
  executeBackupPlan,
  backupResult,
  runManifestPath,
  STAGE_BASE,
  ROBOCOPY_MT,
  type BackupPlan,
  type RobocopyPlan,
  type DirectCopyPlan,
} from "../orchestrator/backup.ts";
import { partialsDir, resultPath } from "../orchestrator/paths.ts";

let runDir: string;
let destDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "taikai-backup-run-"));
  destDir = mkdtempSync(join(tmpdir(), "taikai-backup-dest-"));
  mkdirSync(partialsDir(runDir), { recursive: true });
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  rmSync(destDir, { recursive: true, force: true });
});

// ───────── planBackup（純関数・プラットフォーム分岐）─────────

describe("planBackup", () => {
  it("posix は宛先へ直接コピー計画（basename で dest を決める）", () => {
    const plan = planBackup(
      ["/run/result.json", "/run/run_manifest.json"],
      "/backup/x",
      "posix",
    );
    expect(plan.kind).toBe("direct");
    const p = plan as DirectCopyPlan;
    expect(p.destDir).toBe("/backup/x");
    expect(p.copies.map((c) => c.dest)).toEqual([
      join("/backup/x", "result.json"),
      join("/backup/x", "run_manifest.json"),
    ]);
  });

  it("win32 は C: ステージ集約 + robocopy /MT コマンド計画", () => {
    const plan = planBackup(
      ["/run/result.json", "/run/p.json"],
      "D:\\backup\\run1",
      "win32",
    );
    expect(plan.kind).toBe("robocopy");
    const p = plan as RobocopyPlan;
    // stage は C: 配下（MEMORY: USB exFAT を避けて C: 経由）
    expect(p.stageDir.startsWith(STAGE_BASE)).toBe(true);
    expect(p.destDir).toBe("D:\\backup\\run1");
    // robocopy <stage> <dest> <files...> /MT:32
    expect(p.command[0]).toBe("robocopy");
    expect(p.command[1]).toBe(p.stageDir);
    expect(p.command[2]).toBe("D:\\backup\\run1");
    expect(p.command).toContain("result.json");
    expect(p.command).toContain("p.json");
    expect(p.command[p.command.length - 1]).toBe(`/MT:${ROBOCOPY_MT}`);
    // stage コピーは C: ステージへ向かう
    expect(p.stageCopies.every((c) => c.dest.startsWith(p.stageDir))).toBe(true);
  });

  it("同名 basename は1つに畳む（後勝ち）", () => {
    const plan = planBackup(["/a/result.json", "/b/result.json"], "/dest", "posix");
    const p = plan as DirectCopyPlan;
    expect(p.copies).toHaveLength(1);
    expect(p.copies[0]!.src).toBe("/b/result.json");
  });

  it("空入力でも空の計画を返す", () => {
    const direct = planBackup([], "/dest", "posix") as DirectCopyPlan;
    expect(direct.copies).toEqual([]);
    const robo = planBackup([], "X:\\d", "win32") as RobocopyPlan;
    expect(robo.stageCopies).toEqual([]);
  });
});

describe("normalizePlatform", () => {
  it("win32 のみ win32、他は posix", () => {
    expect(normalizePlatform("win32")).toBe("win32");
    expect(normalizePlatform("linux")).toBe("posix");
    expect(normalizePlatform("darwin")).toBe("posix");
  });
});

// ───────── 複製対象の収集 ─────────

describe("collectBackupSources / latestPartial", () => {
  it("result→run_manifest→最新 partial の順、存在するものだけ", () => {
    writeFileSync(resultPath(runDir), "{}", "utf8");
    writeFileSync(runManifestPath(runDir), "{}", "utf8");
    const older = join(partialsDir(runDir), "S5_PARTIAL_W0B0_a.json");
    const newer = join(partialsDir(runDir), "S5_PARTIAL_W0B1_b.json");
    writeFileSync(older, "{}", "utf8");
    writeFileSync(newer, "{}", "utf8");
    // mtime を明示（newer を新しく）
    utimesSync(older, new Date(1000), new Date(1000));
    utimesSync(newer, new Date(2000), new Date(2000));

    const got = collectBackupSources(runDir);
    expect(got).toEqual([resultPath(runDir), runManifestPath(runDir), newer]);
  });

  it("partial が無ければ latestPartial は undefined", () => {
    expect(latestPartial(runDir)).toBeUndefined();
  });

  it("非 json は最新 partial 候補に入れない", () => {
    writeFileSync(join(partialsDir(runDir), "note.txt"), "x", "utf8");
    expect(latestPartial(runDir)).toBeUndefined();
  });
});

// ───────── executeBackupPlan（副作用）─────────

describe("executeBackupPlan", () => {
  it("direct 計画は dest へファイルを書く", () => {
    writeFileSync(resultPath(runDir), "RESULT", "utf8");
    const plan: BackupPlan = planBackup([resultPath(runDir)], destDir, "posix");
    const copied = executeBackupPlan(plan);
    expect(copied).toEqual([join(destDir, "result.json")]);
    expect(readdirSync(destDir)).toContain("result.json");
  });

  it("robocopy 計画も stage 経由で dest に最終コピーが残る", () => {
    writeFileSync(resultPath(runDir), "RESULT", "utf8");
    const plan = planBackup([resultPath(runDir)], destDir, "win32");
    try {
      const copied = executeBackupPlan(plan);
      expect(copied).toEqual([join(destDir, "result.json")]);
      expect(readdirSync(destDir)).toContain("result.json");
    } finally {
      // stage は C:\taikai-stage 配下に作られるので掃除
      rmSync((plan as RobocopyPlan).stageDir, { recursive: true, force: true });
    }
  });
});

// ───────── backupResult（no-op／false 仕様）─────────

describe("backupResult", () => {
  it("destDir 未指定（env 無し）なら no-op で backedUp=false", () => {
    writeFileSync(resultPath(runDir), "{}", "utf8");
    const out = backupResult(runDir, { platform: "posix" });
    expect(out.backedUp).toBe(false);
    expect(out.reason).toBe("no_backup_dir");
    expect(out.copied).toEqual([]);
  });

  it("複製対象が1つも無ければ no-op で backedUp=false", () => {
    const out = backupResult(runDir, { platform: "posix", destDir });
    expect(out.backedUp).toBe(false);
    expect(out.reason).toBe("no_sources");
  });

  it("result があれば複製して backedUp=true", () => {
    writeFileSync(resultPath(runDir), "{}", "utf8");
    const out = backupResult(runDir, { platform: "posix", destDir });
    expect(out.backedUp).toBe(true);
    expect(out.copied).toEqual([join(destDir, "result.json")]);
    expect(out.reason).toBeUndefined();
  });
});
