/**
 * 縦串MVP 本体（Issue #3）。S1→S3→S5(D22)→S6→result.json を1周。
 * 無限ループ・並列・進化は入れない（縦串の配管検証が目的）。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  cpSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { runCLISubprocess } from "./runtimeRegistry.ts";
import { MVP_PHASES } from "./config.ts";
import {
  partialsDir,
  logsDir,
  partialName,
  resultPath,
  tournamentInfoPath,
  scoringRubricPath,
  leaderboardPath,
} from "./paths.ts";
import type {
  TournamentInfo,
  ScoringRubric,
  Strategy,
  CodeAttempt,
  BenchResult,
  LeaderboardEntry,
  ProjectManifest,
  Provenance,
  PhaseArtifact,
} from "./types.ts";

// ───────── 小道具 ─────────

const isoNow = (): string => new Date().toISOString();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
}
function sha256(buf: string): string {
  return createHash("sha256").update(buf).digest("hex");
}

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
function runCmd(cmd: string, cwd: string, timeoutMs: number): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e), timedOut });
    });
  });
}

function ensureDirs(runDir: string): void {
  for (const d of [partialsDir(runDir), logsDir(runDir), join(runDir, "events")]) {
    mkdirSync(d, { recursive: true });
  }
}

function writePartial<T>(
  runDir: string,
  phase: string,
  worker: number,
  batch: number,
  payload: T,
  provenance: Provenance,
  status: PhaseArtifact<T>["status"] = "ok",
): void {
  const iso = isoNow();
  const art: PhaseArtifact<T> = {
    id: `${phase}:${worker}.${batch}`,
    phase,
    worker,
    batch,
    timestamp: iso,
    schema_version: "0",
    status,
    provenance,
    payload,
  };
  writeJson(join(partialsDir(runDir), partialName(phase, worker, batch, iso)), art);
}

function prov(phase: string, derivedFrom: string[], sourceRef?: string): Provenance {
  const p: Provenance = { produced_by: phase, derived_from: derivedFrom, timestamp: isoNow() };
  if (sourceRef !== undefined) p.source_ref = sourceRef;
  p.agent = "claude";
  return p;
}

/** 失敗しても throw しない通知（best-effort / 欠落5）。 */
async function notify(runDir: string, event: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ...event, ts: isoNow() });
  try {
    appendFileSync(join(logsDir(runDir), "notify.jsonl"), line + "\n", "utf8");
  } catch {
    /* ignore */
  }
  const hook = process.env["TAIKAI_NOTIFY_WEBHOOK"];
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `[taikai] ${line}` }),
    });
  } catch {
    /* best-effort: 配信失敗でも本体を止めない */
  }
}

/** モデル出力から最初の JSON ブロックを抽出（```json フェンス対応）。 */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1]! : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in model output");
  // 末尾の余分を許容するため、最後の ] か } まで
  const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
  return JSON.parse(body.slice(start, end + 1));
}

// ───────── doctor（起動前バリデータ / 欠落4） ─────────

export async function doctor(runDir: string): Promise<void> {
  const tiPath = tournamentInfoPath(runDir);
  if (!existsSync(tiPath)) {
    console.error(`[S1] E_S1_INPUT: ${tiPath} がない。手書きで用意せよ（欠落4）`);
    await notify(runDir, { type: "E_S1_INPUT", missing: "TOURNAMENT_INFO.json" });
    process.exit(1);
  }
  const ti = readJson<TournamentInfo>(tiPath);
  const required: (keyof TournamentInfo)[] = [
    "name",
    "language",
    "run_cmd",
    "test_cmd",
    "test_source",
    "submission",
  ];
  const missing = required.filter((k) => ti[k] === undefined);
  if (missing.length > 0) {
    console.error(`[S1] E_S1_INPUT: TOURNAMENT_INFO 必須欠落: ${missing.join(", ")}`);
    await notify(runDir, { type: "E_S1_INPUT", missing });
    process.exit(1);
  }
  if (!existsSync(scoringRubricPath(runDir))) {
    console.error(`[S1] SCORING_RUBRIC.json がない（S1 が導出 or 手書き）`);
    process.exit(1);
  }
  console.log(`[doctor] OK: ${ti.name} (lang=${ti.language}, test_source=${ti.test_source})`);
}

// ───────── 縦串本体 ─────────

export async function runSlice(runDir: string): Promise<void> {
  ensureDirs(runDir);
  await doctor(runDir);

  const ti = readJson<TournamentInfo>(tournamentInfoPath(runDir));
  const rubric = readJson<ScoringRubric>(scoringRubricPath(runDir));
  const specPath = join(runDir, "spec.md");
  const spec = existsSync(specPath) ? readFileSync(specPath, "utf8") : ti.name;
  const runId = relative("outputs", runDir) || "run";

  // ── S3 戦略生成（cold-start: requirement/subject のみ）──
  console.log("[S3] 戦略生成…");
  const s3Prompt = `${readFileSync(MVP_PHASES["S3"]!.promptPath, "utf8")}

## 課題仕様
${spec}

## 評価
eval_mode=${rubric.eval_mode}, metrics=${rubric.metrics.map((m) => m.name).join(",")}

Strategy[] の JSON だけを出力（id/origin/approach）。origin は "requirement" か "subject"。`;
  const s3out = await runCLISubprocess("claude", {
    prompt: s3Prompt,
    timeoutMs: MVP_PHASES["S3"]!.timeoutMs,
  });
  if (s3out.emptyResult) {
    console.error("[S3] 空出力（E_LLM_COMM）");
    process.exit(1);
  }
  let strategies: Strategy[];
  try {
    strategies = extractJson(s3out.text) as Strategy[];
  } catch (e) {
    console.error(`[S3] JSON 解析失敗: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
  strategies = strategies.filter((s) => s.origin === "requirement" || s.origin === "subject");
  if (strategies.length === 0) {
    console.error("[S3] cold-start で使える戦略が0");
    process.exit(1);
  }
  strategies.forEach((s, i) =>
    writePartial(runDir, "S3", 0, i, s, prov("S3", [`rubric:${rubric.derived_from}`])),
  );
  const strategy = strategies[0]!;
  if (!strategy.id) strategy.id = "strat0";
  console.log(`[S3] ${strategies.length}個。先頭=${strategy.id}: ${strategy.approach.slice(0, 60)}`);

  // ── S5 コード生成（D22 Reflexion ループ）──
  console.log("[S5] D22 ループ…");
  const projDir = join(runDir, "projects", strategy.id);
  mkdirSync(join(projDir, "src"), { recursive: true });
  // provided テストを run dir から projects へコピー＋sha256 凍結（欠落2）
  const runTests = join(runDir, "tests");
  const projTests = join(projDir, "tests");
  if (!existsSync(runTests)) {
    console.error(`[S5] provided テスト ${runTests} がない（test_source=${ti.test_source}）`);
    process.exit(1);
  }
  cpSync(runTests, projTests, { recursive: true });
  const testFrozen = hashDir(projTests);

  const manifest: ProjectManifest = {
    language: ti.language,
    entrypoint: ti.language === "python" ? "src/main.py" : "src/main.js",
    run_cmd: ti.run_cmd,
    test_cmd: ti.test_cmd,
    timeout_ms: 60_000,
  };
  writeJson(join(projDir, "manifest.json"), manifest);

  const maxAttempts = MVP_PHASES["S5"]!.maxAttempts ?? 3;
  const feedbackHistory: string[] = [];
  let passed = false;
  let lastTestOutput = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fb = feedbackHistory.length
      ? `\n## 前回の失敗（これに対処せよ・テストは改変禁止）\n${lastTestOutput.slice(0, 2000)}`
      : "";
    const s5Prompt = `${readFileSync(MVP_PHASES["S5"]!.promptPath, "utf8")}

## 課題仕様
${spec}

## 戦略
${strategy.approach}

## 言語: ${ti.language}（${manifest.entrypoint} に書く）
出力は {"fixed_code": "<コード全文>"} の JSON だけ。${fb}`;

    const out = await runCLISubprocess("claude", {
      prompt: s5Prompt,
      timeoutMs: MVP_PHASES["S5"]!.timeoutMs,
    });
    let code = "";
    try {
      const obj = extractJson(out.text) as { fixed_code?: string };
      code = obj.fixed_code ?? "";
    } catch {
      code = "";
    }
    if (!code.trim()) {
      feedbackHistory.push(`attempt ${attempt}: 空/不正な生成`);
      lastTestOutput = "model returned empty fixed_code";
      writePartial<CodeAttempt>(
        runDir,
        "S5",
        0,
        attempt,
        { attempt, code_ref: manifest.entrypoint, passed_anchor_ids: [], newly_passed_ids: [], regressed: false },
        prov("S5", [strategy.id]),
        "error",
      );
      continue;
    }
    writeFileSync(join(projDir, manifest.entrypoint), code, "utf8");

    const test = await runCmd(manifest.test_cmd, projDir, manifest.timeout_ms);
    lastTestOutput = (test.stdout + "\n" + test.stderr).trim();
    const ok = test.code === 0 && !test.timedOut;
    feedbackHistory.push(
      `attempt ${attempt}: ${ok ? "PASS" : "FAIL"} (exit ${test.code}${test.timedOut ? ", timeout" : ""})`,
    );
    writePartial<CodeAttempt>(
      runDir,
      "S5",
      0,
      attempt,
      {
        attempt,
        code_ref: manifest.entrypoint,
        passed_anchor_ids: ok ? ["all"] : [],
        newly_passed_ids: ok ? ["all"] : [],
        regressed: false,
      },
      prov("S5", [strategy.id]),
    );
    console.log(`[S5]   attempt ${attempt}: ${ok ? "PASS" : "FAIL"}`);
    if (ok) {
      passed = true;
      break;
    }
  }

  // ── S6 ベンチマーク（test型 / 改変検知）──
  console.log("[S6] 採点…");
  const testNow = hashDir(projTests);
  if (testNow !== testFrozen) {
    console.error("[S6] E_TEST_TAMPER: テストが改変された → 失格");
    await notify(runDir, { type: "E_TEST_TAMPER", strategy: strategy.id });
    process.exit(1);
  }
  const finalTest = await runCmd(manifest.test_cmd, projDir, manifest.timeout_ms);
  const ratio = parsePytestRatio(finalTest.stdout + finalTest.stderr, finalTest.code);

  const result: BenchResult = {
    result_id: runId,
    strategy_id: strategy.id,
    rubric_ref: rubric.derived_from,
    eval_mode: rubric.eval_mode,
    score: ratio,
    rank: 1,
    metrics: { passed_test_ratio: ratio },
    passed_test_ratio: ratio,
    threshold: [],
  };
  writeJson(resultPath(runDir), result);
  console.log(`[S6] passed_test_ratio=${ratio} → ${resultPath(runDir)}`);

  // ── leaderboard（欠落8）＋ 通知（欠落5）──
  appendLeaderboard({
    run_id: runId,
    strategy_id: strategy.id,
    rubric_ref: rubric.derived_from,
    score: ratio,
    passed_test_ratio: ratio,
    result_ref: resultPath(runDir),
    ts: isoNow(),
  });
  await notify(runDir, { type: "run_complete", passed, ratio, strategy: strategy.id });
  console.log(`[done] passed=${passed} ratio=${ratio}`);
}

// ───────── 補助 ─────────

function hashDir(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir).sort()) {
    h.update(f).update(readFileSync(join(dir, f)));
  }
  return h.digest("hex");
}

function parsePytestRatio(output: string, code: number): number {
  const passed = Number(output.match(/(\d+) passed/)?.[1] ?? 0);
  const failed = Number(output.match(/(\d+) failed/)?.[1] ?? 0);
  const total = passed + failed;
  if (total > 0) return passed / total;
  return code === 0 ? 1 : 0;
}

function appendLeaderboard(entry: LeaderboardEntry): void {
  const path = leaderboardPath();
  mkdirSync("outputs", { recursive: true });
  let arr: LeaderboardEntry[] = [];
  if (existsSync(path)) {
    try {
      arr = readJson<LeaderboardEntry[]>(path);
    } catch {
      arr = [];
    }
  }
  arr.push(entry);
  arr.sort((a, b) => b.score - a.score);
  writeJson(path, arr);
}

void sha256; // 予約（イベント/冪等で使用予定）
