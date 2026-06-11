/**
 * append-only イベントログ（D9）。
 * 正本: docs/decisions.md「partial = resume の唯一の真実源、append-only イベントログは
 * 観測/再現用の write-only（resume には使わない）」／docs/execution-premise.md「全操作を監査可能に」。
 *
 * 方針:
 * - outputs/{run}/events/pipeline.jsonl に **1イベント=1行 JSON** を純追記（append-only）。
 * - resume には絶対に使わない。読み戻しは監査用 readEvents(runDir) のみ。
 * - イベント型は paths.ts の eventsDir に書く。schemas/*Event.schema.json と対応
 *   （PipelineStarted / PhaseStarted / PhaseCompleted / PhaseFailed /
 *    CircuitBreakerTripped / BudgetExceeded）。
 * - 数値しきい値は config.ts の CB を流用（5/20/3）。型は types.ts の語彙に合わせる。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventsDir } from "./paths.ts";
import { CB } from "./config.ts";
import type { PhaseStatus } from "./types.ts";

/** events ログのファイル名（append-only / D9）。 */
const PIPELINE_LOG = "pipeline.jsonl";

/** イベント種別（schemas/*Event.schema.json と1:1）。 */
export type EventType =
  | "PipelineStarted"
  | "PhaseStarted"
  | "PhaseCompleted"
  | "PhaseFailed"
  | "CircuitBreakerTripped"
  | "BudgetExceeded";

/** Circuit Breaker のトリップ理由（CB 閾値に対応）。 */
export type CircuitBreakerReason =
  | "consecutive_failures"
  | "total_retries"
  | "consecutive_empty_results";

/** 全イベント共通フィールド（type と最小メタ）。 */
interface BaseEvent {
  type: EventType;
  ts: string; // ISO8601（appendEvent で自動注入）
}

export interface PipelineStartedEvent extends BaseEvent {
  type: "PipelineStarted";
  run_id: string;
}

export interface PhaseStartedEvent extends BaseEvent {
  type: "PhaseStarted";
  phase: string; // "S1" / "S3" / "S5" …
  worker?: number;
  batch?: number;
}

export interface PhaseCompletedEvent extends BaseEvent {
  type: "PhaseCompleted";
  phase: string;
  status: PhaseStatus; // types.ts: "ok" | "partial" | "error"
  worker?: number;
  batch?: number;
}

export interface PhaseFailedEvent extends BaseEvent {
  type: "PhaseFailed";
  phase: string;
  error: string; // E_CODE_TEST / E_LLM_COMM 等の分類コードか短い理由
  worker?: number;
  batch?: number;
}

export interface CircuitBreakerTrippedEvent extends BaseEvent {
  type: "CircuitBreakerTripped";
  reason: CircuitBreakerReason;
  count: number; // トリップ時の実カウント
  threshold: number; // 超過した閾値（CB の対応値）
}

export interface BudgetExceededEvent extends BaseEvent {
  type: "BudgetExceeded";
  budget_usd: number; // 設定された上限（指定時のみ発火 / D5）
  spent_usd: number; // 実消費
}

/** pipeline.jsonl に流れる全イベントの判別共用体。 */
export type PipelineEvent =
  | PipelineStartedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | PhaseFailedEvent
  | CircuitBreakerTrippedEvent
  | BudgetExceededEvent;

/** 分配的 Omit（union の各メンバごとに ts を外す。素の Omit だと共通キーへ潰れる）。 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** ts を除いた入力（appendEvent が ts を注入する）。 */
export type EventInput = DistributiveOmit<PipelineEvent, "ts">;

const isoNow = (): string => new Date().toISOString();

/** events/pipeline.jsonl の絶対パス。 */
export function pipelineLogPath(runDir: string): string {
  return join(eventsDir(runDir), PIPELINE_LOG);
}

/**
 * イベントを1行 JSON で純追記（append-only / D9）。
 * - ts は呼び出し時刻を自動注入（呼び出し側は type と最小フィールドだけ渡す）。
 * - events/ が無ければ作る（runner 側 ensureDirs 前でも単独で成立させる）。
 * - 監査ログなので best-effort では「ない」: 書けないなら throw して気づかせる
 *   （無言で握りつぶすと監査の意味が無い）。
 */
export function appendEvent(runDir: string, event: EventInput): PipelineEvent {
  const dir = eventsDir(runDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full = { ...event, ts: isoNow() } as PipelineEvent;
  appendFileSync(pipelineLogPath(runDir), JSON.stringify(full) + "\n", "utf8");
  return full;
}

/**
 * 監査用の読み戻し（resume には使わない / D9）。
 * - ログが無ければ空配列。
 * - 壊れた行（部分書き込み等）はスキップして読めるものだけ返す（監査の頑健性）。
 */
export function readEvents(runDir: string): PipelineEvent[] {
  const path = pipelineLogPath(runDir);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: PipelineEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as PipelineEvent);
    } catch {
      // 末尾の部分行・改ざん行は監査では無視して読み進める
    }
  }
  return out;
}

// ───────── 型付き薄ヘルパ（呼び出し側の type 取り違えを防ぐ）─────────

export function pipelineStarted(runDir: string, runId: string): PipelineEvent {
  return appendEvent(runDir, { type: "PipelineStarted", run_id: runId });
}

/** worker/batch は undefined を載せない（exactOptionalPropertyTypes 対応）。 */
function withMeta<T extends object>(
  base: T,
  meta?: { worker?: number; batch?: number },
): T & { worker?: number; batch?: number } {
  const out: T & { worker?: number; batch?: number } = { ...base };
  if (meta?.worker !== undefined) out.worker = meta.worker;
  if (meta?.batch !== undefined) out.batch = meta.batch;
  return out;
}

export function phaseStarted(
  runDir: string,
  phase: string,
  meta?: { worker?: number; batch?: number },
): PipelineEvent {
  return appendEvent(runDir, withMeta({ type: "PhaseStarted" as const, phase }, meta));
}

export function phaseCompleted(
  runDir: string,
  phase: string,
  status: PhaseStatus,
  meta?: { worker?: number; batch?: number },
): PipelineEvent {
  return appendEvent(runDir, withMeta({ type: "PhaseCompleted" as const, phase, status }, meta));
}

export function phaseFailed(
  runDir: string,
  phase: string,
  error: string,
  meta?: { worker?: number; batch?: number },
): PipelineEvent {
  return appendEvent(runDir, withMeta({ type: "PhaseFailed" as const, phase, error }, meta));
}

/**
 * CB トリップを記録。reason から CB 閾値（config.ts）を自動解決。
 * count は実カウント、threshold は超過した CB 値（5/20/3）。
 */
export function circuitBreakerTripped(
  runDir: string,
  reason: CircuitBreakerReason,
  count: number,
): PipelineEvent {
  const threshold =
    reason === "consecutive_failures"
      ? CB.consecutiveFailures
      : reason === "total_retries"
        ? CB.totalRetries
        : CB.consecutiveEmptyResults;
  return appendEvent(runDir, { type: "CircuitBreakerTripped", reason, count, threshold });
}

export function budgetExceeded(
  runDir: string,
  budgetUsd: number,
  spentUsd: number,
): PipelineEvent {
  return appendEvent(runDir, {
    type: "BudgetExceeded",
    budget_usd: budgetUsd,
    spent_usd: spentUsd,
  });
}
