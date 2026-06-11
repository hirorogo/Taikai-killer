/**
 * 検証ラッパ（runner / 各フェーズ入口が呼ぶ薄い層）。
 * 実体の検証は schemas.ts の validate(name, data)（ajv）に委譲する。
 * ここでは「型名 = types.ts のデータ型名」で呼べる薄い API を提供し、
 * 失敗時に「どのフィールドがダメか」分かるメッセージを整える。
 *
 *   validateArtifact(typeName, payload) → ValidationResult（throw しない・スキップ判断用）
 *   validateOrThrow(typeName, payload)  → 失敗時に TypeError を投げ payload を絞り込んで返す
 *
 * 型名は schemas.ts の SchemaName（= types.ts の各データ型名）に一致する。
 * schemas.ts / types.ts は読むだけ（このラッパからは編集しない）。
 */
import type { ErrorObject } from "ajv";
import { validate as validateSchema } from "./schemas.ts";
import type { SchemaName, ValidationResult } from "./schemas.ts";
import type {
  Provenance,
  PhaseArtifact,
  TournamentInfo,
  ScoringRubric,
  Strategy,
  CodeAttempt,
  CodegenResult,
  BenchResult,
  LeaderboardEntry,
  ProjectManifest,
} from "./types.ts";

/**
 * 検証で使える型名（= types.ts のデータ型名 = schemas.ts の SchemaName）。
 * 別名 export として ArtifactTypeName を提供（呼び側の意図が読めるよう）。
 */
export type ArtifactTypeName = SchemaName;

/**
 * 型名 → その型の TS 表現を引く対応表（呼び側の payload を型安全にするための補助）。
 * PhaseArtifact は payload 任意なので unknown 受けにする。
 */
export interface TypeNameToPayload {
  Provenance: Provenance;
  PhaseArtifact: PhaseArtifact<unknown>;
  TournamentInfo: TournamentInfo;
  ScoringRubric: ScoringRubric;
  Strategy: Strategy;
  CodeAttempt: CodeAttempt;
  CodegenResult: CodegenResult;
  BenchResult: BenchResult;
  LeaderboardEntry: LeaderboardEntry;
  ProjectManifest: ProjectManifest;
}

/**
 * 1件の ajv エラーを「どのフィールドがダメか」だけに絞った1語に整形する。
 * - instancePath が空（root レベルの必須欠落）は params.missingProperty を拾う。
 * - additionalProperties は params.additionalProperty を拾う（型の取りこぼし検出）。
 * - enum 違反は許容値を併記して「何を入れるべきか」分かるようにする。
 */
function describeError(e: ErrorObject): string {
  const params = (e.params ?? {}) as Record<string, unknown>;

  if (e.keyword === "required" && typeof params["missingProperty"] === "string") {
    const at = e.instancePath ? `${e.instancePath}.` : "";
    return `必須フィールド欠落: ${at}${params["missingProperty"]}`;
  }
  if (e.keyword === "additionalProperties" && typeof params["additionalProperty"] === "string") {
    const at = e.instancePath || "(root)";
    return `未知のフィールド: ${at}/${params["additionalProperty"]}`;
  }
  if (e.keyword === "enum" && Array.isArray(params["allowedValues"])) {
    const at = e.instancePath || "(root)";
    return `${at} は許容値外（許容: ${(params["allowedValues"] as unknown[]).join(", ")}）`;
  }

  const at = e.instancePath || "(root)";
  return `${at} ${e.message ?? "invalid"}`;
}

/**
 * ajv エラー配列を「どのフィールドがダメか」の一覧に整形する。
 * 重複（同一フィールドに複数 keyword が当たる）は除去して読みやすくする。
 */
export function formatFieldErrors(errors: ErrorObject[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of errors) {
    const msg = describeError(e);
    if (seen.has(msg)) continue;
    seen.add(msg);
    out.push(msg);
  }
  return out;
}

/**
 * typeName のスキーマで payload を検証する（throw しない版）。
 * schemas.ts の ValidationResult をそのまま透過させつつ、message は
 * 「どのフィールドがダメか」を列挙した人間可読形に置き換える。
 * 失敗してもループを止めない設計（CLAUDE.md: partial-first / 局所スキップ）のため、
 * 呼び側はこの戻り値でスキップ判断できる。
 */
export function validateArtifact(typeName: ArtifactTypeName, payload: unknown): ValidationResult {
  const r = validateSchema(typeName, payload);
  if (r.valid) return r;
  const fields = formatFieldErrors(r.errors);
  const detail = fields.length > 0 ? fields.join("; ") : r.message;
  return {
    valid: false,
    errors: r.errors,
    message: `${typeName} 検証失敗: ${detail}`,
  };
}

/**
 * 検証失敗時に TypeError を投げる版（fail-fast したいフェーズ入口用）。
 * 成功時は検証済みの payload を typeName に対応する TS 型へ絞り込んで返す
 * （as 越しの実行時保証は ajv が担う。呼び側はこの戻り値を型安全に使える）。
 */
export function validateOrThrow<N extends ArtifactTypeName>(
  typeName: N,
  payload: unknown,
): TypeNameToPayload[N] {
  const r = validateArtifact(typeName, payload);
  if (!r.valid) throw new TypeError(r.message);
  return payload as TypeNameToPayload[N];
}
