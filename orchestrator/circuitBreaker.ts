/**
 * Circuit Breaker（D11 / steal A-2 / SWE-Squad recordSkip）。
 * フェーズ共有の暴走停止判定。3カウンタのいずれかがしきい値に達したら tripped()=true。
 * このクラスは exit しない。exit 65 する側（runner）が tripped()/reason() を材料に判断する。
 *
 * しきい値は config.ts の CB（consecutiveFailures=5 / totalRetries=20 / consecutiveEmptyResults=3）を import。
 *
 * recordSkip は一切カウンタを触らない（death-spiral 回避）。
 * E_RATELIMIT・冪等hit・親partial欠落スキップ・best-so-far打ち切りは「失敗」ではないため、
 * 失敗率を偽膨張させて誤トリップさせない（流用: SWE-Squad / architecture.md CB節）。
 */
import { CB } from "./config.ts";

/** recordSkip の理由（失敗にカウントしないスキップ種別）。 */
export type SkipReason =
  | "ratelimit" // E_RATELIMIT: 待機→復活→resume であって失敗ではない
  | "idempotent_hit" // 冪等キー hit: 処理済みマーカーに当たった
  | "missing_parent" // 親 partial 欠落の局所スキップ
  | "attempts_exhausted"; // best-so-far 打ち切り

/** tripped 時の原因コード（reason() が返す）。 */
export type TripReason =
  | "consecutive_failures"
  | "total_retries"
  | "consecutive_empty_results";

export class CircuitBreaker {
  /** 連続失敗数（成功 or 空出力でリセット）。 */
  private consecutiveFailures = 0;
  /** 総リトライ数（失敗の累積。リセットしない単調増加）。 */
  private totalRetries = 0;
  /** 連続空出力数（非空の成功/失敗でリセット）。 */
  private consecutiveEmptyResults = 0;

  /**
   * 通常の実行結果を記録。
   * ok=true: 連続失敗・連続空出力をリセット。
   * ok=false: 連続失敗 +1、総リトライ +1、連続空出力はリセット（空ではない失敗のため）。
   */
  recordResult(ok: boolean): void {
    if (ok) {
      this.consecutiveFailures = 0;
      this.consecutiveEmptyResults = 0;
      return;
    }
    this.consecutiveFailures += 1;
    this.totalRetries += 1;
    // 「非空だが失敗」なので空連続はリセット（空判定は recordEmpty が担当）。
    this.consecutiveEmptyResults = 0;
  }

  /**
   * 空出力（returncode 0 でも実質空／E_LLM_COMM）を記録。
   * 連続空出力 +1、総リトライ +1、連続失敗 +1（空も失敗の一種として扱う）。
   * 流用: SWE-Squad「exit 0 を盲信しない」（integrations-issue1.md）。
   */
  recordEmpty(): void {
    this.consecutiveEmptyResults += 1;
    this.consecutiveFailures += 1;
    this.totalRetries += 1;
  }

  /**
   * 失敗にカウントしないスキップを記録。
   * 一切カウンタを触らない（death-spiral 回避）。reason は監査/ログ用に受けるだけ。
   */
  recordSkip(_reason: SkipReason): void {
    // 意図的に no-op。スキップは失敗率に加算しない（architecture.md CB節）。
    void _reason;
  }

  /** いずれかのしきい値に達していれば true（exit 65 する側の判断材料）。 */
  tripped(): boolean {
    return this.reason() !== null;
  }

  /** トリップ原因（最初に達したものを優先）。未トリップなら null。 */
  reason(): TripReason | null {
    if (this.consecutiveFailures >= CB.consecutiveFailures) {
      return "consecutive_failures";
    }
    if (this.totalRetries >= CB.totalRetries) {
      return "total_retries";
    }
    if (this.consecutiveEmptyResults >= CB.consecutiveEmptyResults) {
      return "consecutive_empty_results";
    }
    return null;
  }
}
