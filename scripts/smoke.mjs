#!/usr/bin/env node
/**
 * scripts/smoke.mjs — 全 example をワンショット検証するスモークテスト。
 *
 * 依存ゼロ（node 標準のみ: child_process / fs / os / path / url）。vitest でも tsx でもなく
 * `node scripts/smoke.mjs` で直接走る。スクリプト自体にユニットテストは付けない（仕様）。
 *
 * ── 検証する 3 経路（docs/implementation-status.md §2 の実通経路に対応）──
 *   (1) toy-fizzbuzz（test型）: example を tmp run-dir に cp → `npm run taikai -- run` →
 *       result.json の passed_test_ratio === 1 を assert。
 *   (2) toy-janken（battle型）: example を tmp run-dir に cp → `npm run taikai -- run`
 *       （※専用の `battle` サブコマンドは無い。SCORING_RUBRIC.json の eval_mode==="battle"
 *         を runner.ts が分岐し players/{id}/ を総当たり対戦させる。仕様の「→battle」は
 *         この rubric 分岐のこと）→ result.json に win_rate があり rank === 1 を assert。
 *   (3) evolve（数値最適化トラック・LLM 非依存）: `npm run taikai -- evolve` →
 *       improved（= exit 0）を assert。
 *
 * ── 実行コスト / 既定 skip（CI 配慮）──
 *   (1) は S3/S5 で **claude CLI を subprocess 起動**し LLM 応答を待つ＝時間が掛かり、
 *       未ログインだと失敗する。(2) は **python が PATH に必要**（プレイヤーは実 Python）。
 *   そのため (1)(2) は既定で **skip** し、環境変数 `SMOKE_LIVE=1` を立てたときだけ実行する。
 *   (3) は LLM も python も使わず決定的（seed 固定）なので常に走る。
 *
 *   なので CI 既定（SMOKE_LIVE 未設定）では (3) のみ検証し、(1)(2) は skip 表示。
 *   ローカルで claude ログイン済み＋python 有りなら `SMOKE_LIVE=1 node scripts/smoke.mjs`。
 *
 * ── 終了コード ──
 *   実行した全ケースが成功（skip は成功扱い）→ exit 0 / どれか失敗 → exit 1。
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const EXAMPLES = join(REPO_ROOT, "examples");
const LIVE = process.env.SMOKE_LIVE === "1";
// npm は Windows では npm.cmd。shell:true で OS に解決させる（claudeRunner.ts と同作法）。
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** 1 ケースの結果。ok=false は失敗、skipped=true は実行せず成功扱い。 */
function caseResult(name, ok, detail, skipped = false) {
  return { name, ok, detail, skipped };
}

/** `npm run taikai -- <args>` を REPO_ROOT で同期実行し、{ status, stdout, stderr } を返す。 */
function runTaikai(args) {
  const res = spawnSync(NPM, ["run", "taikai", "--", ...args], {
    cwd: REPO_ROOT,
    shell: true,
    encoding: "utf8",
    windowsHide: true,
    // run は LLM/spawn 待ちで長い。十分なハード上限（10 分）。
    timeout: 600_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error,
  };
}

/** example を一意な tmp run-dir に丸ごと cp して、そのパスを返す。 */
function stageRunDir(exampleName) {
  const src = join(EXAMPLES, exampleName);
  if (!existsSync(src)) throw new Error(`example が無い: ${src}`);
  const dir = mkdtempSync(join(tmpdir(), `taikai-smoke-${exampleName}-`));
  cpSync(src, dir, { recursive: true });
  return dir;
}

/** result.json を読んで parse（無ければ throw）。 */
function readResult(runDir) {
  const p = join(runDir, "result.json");
  if (!existsSync(p)) throw new Error(`result.json が書かれていない: ${p}`);
  return JSON.parse(readFileSync(p, "utf8"));
}

// ───────── ケース (1) toy-fizzbuzz（test型・LIVE）─────────

function caseFizzbuzz() {
  const name = "toy-fizzbuzz (run → passed_test_ratio===1)";
  if (!LIVE) return caseResult(name, true, "SMOKE_LIVE!=1 のため skip（claude CLI 要）", true);
  let runDir;
  try {
    runDir = stageRunDir("toy-fizzbuzz");
    const r = runTaikai(["run", "--run-dir", runDir]);
    if (r.status !== 0) {
      return caseResult(name, false, `run が exit ${r.status}: ${tail(r.stderr || r.stdout)}`);
    }
    const result = readResult(runDir);
    if (result.passed_test_ratio !== 1) {
      return caseResult(name, false, `passed_test_ratio=${result.passed_test_ratio} (期待 1)`);
    }
    return caseResult(name, true, `passed_test_ratio=1, rank=${result.rank}`);
  } catch (e) {
    return caseResult(name, false, String(e instanceof Error ? e.message : e));
  } finally {
    cleanup(runDir);
  }
}

// ───────── ケース (2) toy-janken（battle型・LIVE）─────────

function caseJanken() {
  const name = "toy-janken (run[battle] → win_rate & rank===1)";
  if (!LIVE) return caseResult(name, true, "SMOKE_LIVE!=1 のため skip（python 要）", true);
  let runDir;
  try {
    runDir = stageRunDir("toy-janken");
    const r = runTaikai(["run", "--run-dir", runDir]);
    if (r.status !== 0) {
      return caseResult(name, false, `run が exit ${r.status}: ${tail(r.stderr || r.stdout)}`);
    }
    const result = readResult(runDir);
    // battle 経路の result.json は勝者（rank===1）の BenchResult。win_rate と rank を検証。
    if (typeof result.win_rate !== "number") {
      return caseResult(name, false, `win_rate が数値でない: ${JSON.stringify(result.win_rate)}`);
    }
    if (result.rank !== 1) {
      return caseResult(name, false, `rank=${result.rank} (期待 1)`);
    }
    return caseResult(name, true, `winner=${result.strategy_id}, win_rate=${result.win_rate}, rank=1`);
  } catch (e) {
    return caseResult(name, false, String(e instanceof Error ? e.message : e));
  } finally {
    cleanup(runDir);
  }
}

// ───────── ケース (3) evolve（数値最適化・常時実行）─────────

function caseEvolve() {
  const name = "evolve (improved → exit 0)";
  try {
    // evolve は run-dir 不要・LLM 非依存・seed 固定で決定的。improved なら exit 0、でなければ 1。
    const r = runTaikai(["evolve"]);
    if (r.error) return caseResult(name, false, `起動失敗: ${String(r.error)}`);
    if (r.status !== 0) {
      return caseResult(name, false, `improved でない（exit ${r.status}）: ${tail(r.stdout)}`);
    }
    const improved = /improved=true/.test(r.stdout);
    if (!improved) {
      return caseResult(name, false, `exit 0 だが出力に improved=true が無い: ${tail(r.stdout)}`);
    }
    return caseResult(name, true, firstLine(r.stdout, "[evolve]"));
  } catch (e) {
    return caseResult(name, false, String(e instanceof Error ? e.message : e));
  }
}

// ───────── 補助 ─────────

function cleanup(runDir) {
  if (runDir && existsSync(runDir)) {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* tmp の掃除失敗は致命でない */
    }
  }
}

function tail(s, n = 400) {
  const t = (s ?? "").trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

function firstLine(s, prefix) {
  const line = (s ?? "").split(/\r?\n/).find((l) => l.includes(prefix));
  return (line ?? tail(s, 120)).trim();
}

// ───────── ランナー ─────────

function main() {
  console.log(`[smoke] SMOKE_LIVE=${LIVE ? "1" : "(未設定→LIVEケースは skip)"}`);
  const results = [caseFizzbuzz(), caseJanken(), caseEvolve()];

  let failed = 0;
  for (const r of results) {
    const tag = r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL";
    console.log(`[smoke] ${tag} ${r.name} — ${r.detail}`);
    if (!r.ok) failed++;
  }

  const ran = results.filter((r) => !r.skipped).length;
  const skipped = results.length - ran;
  console.log(`[smoke] ${failed === 0 ? "OK" : "NG"}: ${ran} 実行 / ${skipped} skip / ${failed} 失敗`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
