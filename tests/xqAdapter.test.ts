/**
 * xqAdapter の純ロジックテスト（vitest）。
 * spawn（evaluate）は実プロセスなのでテスト対象外。
 * buildEvalPayload / parseEvalResult / serializeSubmission / writeSubmission と
 * アダプタの不変条件（paramKeys 8 個・initialCandidate・QuestAdapter 契約）を検証する。
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
  xqAdapter,
  SUBMISSION_FILENAME,
  type Candidate,
  type EvalPayload,
} from "../orchestrator/quest/xqAdapter.ts";

describe("paramKeys / initialCandidate（不変条件）", () => {
  it("paramKeys はちょうど 8 個・重複なし", () => {
    expect(paramKeys).toHaveLength(8);
    expect(new Set(paramKeys).size).toBe(8);
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

  it("1 行 JSON（改行を含まない）で {params,games,seed,opponents} を返す", () => {
    const s = buildEvalPayload(full, { games: 50, seed: 7, opponents: 2 });
    expect(s.includes("\n")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    expect(p.games).toBe(50);
    expect(p.seed).toBe(7);
    expect(p.opponents).toBe(2);
    expect(Object.keys(p.params).sort()).toEqual([...paramKeys].sort());
  });

  it("既定値: games=100 / seed=0 / opponents=2（本番 3 人戦 = 候補 1 + 相手 2）", () => {
    const p = JSON.parse(buildEvalPayload(full)) as EvalPayload;
    expect(p.games).toBe(100);
    expect(p.seed).toBe(0);
    // evaluate.py の _OPPONENTS_DEFAULT=2（players_num=opponents+1=3）と一致。
    expect(p.opponents).toBe(2);
  });

  it("games/opponents は 1 未満を 1 にクランプ、小数は切り捨て", () => {
    const p = JSON.parse(
      buildEvalPayload(full, { games: 0, opponents: -5, seed: 3.9 }),
    ) as EvalPayload;
    expect(p.games).toBe(1);
    expect(p.opponents).toBe(1);
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
    const bad: Candidate = { ...full, w_edge_distance: NaN, w_blocking: Infinity };
    const s = buildEvalPayload(bad);
    // JSON に NaN/Infinity が混ざらない（Python 側 JSON.parse を壊さない）。
    expect(s.includes("NaN")).toBe(false);
    expect(s.includes("Infinity")).toBe(false);
    const p = JSON.parse(s) as EvalPayload;
    // 非有限キーは payload に「載らない」（0 で送らない）＝Python default へフォールバック。
    expect(p.params).not.toHaveProperty("w_edge_distance");
    expect(p.params).not.toHaveProperty("w_blocking");
  });

  it("非有限値の扱いが serializeSubmission と対称（どちらも default へ寄せる）", () => {
    // 同じ非有限入力に対し、payload は「載せない（=Python default 補完）」、
    // submission は「initialCandidate 既定で補完」＝両者とも『既定へ寄せる』方針で一致。
    const bad: Candidate = { ...full, w_edge_distance: NaN };
    const payload = JSON.parse(buildEvalPayload(bad)) as EvalPayload;
    expect(payload.params).not.toHaveProperty("w_edge_distance"); // Python default に委譲

    const sub = JSON.parse(serializeSubmission(bad)) as Candidate;
    expect(sub["w_edge_distance"]).toBe(initialCandidate.w_edge_distance); // 既定で補完
    // どちらも「非有限を 0 で固定しない（既定へ寄せる）」点で非対称が解消されている。
  });

  it("欠けたキーは載せない（evaluate.py の default_params 補完に委ねる）", () => {
    const partial: Candidate = { w_edge_distance: 2.0 };
    const p = JSON.parse(buildEvalPayload(partial)) as EvalPayload;
    expect(p.params["w_edge_distance"]).toBe(2.0);
    expect(p.params).not.toHaveProperty("w_blocking");
    expect(Object.keys(p.params)).toEqual(["w_edge_distance"]);
  });

  it("決定的: 同じ入力なら同じ文字列", () => {
    const a = buildEvalPayload(full, { games: 10, seed: 1, opponents: 3 });
    const b = buildEvalPayload(full, { games: 10, seed: 1, opponents: 3 });
    expect(a).toBe(b);
  });
});

describe("parseEvalResult", () => {
  it("正常な {win_rate} を数値で返す", () => {
    expect(parseEvalResult('{"win_rate": 0.42}')).toBe(0.42);
    expect(parseEvalResult('  {"win_rate": 1.0}\n')).toBe(1.0);
  });

  it("壊れた JSON は throw せず failFitness（既定 0）", () => {
    expect(parseEvalResult("not json")).toBe(0);
    expect(parseEvalResult("{ broken")).toBe(0);
  });

  it("空文字は failFitness", () => {
    expect(parseEvalResult("")).toBe(0);
    expect(parseEvalResult("   \n  ")).toBe(0);
  });

  it("win_rate 欠如 / 非数値 / 非有限は failFitness", () => {
    expect(parseEvalResult("{}")).toBe(0);
    expect(parseEvalResult('{"win_rate": "x"}')).toBe(0);
    expect(parseEvalResult('{"win_rate": null}')).toBe(0);
    // NaN/Infinity は JSON では非合法だが、念のため数値経路の非有限も弾く。
    expect(parseEvalResult('{"other": 1}')).toBe(0);
  });

  it("配列やプリミティブ JSON は failFitness（オブジェクトのみ受理）", () => {
    expect(parseEvalResult("[1,2,3]")).toBe(0);
    expect(parseEvalResult("0.5")).toBe(0);
    expect(parseEvalResult("null")).toBe(0);
  });

  it("[0,1] にクランプ（汚染値ガード）", () => {
    expect(parseEvalResult('{"win_rate": 1.5}')).toBe(1);
    expect(parseEvalResult('{"win_rate": -0.3}')).toBe(0);
  });

  it("failFitness を明示指定できる", () => {
    expect(parseEvalResult("garbage", -1)).toBe(-1);
    expect(parseEvalResult("", -999)).toBe(-999);
  });

  it("負の failFitness は正常勝率レンジ[0,1]の外＝失敗を本物の弱い候補と区別できる", () => {
    // low 指摘⑤: failFitness=0 は『勝率 0 の本物の弱候補』と衝突する。負値にすると
    // 正常勝率は必ず [0,1] にクランプされる（>=0）ので、失敗(<0)が常に劣後し、
    // 初期点評価が失敗しても以降の候補が一律「改善」扱いされる歪みを避けられる。
    const failed = parseEvalResult("spawn-died", -1); // 失敗 → -1
    const realWeak = parseEvalResult('{"win_rate": 0}'); // 本物の勝率 0 → 0
    const realOk = parseEvalResult('{"win_rate": 0.3}'); // 通常 → 0.3
    expect(failed).toBeLessThan(realWeak); // 失敗 < 本物の弱候補
    expect(failed).toBeLessThan(realOk);
    expect(realWeak).toBe(0); // クランプ下限。失敗(-1)とは別の値。
  });
});

describe("serializeSubmission", () => {
  it("paramKeys 順・8 キーの整形 JSON（末尾改行付き）", () => {
    const out = serializeSubmission({ ...initialCandidate });
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out) as Candidate;
    expect(Object.keys(parsed)).toEqual([...paramKeys]); // 順序まで一致
  });

  it("欠けキー/非有限は initialCandidate の既定値で補完", () => {
    const out = serializeSubmission({ w_edge_distance: 9, w_blocking: NaN });
    const parsed = JSON.parse(out) as Candidate;
    expect(parsed["w_edge_distance"]).toBe(9); // 与えた値
    expect(parsed["w_blocking"]).toBe(initialCandidate.w_blocking); // NaN→既定
    expect(parsed["w_suit_balance"]).toBe(initialCandidate.w_suit_balance); // 欠け→既定
    // 8 キー全て揃う
    expect(Object.keys(parsed)).toHaveLength(8);
  });

  it("決定的: 同じ best なら同じ文字列", () => {
    const best: Candidate = { ...initialCandidate, w_edge_distance: 1.23 };
    expect(serializeSubmission(best)).toBe(serializeSubmission(best));
  });
});

describe("writeSubmission", () => {
  it("dir/best_params.json に提出物を書き、内容が serializeSubmission と一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "xq-sub-"));
    try {
      const best: Candidate = { ...initialCandidate, w_release_urgency: 0.9 };
      const path = writeSubmission(best, dir);
      expect(path).toBe(join(dir, SUBMISSION_FILENAME));
      const content = readFileSync(path, "utf8");
      expect(content).toBe(serializeSubmission(best));
      const parsed = JSON.parse(content) as Candidate;
      expect(parsed["w_release_urgency"]).toBe(0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("xqAdapter（QuestAdapter 契約）", () => {
  it("questId / mutateNumeric / paramKeys が想定どおり", () => {
    expect(xqAdapter.questId).toBe("xq-7narabe");
    expect(xqAdapter.mutateNumeric).toBe(true);
    expect(xqAdapter.paramKeys).toEqual([...paramKeys]);
  });

  it("initialCandidate() は initialCandidate のコピー（毎回新規・破壊されない）", () => {
    const a = xqAdapter.initialCandidate();
    const b = xqAdapter.initialCandidate();
    expect(a).toEqual({ ...initialCandidate });
    expect(a).not.toBe(b); // 別インスタンス
    a["w_edge_distance"] = 999;
    expect(xqAdapter.initialCandidate()["w_edge_distance"]).toBe(initialCandidate.w_edge_distance);
  });

  it("buildSubmission(best, dir) は dir に best_params.json を書く（同期・void）", () => {
    const dir = mkdtempSync(join(tmpdir(), "xq-adapter-"));
    try {
      const best: Candidate = { ...initialCandidate, w_suit_balance: 0.77 };
      const ret = xqAdapter.buildSubmission(best, dir);
      expect(ret).toBeUndefined(); // QuestAdapter.buildSubmission は void
      const parsed = JSON.parse(readFileSync(join(dir, SUBMISSION_FILENAME), "utf8")) as Candidate;
      expect(parsed["w_suit_balance"]).toBe(0.77);
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
