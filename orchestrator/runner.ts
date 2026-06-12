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
import { notify } from "./notify.ts";
import { pipelineStarted, phaseStarted, phaseCompleted } from "./events.ts";
import { archiveRun } from "./archiver.ts";
import { CircuitBreaker } from "./circuitBreaker.ts";
import { dedupStrategies } from "./collector.ts";
import { validateArtifact } from "./validate.ts";
import { backupResult } from "./backup.ts";
import { runBattleEval } from "./s6battle.ts";
import type { BattlePlayer } from "./battleRunner.ts";
import { langProfile } from "./langSupport.ts";
import { gatherKnowledge, refineRequirements } from "./loopPhases.ts";
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
  CodegenResult,
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

/**
 * D22 reflector（既定=LLM）。失敗したコードとテスト出力から「何が悪く次どう直すか」を
 * 短い改善指示として生成する（コードは書かせない）。テストは正しい前提＝改変させない。
 */
async function reflect(spec: string, code: string, testOutput: string): Promise<string> {
  const prompt = `あなたは S5 reflector。失敗したコードとテスト出力を読み、**何が悪く次どう直すか**を日本語で2〜3文に。
コードは書かない（方針だけ）。テストは正しい前提なので「テストを直す」提案は禁止。

## 課題仕様
${spec}

## 失敗したコード
${code.slice(0, 1500)}

## テスト出力
${testOutput.slice(0, 1500)}`;
  try {
    const out = await runCLISubprocess("claude", { prompt, timeoutMs: 60_000 });
    return out.text.trim().slice(0, 500);
  } catch {
    return ""; // reflector 失敗時は素の失敗出力注入にフォールバック
  }
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
  pipelineStarted(runDir, runId);

  // ── S6 対戦モード分岐（eval_mode=battle）──
  if (rubric.eval_mode === "battle") {
    await runBattle(runDir, ti, rubric, runId);
    return;
  }

  // ── S3 戦略生成（cold-start: requirement/subject のみ）──
  phaseStarted(runDir, "S3");
  console.log("[S3] 戦略生成…");
  const s3Prompt = `${readFileSync(MVP_PHASES["S3"]!.promptPath, "utf8")}

## 課題仕様
${spec}

## 評価
eval_mode=${rubric.eval_mode}, metrics=${rubric.metrics.map((m) => m.name).join(",")}

Strategy[] の JSON だけを出力（id/origin/approach）。origin は "requirement" か "subject"。`;
  // resume（D9/AC5）: 既存 S3 partial があれば再生成せず再利用＝高価な LLM 呼び出しの二重実行回避。
  let strategies: Strategy[] | null = loadExistingS3(runDir);
  if (strategies) {
    console.log(`[S3] resume: 既存 ${strategies.length} 戦略を再利用（再生成スキップ）`);
  }
  // 難問だとモデルが地の文を返すことがあるため、JSON が取れるまで厳格化して最大3回リトライ。
  for (let tryN = 1; tryN <= 3 && !strategies; tryN++) {
    const strict =
      tryN === 1
        ? ""
        : "\n\n⚠ 前回 JSON 配列で出力されなかった。**出力は JSON 配列のみ**。先頭文字は `[`、末尾は `]`。地の文・前置き・解説を一切書くな。";
    const out = await runCLISubprocess("claude", {
      prompt: s3Prompt + strict,
      timeoutMs: MVP_PHASES["S3"]!.timeoutMs,
    });
    if (out.emptyResult) continue;
    try {
      const parsed = extractJson(out.text);
      if (Array.isArray(parsed) && parsed.length > 0) strategies = parsed as Strategy[];
    } catch {
      /* 次の試行で厳格化 */
    }
  }
  if (!strategies) {
    console.error("[S3] 戦略 JSON を3回試行しても取得できず（E_LLM_COMM）");
    process.exit(1);
  }
  strategies = strategies.filter((s) => s.origin === "requirement" || s.origin === "subject");
  if (strategies.length === 0) {
    console.error("[S3] cold-start で使える戦略が0");
    process.exit(1);
  }
  const beforeDedup = strategies.length;
  strategies = dedupStrategies(strategies); // 被り・類似戦略を統合（merged_from 記録）
  if (strategies.length < beforeDedup) {
    console.log(`[S3] 統合: ${beforeDedup}→${strategies.length}`);
  }
  strategies.forEach((s, i) =>
    writePartial(runDir, "S3", 0, i, s, prov("S3", [`rubric:${rubric.derived_from}`])),
  );
  const strategy = strategies[0]!;
  if (!strategy.id) strategy.id = "strat0";
  console.log(`[S3] ${strategies.length}個。先頭=${strategy.id}: ${strategy.approach.slice(0, 60)}`);
  phaseCompleted(runDir, "S3", "ok");

  // ── S5 コード生成（D22 Reflexion ループ）──
  phaseStarted(runDir, "S5");
  console.log("[S5] D22 ループ…");
  const cb = new CircuitBreaker();
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
    entrypoint: langProfile(ti.language).entrypoint, // 言語非依存（python/node/ts）
    run_cmd: ti.run_cmd,
    test_cmd: ti.test_cmd,
    timeout_ms: 60_000,
  };
  writeJson(join(projDir, "manifest.json"), manifest);
  // node(CJS): repo root の "type":"module" 下で require/module.exports を動かすため
  if (ti.language === "node") {
    writeFileSync(join(projDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  }

  const maxAttempts = MVP_PHASES["S5"]!.maxAttempts ?? 3;
  const feedbackHistory: string[] = [];
  let passed = false;
  let lastTestOutput = "";
  let lastReflection = ""; // D22 reflector の改善指示（LLM 既定）

  // resume（D9/AC5）: 既に通過した S5 attempt があり生成コードが残っていれば D22 ループをスキップ。
  if (s5AlreadyPassed(runDir) && existsSync(join(projDir, manifest.entrypoint))) {
    const re = await runCmd(manifest.test_cmd, projDir, manifest.timeout_ms);
    if (re.code === 0 && !re.timedOut) {
      passed = true;
      console.log("[S5] resume: 既存の通過コードを再利用（生成スキップ）");
    }
  }

  for (let attempt = 1; !passed && attempt <= maxAttempts; attempt++) {
    const fb = feedbackHistory.length
      ? `\n## 前回の失敗（これに対処せよ・テストは改変禁止）\n${
          lastReflection ? `改善指示: ${lastReflection}\n` : ""
        }テスト出力:\n${lastTestOutput.slice(0, 1500)}`
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
      cb.recordEmpty();
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
    cb.recordResult(ok);
    console.log(`[S5]   attempt ${attempt}: ${ok ? "PASS" : "FAIL"}`);
    if (ok) {
      passed = true;
      break;
    }
    if (cb.tripped()) {
      console.error(`[S5] Circuit Breaker tripped (${cb.reason()}) → 打ち切り`);
      break;
    }
    // D22 reflector（既定=LLM）: 失敗理由→改善指示を生成し次試行に注入。
    // TAIKAI_REFLECTOR=template で素の失敗出力注入のみ（opt-in 緩和）。
    if (attempt < maxAttempts && process.env["TAIKAI_REFLECTOR"] !== "template") {
      lastReflection = await reflect(spec, code, lastTestOutput);
      console.log(`[S5]   reflect: ${lastReflection.slice(0, 80)}`);
    }
  }
  phaseCompleted(runDir, "S5", passed ? "ok" : "partial");

  // CodegenResult 永続化（AC2 / §3-6）: D22 系列の証跡（feedbackHistory）をファイルに残す。
  // これまで feedbackHistory はローカル変数で消えていた＝reflector 実発火の証跡が outputs に
  // 残らず AC2 が「メモリ上のみ」だった。S5 の最終結果を契約付きで書き出す。
  const codegen: CodegenResult = {
    strategy_id: strategy.id,
    passed,
    attempts: feedbackHistory.length,
    feedbackHistory,
    ...(lastReflection ? { finalFeedback: lastReflection } : {}),
  };
  const cgCheck = validateArtifact("CodegenResult", codegen);
  if (!cgCheck.valid) console.warn(`[S5] ⚠ CodegenResult 契約に不一致: ${cgCheck.message}`);
  writePartial<CodegenResult>(
    runDir,
    "S5R", // S5 の result（CodeAttempt partial=phase "S5" と衝突しない別タグ）
    0,
    0,
    codegen,
    prov("S5R", [strategy.id]),
    passed ? "ok" : "partial",
  );

  // ── S6 ベンチマーク（test型 / 改変検知）──
  phaseStarted(runDir, "S6");
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
    // AC6: result 単体から戦略→要件→ルールまで遡れる来歴。derived_from=戦略 id（戦略 partial の
    // provenance がさらに rubric/要件へ繋がる）。source_ref に rubric_ref を併記して 1 ホップで rubric も指す。
    provenance: prov("S6", [strategy.id], rubric.derived_from),
  };
  const check = validateArtifact("BenchResult", result); // 契約検証（非throw・警告のみ）
  if (!check.valid) console.warn(`[S6] ⚠ result が BenchResult 契約に不一致: ${check.message}`);
  writeJson(resultPath(runDir), result);
  phaseCompleted(runDir, "S6", "ok");
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
  const bk = backupResult(runDir); // 欠落6: TAIKAI_BACKUP_DIR があれば成果物を複製
  if (bk.backedUp) console.log(`[backup] ${bk.copied.length} 件複製`);
  const arch = archiveRun(runDir); // run アーカイブ・マニフェスト（sha256）
  writeJson(join(runDir, "archive_manifest.json"), arch);
  await notify(runDir, { type: "run_complete", passed, ratio, strategy: strategy.id });
  console.log(`[done] passed=${passed} ratio=${ratio}`);
}

// ═════════ 多戦略 実験ループ（experiment）═════════
// 複数戦略を実装・採点し、いいとこを比較、閾値（maxAttempts）を振って実験し、round でくるくる回す。

interface StrategyOutcome {
  strategyId: string;
  passed: boolean;
  ratio: number;
  attempts: number;
  maxAttempts: number;
}

/** 1戦略を test 型で実装(S5 D22)→採点(S6)。非致命（失敗しても throw/exit しない）。batch で partial 衝突回避。 */
async function implementStrategyTest(
  runDir: string,
  strategy: Strategy,
  ti: TournamentInfo,
  spec: string,
  maxAttempts: number,
  batch: number,
): Promise<StrategyOutcome> {
  const cb = new CircuitBreaker();
  const projDir = join(runDir, "projects", strategy.id);
  mkdirSync(join(projDir, "src"), { recursive: true });
  const runTests = join(runDir, "tests");
  if (!existsSync(runTests)) return { strategyId: strategy.id, passed: false, ratio: 0, attempts: 0, maxAttempts };
  const projTests = join(projDir, "tests");
  cpSync(runTests, projTests, { recursive: true });
  const testFrozen = hashDir(projTests);

  const manifest: ProjectManifest = {
    language: ti.language,
    entrypoint: langProfile(ti.language).entrypoint,
    run_cmd: ti.run_cmd,
    test_cmd: ti.test_cmd,
    timeout_ms: 60_000,
  };
  writeJson(join(projDir, "manifest.json"), manifest);
  if (ti.language === "node") {
    writeFileSync(join(projDir, "package.json"), JSON.stringify({ type: "commonjs" }), "utf8");
  }

  let passed = false;
  let attempts = 0;
  let lastTestOutput = "";
  let lastReflection = "";
  for (let attempt = 1; !passed && attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const fb = attempt > 1
      ? `\n## 前回の失敗（対処せよ・テスト改変禁止）\n${lastReflection ? `改善指示: ${lastReflection}\n` : ""}テスト出力:\n${lastTestOutput.slice(0, 1500)}`
      : "";
    const s5Prompt = `${readFileSync(MVP_PHASES["S5"]!.promptPath, "utf8")}\n\n## 課題仕様\n${spec}\n\n## 戦略\n${strategy.approach}\n\n## 言語: ${ti.language}（${manifest.entrypoint} に書く）\n出力は {"fixed_code": "<コード全文>"} の JSON だけ。${fb}`;
    const out = await runCLISubprocess("claude", { prompt: s5Prompt, timeoutMs: MVP_PHASES["S5"]!.timeoutMs });
    let code = "";
    try {
      code = (extractJson(out.text) as { fixed_code?: string }).fixed_code ?? "";
    } catch {
      code = "";
    }
    if (!code.trim()) {
      cb.recordEmpty();
      lastTestOutput = "empty fixed_code";
      if (cb.tripped()) break;
      continue;
    }
    writeFileSync(join(projDir, manifest.entrypoint), code, "utf8");
    const test = await runCmd(manifest.test_cmd, projDir, manifest.timeout_ms);
    lastTestOutput = (test.stdout + "\n" + test.stderr).trim();
    const ok = test.code === 0 && !test.timedOut;
    cb.recordResult(ok);
    writePartial<CodeAttempt>(runDir, "S5", batch, attempt,
      { attempt, code_ref: manifest.entrypoint, passed_anchor_ids: ok ? ["all"] : [], newly_passed_ids: ok ? ["all"] : [], regressed: false },
      prov("S5", [strategy.id]));
    if (ok) { passed = true; break; }
    if (cb.tripped()) break;
    if (attempt < maxAttempts && process.env["TAIKAI_REFLECTOR"] !== "template") {
      lastReflection = await reflect(spec, code, lastTestOutput);
    }
  }
  // S6: 改変検知 → 採点
  let ratio = 0;
  if (hashDir(projTests) === testFrozen) {
    const finalTest = await runCmd(manifest.test_cmd, projDir, manifest.timeout_ms);
    ratio = parsePytestRatio(finalTest.stdout + finalTest.stderr, finalTest.code);
  } else {
    console.warn(`[experiment] ${strategy.id}: E_TEST_TAMPER → 0点`);
  }
  return { strategyId: strategy.id, passed, ratio, attempts, maxAttempts };
}

/** S3: 戦略を生成（厳格化リトライ＋dedup＋cold-start filter）。実験/単発/ループで共用可。
 *  priorWinners があれば「いいとこ取り」: 高得点 approach を種に改良・組合せさせる（結果再投入）。 */
async function generateStrategies(
  spec: string,
  rubric: ScoringRubric,
  priorWinners?: { approach: string; ratio: number }[],
): Promise<Strategy[]> {
  const seed =
    priorWinners && priorWinners.length > 0
      ? `\n\n## これまでの高得点戦略（いいとこ取りして改良・組合せ、さらに強い新戦略を出せ。丸写しは禁止）\n${priorWinners
          .map((w, i) => `${i + 1}. (score=${w.ratio.toFixed(3)}) ${w.approach}`)
          .join("\n")}`
      : "";
  const base = `${readFileSync(MVP_PHASES["S3"]!.promptPath, "utf8")}\n\n## 課題仕様\n${spec}\n\n## 評価\neval_mode=${rubric.eval_mode}, metrics=${rubric.metrics.map((m) => m.name).join(",")}${seed}\n\nStrategy[] の JSON だけを出力（id/origin/approach）。origin は "requirement" か "subject"。多様なアプローチを3〜5個。`;
  let strategies: Strategy[] | null = null;
  for (let tryN = 1; tryN <= 3 && !strategies; tryN++) {
    const strict = tryN === 1 ? "" : "\n\n⚠ 出力は JSON 配列のみ。先頭 `[` 末尾 `]`。地の文禁止。";
    const out = await runCLISubprocess("claude", { prompt: base + strict, timeoutMs: MVP_PHASES["S3"]!.timeoutMs });
    if (out.emptyResult) continue;
    try {
      const parsed = extractJson(out.text);
      if (Array.isArray(parsed) && parsed.length > 0) strategies = parsed as Strategy[];
    } catch {
      /* retry */
    }
  }
  if (!strategies) return [];
  return dedupStrategies(strategies.filter((s) => s.origin === "requirement" || s.origin === "subject"));
}

/** 多戦略実験ループ（test型）。複数戦略を実装・採点し、いいとこ比較・閾値実験・round くるくる。 */
export async function runExperiment(
  runDir: string,
  opts: { rounds?: number; topK?: number } = {},
): Promise<void> {
  ensureDirs(runDir);
  await doctor(runDir);
  const ti = readJson<TournamentInfo>(tournamentInfoPath(runDir));
  const rubric = readJson<ScoringRubric>(scoringRubricPath(runDir));
  if (rubric.eval_mode !== "test") {
    console.error("[experiment] 現状 test 型のみ対応（battle 型は run を使う）");
    process.exit(2);
  }
  const spec = existsSync(join(runDir, "spec.md")) ? readFileSync(join(runDir, "spec.md"), "utf8") : ti.name;
  const runId = relative("outputs", runDir) || "run";
  const rounds = Math.max(1, opts.rounds ?? 2);
  const topK = Math.max(1, opts.topK ?? 2);
  pipelineStarted(runDir, runId);

  const pool: Strategy[] = [];
  const outcomes: StrategyOutcome[] = [];
  let best: StrategyOutcome | null = null;
  const maxAttempts = MVP_PHASES["S5"]!.maxAttempts ?? 3;
  let batch = 0;

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n=== round ${round}/${rounds} ===`);
    // round ごとに id を一意化（claude は毎回同じ id を返すため。approach は dedup 済み）
    const fresh = (await generateStrategies(spec, rubric)).map((s) => ({
      ...s,
      id: `r${round}-${s.id}`,
    }));
    pool.push(...fresh);
    const targets = fresh.slice(0, topK);
    console.log(`[round ${round}] 新規戦略 ${fresh.length} → 実装 ${targets.length}`);
    for (const strat of targets) {
      const oc = await implementStrategyTest(runDir, strat, ti, spec, maxAttempts, batch++);
      outcomes.push(oc);
      appendLeaderboard({
        run_id: runId, strategy_id: oc.strategyId, rubric_ref: rubric.derived_from,
        score: oc.ratio, passed_test_ratio: oc.ratio, result_ref: resultPath(runDir), ts: isoNow(),
      });
      console.log(`  ${oc.strategyId}: ratio=${oc.ratio.toFixed(3)} (attempts=${oc.attempts})`);
      if (!best || oc.ratio > best.ratio) best = oc;
    }
  }

  // 閾値変化実験: 勝者戦略を maxAttempts=1 で再実装し、少回数で足りるか比較（開発/閾値実験）
  let thresholdFinding = "（実験なし）";
  if (best) {
    const winner = pool.find((s) => s.id === best!.strategyId);
    if (winner) {
      console.log(`\n[閾値実験] 勝者 ${winner.id} を maxAttempts=1 で再評価…`);
      const t1 = await implementStrategyTest(runDir, { ...winner, id: `${winner.id}__k1` }, ti, spec, 1, batch++);
      thresholdFinding = t1.ratio >= best.ratio
        ? `maxAttempts=1 でも ratio=${t1.ratio.toFixed(3)}（${best.maxAttempts}回と同等）→ 1回で十分`
        : `maxAttempts=1 は ratio=${t1.ratio.toFixed(3)} < ${best.ratio.toFixed(3)} → 複数回が有効`;
      console.log(`[閾値実験] ${thresholdFinding}`);
    }
  }

  // いいとこ取り（次round 種）＝勝者 approach を要約して記録
  const summary = {
    run_id: runId, rounds, topK,
    strategies_tried: outcomes.length,
    best: best ? { strategy_id: best.strategyId, ratio: best.ratio, attempts: best.attempts } : null,
    threshold_experiment: thresholdFinding,
    outcomes,
  };
  writeJson(join(runDir, "experiment_summary.json"), summary);
  await notify(runDir, { type: "experiment_complete", best: best?.strategyId, ratio: best?.ratio });
  console.log(`\n[experiment] 勝者=${best?.strategyId ?? "?"} ratio=${best?.ratio.toFixed(3) ?? "?"} / 試行 ${outcomes.length} 戦略 → experiment_summary.json`);
}

/**
 * ぐるぐる回る本体（docs の S1→S6 無限ループの test 型実体）。
 * S1(一度) → [S3 戦略生成(前round勝者を種=いいとこ取り) → S5 実装 → S6 採点 → 結果再投入]* を
 * 改善が止まる(patience)か maxRounds まで回し続ける。現時点の最強を出し続ける。
 */
export async function runLoop(
  runDir: string,
  opts: { maxRounds?: number; topK?: number; patience?: number } = {},
): Promise<void> {
  ensureDirs(runDir);
  await doctor(runDir);
  const ti = readJson<TournamentInfo>(tournamentInfoPath(runDir));
  const rubric = readJson<ScoringRubric>(scoringRubricPath(runDir));
  if (rubric.eval_mode !== "test") {
    console.error("[loop] 現状 test 型のみ（battle は run を使う）");
    process.exit(2);
  }
  const spec = existsSync(join(runDir, "spec.md")) ? readFileSync(join(runDir, "spec.md"), "utf8") : ti.name;
  const runId = relative("outputs", runDir) || "run";
  const maxRounds = Math.max(1, opts.maxRounds ?? 50);
  const topK = Math.max(1, opts.topK ?? 2);
  const patience = Math.max(1, opts.patience ?? 4);
  pipelineStarted(runDir, runId);

  // S2 外部知見（任意・graceful）→ S4 要件精緻化（任意・graceful）。spec を一度だけ強化。
  let workSpec = spec;
  const knowledge = await gatherKnowledge(runDir, ti);
  if (knowledge) {
    workSpec = `${workSpec}\n\n## 外部知見（S2）\n${knowledge}`;
    console.log("[S2] 外部知見を取得して spec に反映");
  }
  if (process.env["TAIKAI_SKIP_S4"] !== "1") {
    const refined = await refineRequirements(workSpec, "");
    if (refined && refined !== workSpec) {
      workSpec = refined;
      console.log("[S4] 要件を精緻化");
    }
  }

  const outcomes: { strategyId: string; approach: string; ratio: number }[] = [];
  let best: { strategyId: string; approach: string; ratio: number } | null = null;
  let noImprove = 0;
  let batch = 0;
  const progression: { round: number; best_ratio: number; strongest: string }[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    // いいとこ取り: これまでの上位 approach を種に再投入
    const priorTop = [...outcomes].sort((a, b) => b.ratio - a.ratio).slice(0, 2).map((o) => ({ approach: o.approach, ratio: o.ratio }));
    const fresh = (await generateStrategies(workSpec, rubric, priorTop.length ? priorTop : undefined)).map((s) => ({
      ...s,
      id: `r${round}-${s.id}`,
    }));
    if (fresh.length === 0) {
      console.log(`[loop] round ${round}: 戦略生成0 → スキップ`);
      continue;
    }
    const targets = fresh.slice(0, topK);
    console.log(`\n=== round ${round}/${maxRounds} (best=${best?.ratio.toFixed(3) ?? "-"}) ===`);
    let improvedThisRound = false;
    for (const strat of targets) {
      const oc = await implementStrategyTest(runDir, strat, ti, workSpec, MVP_PHASES["S5"]!.maxAttempts ?? 3, batch++);
      const rec = { strategyId: oc.strategyId, approach: strat.approach, ratio: oc.ratio };
      outcomes.push(rec);
      appendLeaderboard({
        run_id: runId, strategy_id: oc.strategyId, rubric_ref: rubric.derived_from,
        score: oc.ratio, passed_test_ratio: oc.ratio, result_ref: resultPath(runDir), ts: isoNow(),
      });
      console.log(`  ${oc.strategyId}: ratio=${oc.ratio.toFixed(3)}`);
      if (!best || oc.ratio > best.ratio) {
        best = rec;
        improvedThisRound = true;
      }
    }
    // 現時点の最強を result.json に出し続ける
    if (best) {
      const result: BenchResult = {
        result_id: `${runId}-r${round}`, strategy_id: best.strategyId, rubric_ref: rubric.derived_from,
        eval_mode: "test", score: best.ratio, rank: 1, metrics: { passed_test_ratio: best.ratio },
        passed_test_ratio: best.ratio, threshold: [],
        provenance: prov("S6", [best.strategyId], rubric.derived_from), // AC6: result→戦略→rubric
      };
      writeJson(resultPath(runDir), result);
    }
    progression.push({ round, best_ratio: best?.ratio ?? 0, strongest: best?.strategyId ?? "?" });
    phaseCompleted(runDir, "S6", "ok");
    console.log(`[loop] 現最強=${best?.strategyId ?? "?"} ratio=${best?.ratio.toFixed(3) ?? "?"}`);

    noImprove = improvedThisRound ? 0 : noImprove + 1;
    if (best && best.ratio >= 1.0) {
      console.log(`[loop] 満点到達 → 収束`);
      break;
    }
    if (noImprove >= patience) {
      console.log(`[loop] ${patience} round 改善なし → 収束`);
      break;
    }
  }

  writeJson(join(runDir, "loop_summary.json"), {
    run_id: runId, rounds_run: progression.length, strategies_tried: outcomes.length,
    strongest: best, progression,
  });
  const arch = archiveRun(runDir);
  writeJson(join(runDir, "archive_manifest.json"), arch);
  await notify(runDir, { type: "loop_complete", strongest: best?.strategyId, ratio: best?.ratio, rounds: progression.length });
  console.log(`\n[loop] 完了: ${progression.length} round / ${outcomes.length} 戦略 / 最強=${best?.strategyId ?? "?"} ratio=${best?.ratio.toFixed(3) ?? "?"}`);
}

/** resume: 通過済み S5 attempt（newly_passed_ids 非空）が partial にあるか（D9/AC5）。 */
function s5AlreadyPassed(runDir: string): boolean {
  const dir = partialsDir(runDir);
  if (!existsSync(dir)) return false;
  const files = readdirSync(dir).filter((f) => f.startsWith("S5_PARTIAL_") && f.endsWith(".json"));
  for (const f of files) {
    try {
      const art = readJson<PhaseArtifact<CodeAttempt>>(join(dir, f));
      if (art.status !== "error" && (art.payload?.newly_passed_ids?.length ?? 0) > 0) return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

/** resume: 既存 S3 partial（status!=="error"）から戦略を復元。無ければ null（D9/AC5）。 */
function loadExistingS3(runDir: string): Strategy[] | null {
  const dir = partialsDir(runDir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("S3_PARTIAL_") && f.endsWith(".json"));
  const out: Strategy[] = [];
  for (const f of files) {
    try {
      const art = readJson<PhaseArtifact<Strategy>>(join(dir, f));
      if (art.status !== "error" && art.payload?.id) out.push(art.payload);
    } catch {
      /* 壊れた partial はスキップ */
    }
  }
  return out.length > 0 ? out : null;
}

// ───────── S6 対戦モード（戦略プログラム同士を実対戦）─────────

async function runBattle(
  runDir: string,
  ti: TournamentInfo,
  rubric: ScoringRubric,
  runId: string,
): Promise<void> {
  const playersDir = join(runDir, "players");
  if (!existsSync(playersDir)) {
    console.error(`[S6 battle] ${playersDir} がない（players/{id}/ を用意せよ）`);
    process.exit(1);
  }
  const players: BattlePlayer[] = readdirSync(playersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, run_cmd: ti.run_cmd, cwd: join(playersDir, d.name) }));
  if (players.length < 2) {
    console.error(`[S6 battle] プレイヤーが2未満（${players.length}）`);
    process.exit(1);
  }
  console.log(`[S6 battle] ${players.length} player 総当たり…`);
  const results = await runBattleEval(
    players,
    { derived_from: rubric.derived_from, eval_mode: "battle" },
    20,
    { runId, moveTimeoutMs: 10_000 },
  );
  results.forEach((r, i) => writePartial<BenchResult>(runDir, "S6", 0, i, r, prov("S6", [r.strategy_id])));
  const top = results.find((r) => r.rank === 1) ?? results[0];
  if (top) writeJson(resultPath(runDir), top);
  phaseCompleted(runDir, "S6", "ok");
  for (const r of results) {
    appendLeaderboard({
      run_id: runId,
      strategy_id: r.strategy_id,
      rubric_ref: r.rubric_ref,
      score: r.score,
      passed_test_ratio: r.win_rate ?? 0,
      result_ref: resultPath(runDir),
      ts: isoNow(),
    });
  }
  await notify(runDir, {
    type: "battle_complete",
    players: players.length,
    winner: top?.strategy_id,
    win_rate: top?.win_rate,
  });
  console.log(
    `[done] battle winner=${top?.strategy_id ?? "?"} win_rate=${top?.win_rate?.toFixed(3) ?? "?"}`,
  );
  for (const r of results) {
    console.log(`  #${r.rank} ${r.strategy_id}: win_rate=${(r.win_rate ?? 0).toFixed(3)}`);
  }
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
