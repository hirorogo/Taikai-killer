/**
 * dataInsightAdapter の純ロジックテスト（vitest）。
 * spawn（evaluate）は実プロセスなのでテスト対象外。
 * buildEvalPayload / parseEvalResult / serializeSubmission / writeSubmission と
 * アダプタの不変条件（paramKeys 12 個・initialCandidate・QuestAdapter 契約）を検証する。
 *
 * Data Quest は xqAdapter / aiHyperoptAdapter と「同じ抽象（QuestAdapter）」で実装されている
 * ＝フレームワーク汎用性の証明 3。テスト構造も aiHyperoptAdapter.test.ts と同形
 * （純ロジックのみ vitest、spawn は対象外）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paramKeys,
  N_FEATURES,
  initialCandidate,
  buildEvalPayload,
  parseEvalResult,
  serializeSubmission,
  writeSubmission,
  dataInsightAdapter,
  SUBMISSION_FILENAME,
  type Candidate,
  type EvalPayload,
} from "../orchestrator/quest/dataInsightAdapter.ts";

describe("paramKeys / initialCandidate（不変条件）", () => {
  it("paramKeys はちょうど 12 個（sel_0..sel_9 + sel_threshold + ridge）・重複なし", () => {
    expect(paramKeys).toHaveLength(N_FEATURES + 2);
    expect(paramKeys).toHaveLength(12);
    expect(new Set(paramKeys).size).toBe(12);
  });

  it("sel_0..sel_9 を昇順で含み、末尾に sel_threshold・ridge が並ぶ（evaluate.py PARAM_KEYS と同順）", () => {
    const expectedSel = Array.from({ length: N_FEATURES }, (_, i) => `sel_${i}`);
    expect(paramKeys.slice(0, N_FEATURES)).toEqual(expectedSel);
    expect(paramKeys[N_FEATURES]).toBe("sel_threshold");
    expect(paramKeys[N_FEATURES + 1]).toBe("ridge");
  });

  it("initialCandidate は paramKeys と同じキー集合（過不足なし）", () => {
    expect(Object.keys(initialCandidate).sort()).toEqual([...paramKeys].sort());
  });

  it("initialCandidate の値は全て有限数（sel は全採用 1.0・閾値 0.0・ridge 0.1）", () => {
    for (const k of paramKeys) {
      const v = initialCandidate[k];
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(initialCandidate.sel_0).toBe(1.0);
    expect(initialCandidate.sel_threshold).toBe(0.0);
    expect(initialCandidate.ridge).toBe(0.1);
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
    const dirty: Candidate = { ...full, bogus_key: 99, sel_99: -1 };
    const p = JSON.parse(buildEvalPayload(dirty)) as EvalPayload;
    expect(p.params).not.toHaveProperty("bogus_key");
    expect(p.params).not.toHaveProperty("sel_99");
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("非有限値（NaN/Inf）は載せない＝Python の _DEFAULT_PARAMS 補完に委ねる", () => {
    const bad: Candidate = { ...full, sel_0: NaN, ridge: Infinity };
    const s = buildEvalPayload(bad);
    // JSON に NaN/Infinity が混ざらない（Python 側 JSON.parse を壊さない）。
    expect(s.includes("NaN")).toBe(false);
    expect(s.includes("Infinity")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.params).not.toHaveProperty("sel_0");
    expect(p.params).not.toHaveProperty("ridge");
  });

  it("非有限値の扱いが serializeSubmission と対称（どちらも default へ寄せる）", () => {
    const bad: Candidate = { ...full, sel_2: NaN };
    const payload = JSON.parse(buildEvalPayload(bad)) as EvalPayload;
    expect(payload.params).not.toHaveProperty("sel_2"); // Python default に委譲

    const sub = JSON.parse(serializeSubmission(bad)) as Candidate;
    expect(sub["sel_2"]).toBe(initialCandidate.sel_2); // 既定で補完
  });

  it("欠けたキーは載せない（evaluate.py の _DEFAULT_PARAMS 補完に委ねる）", () => {
    const partial: Candidate = { sel_threshold: 0.5, ridge: 1.0 };
    const p = JSON.parse(buildEvalPayload(partial)) as EvalPayload;
    expect(p.params["sel_threshold"]).toBe(0.5);
    expect(p.params["ridge"]).toBe(1.0);
    expect(p.params).not.toHaveProperty("sel_0");
    expect(Object.keys(p.params).sort()).toEqual(["ridge", "sel_threshold"]);
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
    expect(parseEvalResult('  {"score": 0.9, "r2_train": 0.95, "selected": [0,2]}\n')).toBe(0.9);
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
    expect(parseEvalResult('{"r2_val": 0.9}')).toBe(0); // score キーが必須
  });

  it("配列やプリミティブ JSON は failFitness（オブジェクトのみ受理）", () => {
    expect(parseEvalResult("[1,2,3]")).toBe(0);
    expect(parseEvalResult("0.5")).toBe(0);
    expect(parseEvalResult("null")).toBe(0);
  });

  it("[0,1] にクランプ（R^2 上限 1・負 R^2 の汚染値ガード）", () => {
    expect(parseEvalResult('{"score": 1.5}')).toBe(1);
    expect(parseEvalResult('{"score": -0.3}')).toBe(0); // 負 R^2 → 0 に底上げ
  });

  it("failFitness を明示指定できる", () => {
    expect(parseEvalResult("garbage", -1)).toBe(-1);
    expect(parseEvalResult("", -999)).toBe(-999);
  });

  it("負の failFitness は正常 R^2 レンジ[0,1]の外＝失敗を本物の弱い候補と区別できる", () => {
    const failed = parseEvalResult("spawn-died", -1); // 失敗 → -1
    const realWeak = parseEvalResult('{"score": -0.2}'); // 本物の負 R^2 → 0 に底上げ
    const realOk = parseEvalResult('{"score": 0.5}'); // 通常 → 0.5
    expect(failed).toBeLessThan(realWeak);
    expect(failed).toBeLessThan(realOk);
    expect(realWeak).toBe(0);
  });
});

describe("serializeSubmission", () => {
  it("paramKeys 順・12 キーの整形 JSON（末尾改行付き）", () => {
    const out = serializeSubmission({ ...initialCandidate });
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out) as Candidate;
    expect(Object.keys(parsed)).toEqual([...paramKeys]); // 順序まで一致
  });

  it("欠けキー/非有限は initialCandidate の既定値で補完", () => {
    const out = serializeSubmission({ sel_0: 2.0, sel_1: NaN });
    const parsed = JSON.parse(out) as Candidate;
    expect(parsed["sel_0"]).toBe(2.0); // 与えた値
    expect(parsed["sel_1"]).toBe(initialCandidate.sel_1); // NaN→既定
    expect(parsed["sel_5"]).toBe(initialCandidate.sel_5); // 欠け→既定
    expect(parsed["ridge"]).toBe(initialCandidate.ridge);
    expect(Object.keys(parsed)).toHaveLength(12);
  });

  it("決定的: 同じ best なら同じ文字列", () => {
    const best: Candidate = { ...initialCandidate, sel_3: 0.123, ridge: 2.5 };
    expect(serializeSubmission(best)).toBe(serializeSubmission(best));
  });
});

describe("writeSubmission", () => {
  it("dir/best_params.json に提出物を書き、内容が serializeSubmission と一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-sub-"));
    try {
      const best: Candidate = { ...initialCandidate, sel_7: 3.0, sel_threshold: 0.5 };
      const path = writeSubmission(best, dir);
      expect(path).toBe(join(dir, SUBMISSION_FILENAME));
      const content = readFileSync(path, "utf8");
      expect(content).toBe(serializeSubmission(best));
      const parsed = JSON.parse(content) as Candidate;
      expect(parsed["sel_7"]).toBe(3.0);
      expect(parsed["sel_threshold"]).toBe(0.5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dataInsightAdapter（QuestAdapter 契約）", () => {
  it("questId / mutateNumeric / paramKeys が想定どおり", () => {
    expect(dataInsightAdapter.questId).toBe("data-insight");
    expect(dataInsightAdapter.mutateNumeric).toBe(true);
    expect(dataInsightAdapter.paramKeys).toEqual([...paramKeys]);
  });

  it("initialCandidate() は initialCandidate のコピー（毎回新規・破壊されない）", () => {
    const a = dataInsightAdapter.initialCandidate();
    const b = dataInsightAdapter.initialCandidate();
    expect(a).toEqual({ ...initialCandidate });
    expect(a).not.toBe(b); // 別インスタンス
    a["sel_0"] = 999;
    expect(dataInsightAdapter.initialCandidate()["sel_0"]).toBe(initialCandidate.sel_0);
  });

  it("buildSubmission(best, dir) は dir に best_params.json を書く（同期・void）", () => {
    const dir = mkdtempSync(join(tmpdir(), "data-adapter-"));
    try {
      const best: Candidate = { ...initialCandidate, ridge: 0.33 };
      const ret = dataInsightAdapter.buildSubmission(best, dir);
      expect(ret).toBeUndefined(); // QuestAdapter.buildSubmission は void
      const parsed = JSON.parse(readFileSync(join(dir, SUBMISSION_FILENAME), "utf8")) as Candidate;
      expect(parsed["ridge"]).toBe(0.33);
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
