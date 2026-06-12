/**
 * aiHyperoptAdapter の純ロジックテスト（vitest）。
 * spawn（evaluate）は実プロセスなのでテスト対象外。
 * buildEvalPayload / parseEvalResult / serializeSubmission / writeSubmission と
 * アダプタの不変条件（paramKeys 5 個・initialCandidate・QuestAdapter 契約）を検証する。
 *
 * AI Quest は xqAdapter と「同じ抽象（QuestAdapter）」で実装されている＝フレームワーク汎用性の証明。
 * テスト構造も xqAdapter.test.ts と同形（純ロジックのみ vitest、spawn は対象外）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paramKeys,
  initialCandidate,
  buildEvalPayload,
  parseEvalResult,
  serializeSubmission,
  writeSubmission,
  aiHyperoptAdapter,
  SUBMISSION_FILENAME,
  type Candidate,
  type EvalPayload,
} from "../orchestrator/quest/aiHyperoptAdapter.ts";

describe("paramKeys / initialCandidate（不変条件）", () => {
  it("paramKeys はちょうど 5 個・重複なし", () => {
    expect(paramKeys).toHaveLength(5);
    expect(new Set(paramKeys).size).toBe(5);
  });

  it("initialCandidate は paramKeys と同じキー集合（過不足なし）", () => {
    expect(Object.keys(initialCandidate).sort()).toEqual([...paramKeys].sort());
  });

  it("initialCandidate の値は全て有限数", () => {
    for (const k of paramKeys) {
      const v = initialCandidate[k];
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("buildEvalPayload", () => {
  const full: Candidate = { ...initialCandidate };

  it("1 行 JSON（改行を含まない）で {params,seed} を返す", () => {
    const s = buildEvalPayload(full, { seed: 7 });
    expect(s.includes("\n")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.seed).toBe(7);
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("既定値: seed=0", () => {
    const p = JSON.parse(buildEvalPayload(full)) as EvalPayload;
    expect(p.seed).toBe(0);
  });

  it("seed は小数を切り捨て（決定性のため整数化）", () => {
    const p = JSON.parse(buildEvalPayload(full, { seed: 3.9 })) as EvalPayload;
    expect(p.seed).toBe(3); // trunc
  });

  it("paramKeys 外のキーは落とす（評価器に余計な値を渡さない）", () => {
    const dirty: Candidate = { ...full, bogus_key: 99, another: -1 };
    const p = JSON.parse(buildEvalPayload(dirty)) as EvalPayload;
    expect(p.params).not.toHaveProperty("bogus_key");
    expect(p.params).not.toHaveProperty("another");
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("非有限値（NaN/Inf）は載せない＝Python の _DEFAULT_PARAMS 補完に委ねる", () => {
    const bad: Candidate = { ...full, lr: NaN, hidden: Infinity };
    const s = buildEvalPayload(bad);
    // JSON に NaN/Infinity が混ざらない（Python 側 JSON.parse を壊さない）。
    expect(s.includes("NaN")).toBe(false);
    expect(s.includes("Infinity")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.params).not.toHaveProperty("lr");
    expect(p.params).not.toHaveProperty("hidden");
  });

  it("非有限値の扱いが serializeSubmission と対称（どちらも default へ寄せる）", () => {
    const bad: Candidate = { ...full, lr: NaN };
    const payload = JSON.parse(buildEvalPayload(bad)) as EvalPayload;
    expect(payload.params).not.toHaveProperty("lr"); // Python default に委譲

    const sub = JSON.parse(serializeSubmission(bad)) as Candidate;
    expect(sub["lr"]).toBe(initialCandidate.lr); // 既定で補完
  });

  it("欠けたキーは載せない（evaluate.py の _DEFAULT_PARAMS 補完に委ねる）", () => {
    const partial: Candidate = { hidden: 16 };
    const p = JSON.parse(buildEvalPayload(partial)) as EvalPayload;
    expect(p.params["hidden"]).toBe(16);
    expect(p.params).not.toHaveProperty("lr");
    expect(Object.keys(p.params)).toEqual(["hidden"]);
  });

  it("決定的: 同じ入力なら同じ文字列", () => {
    const a = buildEvalPayload(full, { seed: 1 });
    const b = buildEvalPayload(full, { seed: 1 });
    expect(a).toBe(b);
  });
});

describe("parseEvalResult", () => {
  it("正常な {score} を数値で返す", () => {
    expect(parseEvalResult('{"score": 0.42}')).toBe(0.42);
    expect(parseEvalResult('  {"score": 1.0, "train_acc": 0.9}\n')).toBe(1.0);
  });

  it("壊れた JSON は throw せず failFitness（既定 0）", () => {
    expect(parseEvalResult("not json")).toBe(0);
    expect(parseEvalResult("{ broken")).toBe(0);
  });

  it("空文字は failFitness", () => {
    expect(parseEvalResult("")).toBe(0);
    expect(parseEvalResult("   \n  ")).toBe(0);
  });

  it("score 欠如 / 非数値 / 非有限は failFitness", () => {
    expect(parseEvalResult("{}")).toBe(0);
    expect(parseEvalResult('{"score": "x"}')).toBe(0);
    expect(parseEvalResult('{"score": null}')).toBe(0);
    expect(parseEvalResult('{"val_acc": 0.9}')).toBe(0); // score キーが必須
  });

  it("配列やプリミティブ JSON は failFitness（オブジェクトのみ受理）", () => {
    expect(parseEvalResult("[1,2,3]")).toBe(0);
    expect(parseEvalResult("0.5")).toBe(0);
    expect(parseEvalResult("null")).toBe(0);
  });

  it("[0,1] にクランプ（汚染値ガード）", () => {
    expect(parseEvalResult('{"score": 1.5}')).toBe(1);
    expect(parseEvalResult('{"score": -0.3}')).toBe(0);
  });

  it("failFitness を明示指定できる", () => {
    expect(parseEvalResult("garbage", -1)).toBe(-1);
    expect(parseEvalResult("", -999)).toBe(-999);
  });

  it("負の failFitness は正常精度レンジ[0,1]の外＝失敗を本物の弱い候補と区別できる", () => {
    const failed = parseEvalResult("spawn-died", -1); // 失敗 → -1
    const realWeak = parseEvalResult('{"score": 0}'); // 本物の精度 0 → 0
    const realOk = parseEvalResult('{"score": 0.5}'); // 通常 → 0.5
    expect(failed).toBeLessThan(realWeak);
    expect(failed).toBeLessThan(realOk);
    expect(realWeak).toBe(0);
  });
});

describe("serializeSubmission", () => {
  it("paramKeys 順・5 キーの整形 JSON（末尾改行付き）", () => {
    const out = serializeSubmission({ ...initialCandidate });
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out) as Candidate;
    expect(Object.keys(parsed)).toEqual([...paramKeys]); // 順序まで一致
  });

  it("欠けキー/非有限は initialCandidate の既定値で補完", () => {
    const out = serializeSubmission({ lr: 0.5, reg: NaN });
    const parsed = JSON.parse(out) as Candidate;
    expect(parsed["lr"]).toBe(0.5); // 与えた値
    expect(parsed["reg"]).toBe(initialCandidate.reg); // NaN→既定
    expect(parsed["hidden"]).toBe(initialCandidate.hidden); // 欠け→既定
    expect(Object.keys(parsed)).toHaveLength(5);
  });

  it("決定的: 同じ best なら同じ文字列", () => {
    const best: Candidate = { ...initialCandidate, lr: 0.123 };
    expect(serializeSubmission(best)).toBe(serializeSubmission(best));
  });
});

describe("writeSubmission", () => {
  it("dir/best_params.json に提出物を書き、内容が serializeSubmission と一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-sub-"));
    try {
      const best: Candidate = { ...initialCandidate, hidden: 24 };
      const path = writeSubmission(best, dir);
      expect(path).toBe(join(dir, SUBMISSION_FILENAME));
      const content = readFileSync(path, "utf8");
      expect(content).toBe(serializeSubmission(best));
      const parsed = JSON.parse(content) as Candidate;
      expect(parsed["hidden"]).toBe(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aiHyperoptAdapter（QuestAdapter 契約）", () => {
  it("questId / mutateNumeric / paramKeys が想定どおり", () => {
    expect(aiHyperoptAdapter.questId).toBe("ai-hyperopt");
    expect(aiHyperoptAdapter.mutateNumeric).toBe(true);
    expect(aiHyperoptAdapter.paramKeys).toEqual([...paramKeys]);
  });

  it("initialCandidate() は initialCandidate のコピー（毎回新規・破壊されない）", () => {
    const a = aiHyperoptAdapter.initialCandidate();
    const b = aiHyperoptAdapter.initialCandidate();
    expect(a).toEqual({ ...initialCandidate });
    expect(a).not.toBe(b); // 別インスタンス
    a["lr"] = 999;
    expect(aiHyperoptAdapter.initialCandidate()["lr"]).toBe(initialCandidate.lr);
  });

  it("buildSubmission(best, dir) は dir に best_params.json を書く（同期・void）", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-adapter-"));
    try {
      const best: Candidate = { ...initialCandidate, init_scale: 0.33 };
      const ret = aiHyperoptAdapter.buildSubmission(best, dir);
      expect(ret).toBeUndefined(); // QuestAdapter.buildSubmission は void
      const parsed = JSON.parse(readFileSync(join(dir, SUBMISSION_FILENAME), "utf8")) as Candidate;
      expect(parsed["init_scale"]).toBe(0.33);
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
