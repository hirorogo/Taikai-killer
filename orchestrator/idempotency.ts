/**
 * 冪等キー（D10 / docs/decisions.md・directory-structure.md）。
 *
 * 「処理済みマーカー」であって **出力キャッシュではない**。
 * sha256(phase + worker + batch + sorted(parentIds) + promptVersion + model) で作る。
 *
 * ★重要: LLM は非決定なので、同一キーでも出力は毎回変わりうる。
 *   よってこのキーを「前回の出力を再利用する（出力キャッシュ）」用途に使ってはならない。
 *   用途は「この (phase,worker,batch,親集合,prompt版,model) の組はもう処理した」を表す
 *   処理済みマーカーのみ（resume での二重実行回避・外部送信/publish の二重実行防止 D10）。
 *
 * ★除外する入力（意図的）:
 *   - prompt 全文: 静的プロンプト規約（CLAUDE.md）下では prompt_version で十分。全文を焼くと
 *     チェーンが重くなり、かつ「マーカー」が「キャッシュキー」に化ける。
 *   - timestamp: 同一処理を別時刻に再実行しても同一キーである必要がある（resume の要）。
 */
import { createHash } from "node:crypto";

/** 冪等キーの入力（D10）。timestamp / prompt 全文は **含めない**。 */
export interface IdempotencyInput {
  phase: string; // "S5" 等
  worker: number;
  batch: number;
  parentIds: readonly string[]; // 親レコードの id 集合（derived_from）。順不同で同一視するため内部で sort
  promptVersion: string; // どの prompt 版か（Provenance.prompt_version / D20）
  model: "claude" | "gemini";
}

/** フィールド区切り（値内に現れにくい制御文字）。衝突回避のため空文字や空白は使わない。 */
const FIELD_SEP = ""; // US (unit separator)
/** parentIds 内の要素区切り。 */
const ELEM_SEP = ""; // RS (record separator)

/**
 * 冪等キー（hex sha256）を生成する。
 * parentIds は **ソートして** 連結するため、親集合の並び順に依存しない（集合として扱う）。
 */
export function idempotencyKey(input: IdempotencyInput): string {
  const sortedParents = [...input.parentIds].sort();
  const canonical = [
    input.phase,
    String(input.worker),
    String(input.batch),
    sortedParents.join(ELEM_SEP),
    input.promptVersion,
    input.model,
  ].join(FIELD_SEP);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
