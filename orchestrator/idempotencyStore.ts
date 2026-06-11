/**
 * 冪等スキップの実体（D10 マーカー × D9 partial 走査）。
 * 正本: docs/decisions.md「冪等キー（D10）」「状態モデル（D9）」／
 *   docs/architecture.md CB節「冪等キーhit は recordSkip（失敗に加算しない）」。
 *
 * 役割:
 * - runner が「同じ (phase + 親id集合 + model + prompt版 + worker + batch) の組はもう処理した」を
 *   ファイル状態DBなしで判定するための処理済みマーカー集合を提供する。
 * - キーは idempotency.ts の idempotencyKey を唯一の真実源として使う（hash の式を二重メンテしない）。
 * - 完了 partial の走査は resume.ts の scanCompleted に委譲する（ファイル読みは resume に集約）。
 *   本モジュールは「完了 partial → 冪等キー集合」への純寄りの変換と membership 判定だけを足す。
 *
 * ★重要（D10 の趣旨）:
 *   これは「処理済みマーカー」であって出力キャッシュではない。LLM は非決定なので、同一キーでも
 *   出力は毎回変わりうる。用途は二重実行回避（resume / 外部送信・publish の二重実行防止）のみ。
 *
 * ★error partial は「未完」:
 *   scanCompleted が status==="error" を未完として除外するため、失敗証跡はマーカーに入らない
 *   （= 次起動が再試行できる）。本ストアはその挙動をそのまま継承する。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { idempotencyKey, type IdempotencyInput } from "./idempotency.ts";
import { scanCompleted } from "./resume.ts";
import { partialsDir, partialName } from "./paths.ts";
import type { PhaseArtifact } from "./types.ts";

/**
 * PhaseArtifact（partial の中身）から冪等キーの入力を復元する。純関数。
 * provenance に derived_from（親id集合）/ agent（model）/ prompt_version が無い場合は、
 * idempotencyKey の入力契約に合わせて安全側のデフォルト（空集合 / "claude" / ""）で埋める。
 * これにより「古い partial に来歴が欠けている」場合でも決定論的にキーを作れる。
 */
export function inputFromArtifact(art: PhaseArtifact<unknown>): IdempotencyInput {
  const prov = art.provenance;
  const model: IdempotencyInput["model"] = prov.agent === "gemini" ? "gemini" : "claude";
  return {
    phase: art.phase,
    worker: art.worker,
    batch: art.batch,
    parentIds: prov.derived_from,
    promptVersion: prov.prompt_version ?? "",
    model,
  };
}

/**
 * 処理済みマーカー集合（D10）。1 フェーズぶんの「もう処理した冪等キー」を保持する。
 *
 * - loadFromRun(runDir, phase): 完了 partial（resume.scanCompleted）を走査し、各 partial から
 *   冪等キーを復元して集合に入れる。
 * - has(input): その input の冪等キーが集合にあるか（true=既処理＝局所スキップ）。
 * - markFromPartial(art): worker が今書いた partial を、再走査なしで in-memory に既処理として記録する。
 *
 * いずれも純寄り: ファイル読みは loadFromRun の内部（resume 委譲＋partial 本体読み）に閉じる。
 * has / markFromPartial / hasKey / size は I/O を伴わない純ロジック（テストが固めやすい）。
 */
export class IdempotencyStore {
  /** 処理済みの冪等キー（hex sha256）の集合。 */
  private readonly keys: Set<string>;

  /** 直接 new するときは空（テスト/段階構築用）。通常は loadFromRun を使う。 */
  constructor(keys?: Iterable<string>) {
    this.keys = new Set<string>(keys);
  }

  /**
   * run の完了 partial から処理済みマーカー集合を構築する（D9 glob 走査 → D10 キー化）。
   * - scanCompleted が返す {worker,batch}（status!=="error"）だけを対象にする。
   * - 各完了 item の partial 本体を読み、来歴から冪等キーを復元して集合へ。
   * - 同一 {worker,batch} に複数 partial（リトライの複数 ISO）がある場合は、scanCompleted が
   *   採用した id を持つ partial だけを読む（最後に書けた非 error が真／resume と同じ採用規則）。
   * - partial が読めない/壊れている item は黙ってスキップ（resume が既に未完判定するので整合）。
   */
  static loadFromRun(runDir: string, phase: string): IdempotencyStore {
    const store = new IdempotencyStore();
    const dir = partialsDir(runDir);
    for (const item of scanCompleted(runDir, phase)) {
      const art = readArtifact(dir, phase, item.worker, item.batch, item.id);
      if (art === null) continue;
      store.keys.add(idempotencyKey(inputFromArtifact(art)));
    }
    return store;
  }

  /** その input が既処理か（冪等キーhit）。true なら runner は局所スキップ（recordSkip 扱い）。 */
  has(input: IdempotencyInput): boolean {
    return this.keys.has(idempotencyKey(input));
  }

  /** 既に算出済みの冪等キー文字列で直接照会する（hash を再計算しない速路）。 */
  hasKey(key: string): boolean {
    return this.keys.has(key);
  }

  /**
   * partial（今書いた成果物）を既処理として記録する。再走査せず in-memory に足すだけ。
   * worker が1項目を確定した直後に runner が呼ぶ想定（同一 run 内の以降の二重実行を防ぐ）。
   * 戻り値は記録した冪等キー（呼び出し側が log/event に載せたいとき用）。
   */
  markFromPartial(art: PhaseArtifact<unknown>): string {
    const key = idempotencyKey(inputFromArtifact(art));
    this.keys.add(key);
    return key;
  }

  /** 冪等キーを直接マークする（input/partial を持たない経路用）。 */
  mark(input: IdempotencyInput): string {
    const key = idempotencyKey(input);
    this.keys.add(key);
    return key;
  }

  /** 保持しているマーカー件数（テスト/監査用）。 */
  get size(): number {
    return this.keys.size;
  }

  /** 保持中の冪等キーのスナップショット（順不同・複製）。 */
  snapshot(): string[] {
    return [...this.keys];
  }
}

/**
 * 完了 item に対応する partial 本体を読む。scanCompleted が採用した id に一致する partial を
 * 優先採用する。命名規約上 {phase,worker,batch} で複数 ISO がありうるため、id 照合で「真の1件」を選ぶ。
 * 読めない/壊れている場合は null（呼び出し側がスキップ）。
 */
function readArtifact(
  dir: string,
  phase: string,
  worker: number,
  batch: number,
  id: string,
): PhaseArtifact<unknown> | null {
  // scanCompleted は id を知っているが ISO（ファイル名）は返さない。ディレクトリを当該
  // {phase,worker,batch} で絞り、id 一致のものを採る。1件しか無ければそれを採る。
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = partialPrefix(phase, worker, batch);
  let fallback: PhaseArtifact<unknown> | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const art = parseArtifact(join(dir, name));
    if (art === null) continue;
    if (art.id === id) return art;
    // id 不一致でも非 error 候補は控える（id が空文字等で照合できない古い partial 救済）。
    if (fallback === null && art.status !== "error") fallback = art;
  }
  return fallback;
}

/**
 * `{phase}_PARTIAL_W{worker}B{batch}_` までの確定接頭辞（ISO 以降を残す）。
 * paths.ts の partialName（`{phase}_PARTIAL_W{w}B{b}_{ISO}.json`）と命名規約を共有し、
 * ISO を空にしたファイル名から末尾 ".json" を外して接頭辞にする（規約変更に追従させる）。
 */
function partialPrefix(phase: string, worker: number, batch: number): string {
  const withEmptyIso = partialName(phase, worker, batch, ""); // "..._.json"
  return withEmptyIso.replace(/\.json$/, "");
}

/** partial JSON を PhaseArtifact として読む。壊れていれば null。 */
function parseArtifact(path: string): PhaseArtifact<unknown> | null {
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isPhaseArtifact(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

/** 最低限の構造ガード（来歴の取り出しに必要なフィールドだけ確認）。 */
function isPhaseArtifact(obj: unknown): obj is PhaseArtifact<unknown> {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.phase !== "string") return false;
  if (typeof o.worker !== "number") return false;
  if (typeof o.batch !== "number") return false;
  const prov = o.provenance;
  if (typeof prov !== "object" || prov === null) return false;
  const p = prov as Record<string, unknown>;
  if (!Array.isArray(p.derived_from)) return false;
  return true;
}
