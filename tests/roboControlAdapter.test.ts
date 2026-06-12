/**
 * roboControlAdapter の純ロジックテスト（vitest）。
 * spawn（evaluate）は実プロセスなのでテスト対象外。
 * buildEvalPayload / parseEvalResult / serializeSubmission / writeSubmission と
 * アダプタの不変条件（paramKeys 5 個・initialCandidate・QuestAdapter 契約）を検証する。
 *
 * これは「標準ハーネスの汎用性証明 2」: xqAdapter（対戦ゲーム）と同形の純ロジック契約を
 * 全く違う毛色のロボ制御（自己完結シミュ）でも満たすことを vitest で固める。
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
  roboControlAdapter,
  SUBMISSION_FILENAME,
  type Candidate,
  type EvalPayload,
} from "../orchestrator/quest/roboControlAdapter.ts";

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

  it("1 行 JSON（改行を含まない）で {params,episodes,seed} を返す", () => {
    const s = buildEvalPayload(full, { episodes: 50, seed: 7 });
    expect(s.includes("\n")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.episodes).toBe(50);
    expect(p.seed).toBe(7);
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("既定値: episodes=100 / seed=0", () => {
    const p = JSON.parse(buildEvalPayload(full)) as EvalPayload;
    expect(p.episodes).toBe(100);
    expect(p.seed).toBe(0);
  });

  it("episodes は 1 未満を 1 にクランプ、小数は切り捨て、seed は trunc", () => {
    const p = JSON.parse(buildEvalPayload(full, { episodes: 0, seed: 3.9 })) as EvalPayload;
    expect(p.episodes).toBe(1);
    expect(p.seed).toBe(3); // trunc
  });

  it("paramKeys 外のキーは落とす（評価器に余計な値を渡さない）", () => {
    const dirty: Candidate = { ...full, bogus_key: 99, another: -1 };
    const p = JSON.parse(buildEvalPayload(dirty)) as EvalPayload;
    expect(p.params).not.toHaveProperty("bogus_key");
    expect(p.params).not.toHaveProperty("another");
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("非有限値（NaN/Inf）は載せない＝Python の default_params 補完に委ねる（serializeSubmission と対称）", () => {
    const bad: Candidate = { ...full, kp_lin: NaN, kp_ang: Infinity };
    const s = buildEvalPayload(bad);
    // JSON に NaN/Infinity が混ざらない（Python 側 JSON.parse を壊さない）。
    expect(s.includes("NaN")).toBe(false);
    expect(s.includes("Infinity")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.params).not.toHaveProperty("kp_lin");
    expect(p.params).not.toHaveProperty("kp_ang");
  });

  it("非有限値の扱いが serializeSubmission と対称（どちらも default へ寄せる）", () => {
    const bad: Candidate = { ...full, kp_lin: NaN };
    const payload = JSON.parse(buildEvalPayload(bad)) as EvalPayload;
    expect(payload.params).not.toHaveProperty("kp_lin"); // Python default に委譲

    const sub = JSON.parse(serializeSubmission(bad)) as Candidate;
    expect(sub["kp_lin"]).toBe(initialCandidate.kp_lin); // 既定で補完
  });

  it("欠けたキーは載せない（evaluate.py の default_params 補完に委ねる）", () => {
    const partial: Candidate = { kp_lin: 1.2 };
    const p = JSON.parse(buildEvalPayload(partial)) as EvalPayload;
    expect(p.params["kp_lin"]).toBe(1.2);
    expect(p.params).not.toHaveProperty("kp_ang");
    expect(Object.keys(p.params)).toEqual(["kp_lin"]);
  });

  it("決定的: 同じ入力なら同じ文字列", () => {
    const a = buildEvalPayload(full, { episodes: 10, seed: 1 });
    const b = buildEvalPayload(full, { episodes: 10, seed: 1 });
    expect(a).toBe(b);
  });
});

describe("parseEvalResult", () => {
  it("正常な {score} を数値で返す", () => {
    expect(parseEvalResult('{"score": 0.42}')).toBe(0.42);
    expect(parseEvalResult('  {"score": 0.9}\n')).toBe(0.9);
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
    expect(parseEvalResult('{"other": 1}')).toBe(0);
  });

  it("配列やプリミティブ JSON は failFitness（オブジェクトのみ受理）", () => {
    expect(parseEvalResult("[1,2,3]")).toBe(0);
    expect(parseEvalResult("0.5")).toBe(0);
    expect(parseEvalResult("null")).toBe(0);
  });

  it("下限 0 にクランプ（負の汚染値ガード）。報酬は到達で 1 付近なので上限は設けない", () => {
    expect(parseEvalResult('{"score": -0.3}')).toBe(0);
    expect(parseEvalResult('{"score": 1.0}')).toBe(1.0); // 上限クランプなし
  });

  it("failFitness を明示指定できる", () => {
    expect(parseEvalResult("garbage", -1)).toBe(-1);
    expect(parseEvalResult("", -999)).toBe(-999);
  });

  it("負の failFitness は正常報酬レンジ(>=0)の外＝失敗を本物の弱い候補と区別できる", () => {
    const failed = parseEvalResult("spawn-died", -1); // 失敗 → -1
    const realWeak = parseEvalResult('{"score": 0}'); // 本物の報酬 0（壊れた方策）→ 0
    const realOk = parseEvalResult('{"score": 0.3}');
    expect(failed).toBeLessThan(realWeak); // 失敗 < 本物の弱候補
    expect(failed).toBeLessThan(realOk);
    expect(realWeak).toBe(0); // クランプ下限。失敗(-1)とは別の値。
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
    const out = serializeSubmission({ kp_lin: 9, kp_ang: NaN });
    const parsed = JSON.parse(out) as Candidate;
    expect(parsed["kp_lin"]).toBe(9); // 与えた値
    expect(parsed["kp_ang"]).toBe(initialCandidate.kp_ang); // NaN→既定
    expect(parsed["align_thresh"]).toBe(initialCandidate.align_thresh); // 欠け→既定
    expect(Object.keys(parsed)).toHaveLength(5);
  });

  it("決定的: 同じ best なら同じ文字列", () => {
    const best: Candidate = { ...initialCandidate, kp_lin: 1.23 };
    expect(serializeSubmission(best)).toBe(serializeSubmission(best));
  });
});

describe("writeSubmission", () => {
  it("dir/best_params.json に提出物を書き、内容が serializeSubmission と一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "robo-sub-"));
    try {
      const best: Candidate = { ...initialCandidate, v_cruise: 0.9 };
      const path = writeSubmission(best, dir);
      expect(path).toBe(join(dir, SUBMISSION_FILENAME));
      const content = readFileSync(path, "utf8");
      expect(content).toBe(serializeSubmission(best));
      const parsed = JSON.parse(content) as Candidate;
      expect(parsed["v_cruise"]).toBe(0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("roboControlAdapter（QuestAdapter 契約）", () => {
  it("questId / mutateNumeric / paramKeys が想定どおり", () => {
    expect(roboControlAdapter.questId).toBe("robo-control");
    expect(roboControlAdapter.mutateNumeric).toBe(true);
    expect(roboControlAdapter.paramKeys).toEqual([...paramKeys]);
  });

  it("initialCandidate() は initialCandidate のコピー（毎回新規・破壊されない）", () => {
    const a = roboControlAdapter.initialCandidate();
    const b = roboControlAdapter.initialCandidate();
    expect(a).toEqual({ ...initialCandidate });
    expect(a).not.toBe(b); // 別インスタンス
    a["kp_lin"] = 999;
    expect(roboControlAdapter.initialCandidate()["kp_lin"]).toBe(initialCandidate.kp_lin);
  });

  it("buildSubmission(best, dir) は dir に best_params.json を書く（同期・void）", () => {
    const dir = mkdtempSync(join(tmpdir(), "robo-adapter-"));
    try {
      const best: Candidate = { ...initialCandidate, align_thresh: 0.77 };
      const ret = roboControlAdapter.buildSubmission(best, dir);
      expect(ret).toBeUndefined(); // QuestAdapter.buildSubmission は void
      const parsed = JSON.parse(readFileSync(join(dir, SUBMISSION_FILENAME), "utf8")) as Candidate;
      expect(parsed["align_thresh"]).toBe(0.77);
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
