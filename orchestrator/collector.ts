/**
 * S3 戦略の統廃合（Collector / dedup）。
 * 正本: docs/architecture.md「Collector<br/>統廃合/dedup」（W1..Wn の PARTIAL を統合）、
 *       docs/README「被り・類似戦略を統合」、orchestrator/types.ts Strategy.merged_from。
 *
 * 方針（譲れない条件）:
 * - **LLM を一切呼ばない純ロジック**。複数ワーカーが出した Strategy[] を、approach の
 *   近似重複でまとめ、代表 1 件に統合する純関数（外部プロセス/ネット/時刻に非依存）。
 * - **決定的**: 入力順で安定。最初に現れた戦略を代表（canonical）とし、後続の類似を
 *   そこへ畳み込む。Date.now / Math.random / Set 反復順への依存なし。
 * - **来歴を残す**: 統合した戦略の id を代表の merged_from に積む（types.ts Strategy.merged_from /
 *   architecture「類似統合の履歴（統合元の戦略 id）」）。代表自身の id は merged_from に入れない。
 * - **非重複は保持**: 似ていない戦略はそのまま（merged_from は付けない＝触らない）。
 *
 * 類似度（簡易）:
 * - approach を正規化（小文字化・前後trim・連続空白を1つに圧縮）して完全一致なら重複。
 * - そうでなければ正規化トークン集合の Jaccard 係数が閾値以上なら重複（既定 0.85）。
 */

import type { Strategy } from "./types.ts";

/** dedup の閾値・挙動を調整するオプション（全て任意）。 */
export interface DedupOptions {
  /** Jaccard トークン類似度の採用閾値（>= で重複扱い）。既定 0.85。 */
  threshold?: number;
}

/** 既定の Jaccard 閾値（README/仕様）。 */
export const DEFAULT_THRESHOLD = 0.85;

/**
 * approach の正規化: 小文字化 → 前後 trim → 連続空白(改行/タブ含む)を半角スペース1つに圧縮。
 * 近似重複判定（完全一致・トークン化）の共通前処理。
 */
export function normalizeApproach(approach: string): string {
  return approach.toLowerCase().trim().replace(/\s+/g, " ");
}

/** 正規化文字列を空白でトークン化（空要素は落とす）。 */
function tokenize(normalized: string): Set<string> {
  const out = new Set<string>();
  if (normalized.length === 0) return out;
  for (const t of normalized.split(" ")) {
    if (t.length > 0) out.add(t);
  }
  return out;
}

/**
 * 2 トークン集合の Jaccard 係数 = |A∩B| / |A∪B|。
 * 両方空なら 1（完全一致扱い）、片方だけ空なら 0。
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  // 小さい方を回す（決定性には影響しないが無駄を減らす）。
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) {
    if (large.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** 代表（canonical）に紐づく内部状態。 */
interface Cluster {
  /** 代表 Strategy（入力順で最初に現れたもの）。 */
  rep: Strategy;
  /** 代表の正規化 approach。 */
  norm: string;
  /** 代表の正規化トークン集合（Jaccard 用にキャッシュ）。 */
  tokens: Set<string>;
  /** 統合された統合元 id（代表以外）。入力順で append。 */
  merged: string[];
  /** merged 重複登録を防ぐ既出 id 集合。 */
  mergedSeen: Set<string>;
}

/**
 * 戦略の近似重複を統合し、代表 Strategy[] を返す純関数。
 *
 * アルゴリズム（決定的・入力順安定）:
 * 1. 入力を順に走査。各戦略について既存クラスタの代表と比較。
 * 2. 正規化 approach が完全一致、または Jaccard >= threshold の最初のクラスタに畳み込む。
 *    - 代表の merged_from に「畳み込まれた戦略の id」を追加（代表 id 自身は入れない）。
 *    - 畳み込まれた戦略が元々持っていた merged_from も引き継ぐ（履歴を失わない）。
 * 3. どのクラスタにも合致しなければ新しいクラスタの代表になる。
 * 4. 出力はクラスタ生成順（＝代表が初出した入力順）。各代表の merged_from は
 *    1 件以上統合があった時だけ設定（非重複の代表には付けない＝元のまま）。
 *
 * - 入力配列・要素は破壊しない（代表はシャローコピーして返す）。
 * - threshold は [0,1] 想定。範囲外でも比較は素直に動く（>= 比較のみ）。
 *
 * @param strategies 各ワーカーが出した戦略（順序が安定の基準）。
 * @param options    threshold（既定 0.85）。
 */
export function dedupStrategies(strategies: Strategy[], options?: DedupOptions): Strategy[] {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  const clusters: Cluster[] = [];

  for (const s of strategies) {
    const norm = normalizeApproach(s.approach);
    const tokens = tokenize(norm);

    let target: Cluster | undefined;
    for (const c of clusters) {
      // 完全一致（正規化後）→ 即重複。空文字どうしもここで一致扱い。
      const exact = c.norm === norm;
      const sim = exact ? 1 : jaccard(c.tokens, tokens);
      if (exact || sim >= threshold) {
        target = c;
        break;
      }
    }

    if (target === undefined) {
      // 新しい代表。元の merged_from は後で確定時に反映する。
      clusters.push({
        rep: s,
        norm,
        tokens,
        merged: [],
        mergedSeen: new Set<string>(),
      });
      continue;
    }

    // 既存代表へ畳み込む。畳み込まれた戦略の id を統合元として記録。
    addMerged(target, s.id, target.rep.id);
    // 畳み込まれた戦略が持っていた履歴も引き継ぐ（代表 id は除外）。
    if (s.merged_from !== undefined) {
      for (const mid of s.merged_from) {
        addMerged(target, mid, target.rep.id);
      }
    }
  }

  return clusters.map((c) => finalizeCluster(c));
}

/** merged に id を追加（代表自身 / 既出は無視）。決定的に入力順を保つ。 */
function addMerged(c: Cluster, id: string, repId: string): void {
  if (id === repId) return;
  if (c.mergedSeen.has(id)) return;
  c.mergedSeen.add(id);
  c.merged.push(id);
}

/**
 * クラスタを出力 Strategy に確定。
 * - 統合が 1 件以上あれば merged_from を設定（代表が元々持っていた履歴も先頭に温存）。
 * - 統合が 0 件なら代表をそのまま返す（merged_from は元のまま／無ければ無し）。
 * - exactOptionalPropertyTypes 対応で merged_from は値があるときだけ載せる。
 */
function finalizeCluster(c: Cluster): Strategy {
  const prior = c.rep.merged_from ?? [];
  // 代表が元々持っていた履歴 ＋ 今回統合した id（重複排除・順序安定）。
  const combined: string[] = [];
  const seen = new Set<string>();
  for (const id of prior) {
    if (id === c.rep.id || seen.has(id)) continue;
    seen.add(id);
    combined.push(id);
  }
  for (const id of c.merged) {
    if (seen.has(id)) continue;
    seen.add(id);
    combined.push(id);
  }

  // 代表のシャローコピー（入力を破壊しない）。
  const base: Strategy = {
    id: c.rep.id,
    origin: c.rep.origin,
    approach: c.rep.approach,
  };
  if (combined.length > 0) {
    base.merged_from = combined;
  }
  return base;
}
