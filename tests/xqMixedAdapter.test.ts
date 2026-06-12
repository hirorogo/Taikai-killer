/**
 * xqMixedAdapter（混合フィールド版）の純ロジックテスト（vitest）。
 * spawn（evaluateMixed）は実プロセスなのでテスト対象外。xqAdapter の純ロジック再利用と
 * アダプタ不変条件（強い既定の initialCandidate・提出名・QuestAdapter 契約）を検証する。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paramKeys } from "../orchestrator/quest/xqAdapter.ts";
import {
  initialCandidate,
  writeMixedSubmission,
  xqMixedAdapter,
  MIXED_SUBMISSION_FILENAME,
} from "../orchestrator/quest/xqMixedAdapter.ts";

describe("xqMixedAdapter 不変条件", () => {
  it("initialCandidate は paramKeys と同じ 8 キー・全て有限数", () => {
    expect(Object.keys(initialCandidate).sort()).toEqual([...paramKeys].sort());
    for (const k of paramKeys) {
      expect(Number.isFinite(initialCandidate[k])).toBe(true);
    }
  });

  it("initialCandidate は強い既定（弱い xqAdapter 既定でなく ai_param default 値）", () => {
    // 混合最適化は現状最強（heuristic 既定）から開始する＝w_blocking/w_suit_balance が強い値。
    expect(initialCandidate.w_blocking).toBe(1.5);
    expect(initialCandidate.w_suit_balance).toBe(2.5);
  });

  it("QuestAdapter 契約: questId / mutateNumeric / initialCandidate コピー", () => {
    expect(xqMixedAdapter.questId).toBe("xq-7narabe-mixed");
    expect(xqMixedAdapter.mutateNumeric).toBe(true);
    const a = xqMixedAdapter.initialCandidate();
    const b = xqMixedAdapter.initialCandidate();
    expect(a).not.toBe(b); // 毎回コピー（共有参照を返さない）
    expect(a).toEqual({ ...initialCandidate });
  });

  it("writeMixedSubmission は mixed_champion_params.json に 8 キー JSON を書く", () => {
    const dir = mkdtempSync(join(tmpdir(), "xqmixed-"));
    try {
      const path = writeMixedSubmission({ ...initialCandidate, w_edge_distance: 9 }, dir);
      expect(path).toBe(join(dir, MIXED_SUBMISSION_FILENAME));
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
      expect(parsed["w_edge_distance"]).toBe(9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
