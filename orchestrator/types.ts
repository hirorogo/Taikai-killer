/**
 * フェーズ間データ契約（TS型）。正は docs/architecture.md「主なデータ契約」。
 * JSON Schema 実体は schemas/*.schema.json（schemas.ts が検証）。
 */

// ───────── 共通 ─────────

/** 来歴(provenance)。全レコードが持ち、result から大会ルールまで遡れる（D17 と一体）。 */
export interface Provenance {
  produced_by: string; // 生成フェーズ "S3" / worker
  agent?: "claude" | "gemini"; // codex/ollama/copilot は将来拡張
  prompt_version?: string; // どの prompt 版で生成したか（D20）
  derived_from: string[]; // ★親レコードの id（上流を辿る）
  source_ref?: string; // 元ソース（URL / 論文 / ファイル / 人間入力）
  timestamp: string; // ISO8601（実行時に注入）
}

export type PhaseStatus = "ok" | "partial" | "error";

/** フェーズ間の共通エンベロープ。全 PARTIAL_*.json が従う。 */
export interface PhaseArtifact<T> {
  id: string; // このレコードの一意ID（derived_from で参照される。"S3:abc" のようにフェーズ prefix）
  phase: string; // "S2b" / "S3" / "S6"
  worker: number;
  batch: number;
  timestamp: string; // ISO8601
  schema_version: string;
  status: PhaseStatus;
  provenance: Provenance;
  payload: T;
}

// ───────── S1 要件定義 ─────────

export type TargetLanguage = "python" | "node" | "ts";

/** TOURNAMENT_INFO.json — S1 の最小入力（手書き可、URL任意）。 */
export interface TournamentInfo {
  name: string;
  language: TargetLanguage;
  run_cmd: string;
  test_cmd: string;
  test_source: "provided" | "generate" | "heldout";
  submission: { format: "zip" | "repo_url" | "web_url" | "pdf"; deadline?: string };
  eligibility?: string; // R1
  automation_allowed?: boolean; // R2/R3。false でも研究目的で続行可、提出は人間
  source_url?: string; // あれば S1 がクロール、無ければ手入力で成立
}

/** SCORING_RUBRIC.json — S1 が大会ルールから導出する評価指標。 */
export interface ScoringRubric {
  eval_mode: "test" | "battle"; // S6 の評価モード
  metrics: { name: string; weight: number; direction: "max" | "min" }[];
  forbidden: string[]; // 報酬ハック対策
  derived_from: string; // 由来した大会ルール（TOURNAMENT_INFO / 定義.json の id）
}

export interface Question {
  id: string;
  text: string;
  reason: string;
  answered?: string;
}
export interface Definition {
  term: string;
  meaning: string;
  edge_case?: string;
}
export interface Subject {
  theme: string;
  constraints: string[];
  rule_free?: boolean;
}

// ───────── S2 外部知見 ─────────

export interface SearchWord {
  word: string;
  lang: "ja" | "en";
  from: "rule" | "url" | "paper";
}
export interface CrawledUrl {
  url: string;
  title: string;
  kind: "web" | "paper" | "arxiv";
  saved_path: string;
  excluded?: "ad" | "nsfw" | null;
}

// ───────── S3 戦略 ─────────

export type StrategyOrigin =
  | "requirement"
  | "result"
  | "paper"
  | "subject"
  | "rival"
  | "human_idea";

export interface Strategy {
  id: string;
  origin: StrategyOrigin; // ★cold-start: 初回 run は requirement/paper/subject のみ
  approach: string;
  merged_from?: string[]; // 類似統合の履歴
}

// ───────── S5 コード生成（D22 Reflexion ループ） ─────────

/** D22 Reflexion ループの1 attempt。PhaseArtifact<CodeAttempt> payload。 */
export interface CodeAttempt {
  attempt: number;
  code_ref: string; // 生成コードの保存パス（本体は別ファイル＝slim）
  passed_anchor_ids: string[]; // これまで通過したテストID（回帰ガード対象）
  newly_passed_ids: string[]; // この修正で新規通過（空=進捗ゼロ→stall 判定）
  regressed: boolean; // 既通過を壊したか→true なら revert 済み
  reverted_to?: number;
  distance?: number; // graded distance（MVPは予約のみ）
}

/** S5 の最終結果（Reflexion 系列をプロバナンス化）。 */
export interface CodegenResult {
  strategy_id: string;
  passed: boolean;
  attempts: number;
  feedbackHistory: string[]; // 各試行の reflector フィードバック（why-retry の証跡）
  finalFeedback?: string;
}

// ───────── S6 ベンチマーク ─────────

export interface BenchResult {
  result_id: string; // 1 result = S1..S6 の1周
  strategy_id: string;
  rubric_ref: string; // どの ScoringRubric で測ったか
  eval_mode: "test" | "battle";
  score: number;
  rank: number;
  metrics: Record<string, number>;
  passed_test_ratio?: number; // ①テスト型の一次指標
  win_rate?: number; // ②対戦型の一次指標
  battle?: {
    opponents: string[];
    record: { wins: number; losses: number; draws: number };
    format: "round_robin" | "tournament";
  };
  distance?: number;
  diff_vs_prev?: number;
  threshold: { name: string; value: number }[];
  /**
   * 来歴（AC6）。result 単体から戦略→要件→ルールまで遡れるよう、この result を生んだ
   * 戦略 id を derived_from に載せる（戦略 partial の provenance がさらに rubric/要件へ繋がる）。
   * 後方互換のため optional（既存 result は provenance を持たなくても契約に適合）。
   */
  provenance?: Provenance;
}

/** outputs/leaderboard.json — run 横断の最強選抜（同一 rubric_ref で比較）。 */
export interface LeaderboardEntry {
  run_id: string;
  strategy_id: string;
  rubric_ref: string;
  score: number;
  passed_test_ratio: number;
  result_ref: string;
  ts: string;
}

// ───────── projects/{id}/manifest.json ─────────

export interface ProjectManifest {
  language: TargetLanguage;
  entrypoint: string;
  run_cmd: string;
  test_cmd: string;
  timeout_ms: number;
}
