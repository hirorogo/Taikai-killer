/**
 * JSON Schema 検証層（D2 / ajv）。
 * schemas/*.schema.json を ajv にコンパイルし、name 指定で validate する。
 * TS 型の正は types.ts。schema 実体は schemas/。両者は厳密一致させる。
 *
 *   loadSchemas()        全 *.schema.json を ajv に登録（$id=スキーマ名）
 *   validate(name,data)  検証。失敗時は詳細エラー付き ValidationResult
 *   assertValid(name,..) 失敗時に throw（呼び出し側で fail-fast したい時）
 *
 * 自己検証: `tsx orchestrator/schemas.ts --selfcheck` でサンプルを通して exit 0/1。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";

/** 検証対象のスキーマ名（schemas/<name>.schema.json の <name> と一致）。 */
export type SchemaName =
  | "Provenance"
  | "PhaseArtifact"
  | "TournamentInfo"
  | "ScoringRubric"
  | "Strategy"
  | "CodeAttempt"
  | "CodegenResult"
  | "BenchResult"
  | "LeaderboardEntry"
  | "ProjectManifest";

export interface ValidationResult {
  valid: boolean;
  /** ajv の詳細エラー（valid=true なら空）。 */
  errors: ErrorObject[];
  /** 1行に整形した人間可読メッセージ（ログ/notify 用）。 */
  message: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** schemas/ は repo ルート直下（orchestrator/ の隣）。 */
const SCHEMA_DIR = join(HERE, "..", "schemas");

let ajv: Ajv | null = null;
const validators = new Map<string, ValidateFunction>();

/** スキーマファイルから $id（=スキーマ名）を取り出す。無ければファイル名から導出。 */
function schemaIdOf(raw: Record<string, unknown>, file: string): string {
  const id = raw["$id"];
  if (typeof id === "string" && id.length > 0) return id;
  return file.replace(/\.schema\.json$/, "");
}

/**
 * schemas/*.schema.json を全てコンパイルする（冪等）。
 * $ref で相互参照するため、まず全 schema を addSchema してから compile する。
 */
export function loadSchemas(): void {
  if (ajv) return;
  ajv = new Ajv({ allErrors: true, strict: false });

  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"));
  const entries: { name: string; schema: Record<string, unknown> }[] = [];

  // 1st pass: 全 schema を $id 付きで登録（$ref 解決のため先に揃える）
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Record<string, unknown>;
    const name = schemaIdOf(raw, file);
    ajv.addSchema(raw, name);
    entries.push({ name, schema: raw });
  }

  // 2nd pass: validator を取り出してキャッシュ
  for (const { name } of entries) {
    const v = ajv.getSchema(name);
    if (!v) throw new Error(`schema "${name}" のコンパイルに失敗`);
    validators.set(name, v as ValidateFunction);
  }
}

function formatErrors(name: string, errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return `${name}: OK`;
  const parts = errors.map((e) => {
    const path = e.instancePath || "(root)";
    return `${path} ${e.message ?? "invalid"}`;
  });
  return `${name} 検証失敗: ${parts.join("; ")}`;
}

/**
 * name のスキーマで data を検証する。loadSchemas() 未実行なら自動で呼ぶ。
 * 失敗時は throw せず詳細を ValidationResult で返す（呼び出し側がスキップ判断できるよう）。
 */
export function validate(name: SchemaName, data: unknown): ValidationResult {
  loadSchemas();
  const v = validators.get(name);
  if (!v) {
    return {
      valid: false,
      errors: [],
      message: `未知のスキーマ名: ${name}`,
    };
  }
  const valid = v(data) as boolean;
  const errors = (v.errors ?? []) as ErrorObject[];
  return {
    valid,
    errors: valid ? [] : errors,
    message: formatErrors(name, valid ? [] : errors),
  };
}

/** 検証失敗時に Error を投げる版（fail-fast したいフェーズ入口用）。 */
export function assertValid(name: SchemaName, data: unknown): void {
  const r = validate(name, data);
  if (!r.valid) throw new Error(r.message);
}

// ───────── selfcheck（CLI: --selfcheck） ─────────

/**
 * 各スキーマの最小サンプルを検証。全て valid なら exit 0、1つでも失敗なら exit 1。
 * 仕様: `tsx orchestrator/schemas.ts --selfcheck`。
 * サンプルは types.ts の必須フィールドを満たす最小形（runner.ts の実出力に整合）。
 */
function selfcheckSamples(): { name: SchemaName; data: unknown }[] {
  const provenance = {
    produced_by: "S3",
    derived_from: ["rubric:r1"],
    timestamp: "2026-06-11T12:00:00Z",
  };
  return [
    { name: "Provenance", data: provenance },
    {
      name: "PhaseArtifact",
      data: {
        id: "S3:0.0",
        phase: "S3",
        worker: 0,
        batch: 0,
        timestamp: "2026-06-11T12:00:00Z",
        schema_version: "0",
        status: "ok",
        provenance,
        payload: { any: "thing" },
      },
    },
    {
      name: "TournamentInfo",
      data: {
        name: "demo-cup",
        language: "python",
        run_cmd: "python src/main.py",
        test_cmd: "pytest -q",
        test_source: "provided",
        submission: { format: "zip" },
      },
    },
    {
      name: "ScoringRubric",
      data: {
        eval_mode: "test",
        metrics: [{ name: "passed_test_ratio", weight: 1, direction: "max" }],
        forbidden: ["edit tests"],
        derived_from: "tournament:demo-cup",
      },
    },
    {
      name: "Strategy",
      data: { id: "strat0", origin: "requirement", approach: "greedy baseline" },
    },
    {
      name: "CodeAttempt",
      data: {
        attempt: 1,
        code_ref: "src/main.py",
        passed_anchor_ids: [],
        newly_passed_ids: ["all"],
        regressed: false,
      },
    },
    {
      name: "CodegenResult",
      data: {
        strategy_id: "strat0",
        passed: true,
        attempts: 2,
        feedbackHistory: ["attempt 1: FAIL", "attempt 2: PASS"],
      },
    },
    {
      name: "BenchResult",
      data: {
        result_id: "run-1",
        strategy_id: "strat0",
        rubric_ref: "tournament:demo-cup",
        eval_mode: "test",
        score: 1,
        rank: 1,
        metrics: { passed_test_ratio: 1 },
        passed_test_ratio: 1,
        threshold: [],
      },
    },
    {
      name: "LeaderboardEntry",
      data: {
        run_id: "run-1",
        strategy_id: "strat0",
        rubric_ref: "tournament:demo-cup",
        score: 1,
        passed_test_ratio: 1,
        result_ref: "outputs/run-1/result.json",
        ts: "2026-06-11T12:00:00Z",
      },
    },
    {
      name: "ProjectManifest",
      data: {
        language: "python",
        entrypoint: "src/main.py",
        run_cmd: "python src/main.py",
        test_cmd: "pytest -q",
        timeout_ms: 60000,
      },
    },
  ];
}

/**
 * selfcheck 本体。全サンプルを検証し、結果を stdout に出す。
 * 1つでも失敗なら ok=false。CLI から exit code に使う。
 */
export function runSelfcheck(): boolean {
  loadSchemas();
  let ok = true;
  for (const { name, data } of selfcheckSamples()) {
    const r = validate(name, data);
    if (!r.valid) ok = false;
    console.log(`[selfcheck] ${r.valid ? "OK  " : "FAIL"} ${name}${r.valid ? "" : ` — ${r.message}`}`);
  }
  // 異常系も1件確認（必須欠落が正しく弾かれるか）
  const neg = validate("TournamentInfo", { name: "broken" });
  if (neg.valid) {
    ok = false;
    console.log("[selfcheck] FAIL 異常系: 必須欠落が valid 判定された");
  } else {
    console.log("[selfcheck] OK   異常系: 必須欠落を正しく拒否");
  }
  return ok;
}

/** CLI 実行（--selfcheck）。直接起動時のみ動く。 */
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly && process.argv.includes("--selfcheck")) {
  const ok = runSelfcheck();
  console.log(`[selfcheck] ${ok ? "ALL PASS" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}
