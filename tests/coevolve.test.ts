/**
 * coevolve（自己対戦コオエボリューション）の純ロジック + 駆動テスト（vitest）。
 * spawn（evaluateCoevo）は実プロセスなのでテスト対象外。
 * coevolveXq は evalFn を注入して spawn を回避し、決定的に駆動を検証する。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paramKeys,
  initialChampion,
  buildCoevoPayload,
  parseCoevoResult,
  shouldPromote,
  capArchive,
  meanWinRate,
  summarizeTrajectory,
  serializeChampion,
  writeChampion,
  coevolveXq,
  CHAMPION_FILENAME,
  type Params,
  type CoevoPayload,
  type CoevoRound,
} from "../orchestrator/quest/coevolve.ts";

describe("paramKeys / initialChampion（不変条件）", () => {
  it("paramKeys はちょうど 8 個・重複なし", () => {
    expect(paramKeys).toHaveLength(8);
    expect(new Set(paramKeys).size).toBe(8);
  });

  it("initialChampion は paramKeys と同じキー集合（過不足なし）", () => {
    expect(Object.keys(initialChampion).sort()).toEqual([...paramKeys].sort());
  });

  it("initialChampion の値は全て有限数（ai_param.default_params と整合）", () => {
    for (const k of paramKeys) {
      const v = initialChampion[k];
      expect(typeof v).toBe("number");
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("buildCoevoPayload", () => {
  const champ: Params = { ...initialChampion };

  it("1 行 JSON（改行なし）で {challenger,opponent,games,seed} を返す", () => {
    const s = buildCoevoPayload(champ, champ, { games: 50, seed: 7 });
    expect(s.includes("\n")).toBe(false);
    const p = JSON.parse(s) as CoevoPayload;
    expect(p.games).toBe(50);
    expect(p.seed).toBe(7);
    expect(Object.keys(p.challenger).sort()).toEqual([...paramKeys].sort());
    expect(Object.keys(p.opponent).sort()).toEqual([...paramKeys].sort());
  });

  it("既定値: games=100 / seed=0", () => {
    const p = JSON.parse(buildCoevoPayload(champ, champ)) as CoevoPayload;
    expect(p.games).toBe(100);
    expect(p.seed).toBe(0);
  });

  it("games は 1 未満を 1 にクランプ、seed は切り捨て", () => {
    const p = JSON.parse(
      buildCoevoPayload(champ, champ, { games: 0, seed: 3.9 }),
    ) as CoevoPayload;
    expect(p.games).toBe(1);
    expect(p.seed).toBe(3);
  });

  it("paramKeys 外のキーは challenger/opponent 双方で落とす", () => {
    const dirty: Params = { ...champ, bogus: 9, junk: -1 };
    const p = JSON.parse(buildCoevoPayload(dirty, dirty)) as CoevoPayload;
    expect(p.challenger).not.toHaveProperty("bogus");
    expect(p.opponent).not.toHaveProperty("junk");
    expect(Object.keys(p.challenger).sort()).toEqual([...paramKeys].sort());
  });

  it("非有限値（NaN/Inf）は載せない＝Python の default_params 補完に委ねる", () => {
    const bad: Params = { ...champ, w_edge_distance: NaN, w_blocking: Infinity };
    const s = buildCoevoPayload(bad, bad);
    expect(s.includes("NaN")).toBe(false);
    expect(s.includes("Infinity")).toBe(false);
    const p = JSON.parse(s) as CoevoPayload;
    expect(p.challenger).not.toHaveProperty("w_edge_distance");
    expect(p.challenger).not.toHaveProperty("w_blocking");
    expect(p.opponent).not.toHaveProperty("w_edge_distance");
  });

  it("欠けキーは載せない（部分指定 OK・Python default 補完に委ねる）", () => {
    const partial: Params = { w_suit_balance: 3.0 };
    const p = JSON.parse(buildCoevoPayload(partial, partial)) as CoevoPayload;
    expect(p.challenger["w_suit_balance"]).toBe(3.0);
    expect(Object.keys(p.challenger)).toEqual(["w_suit_balance"]);
  });

  it("決定的: 同じ入力なら同じ文字列", () => {
    const a = buildCoevoPayload(champ, champ, { games: 10, seed: 1 });
    const b = buildCoevoPayload(champ, champ, { games: 10, seed: 1 });
    expect(a).toBe(b);
  });
});

describe("parseCoevoResult", () => {
  it("正常な {win_rate} を数値で返す", () => {
    expect(parseCoevoResult('{"win_rate": 0.42}')).toBe(0.42);
    expect(parseCoevoResult('  {"win_rate": 1.0}\n')).toBe(1.0);
  });

  it("壊れた JSON / 空文字は failFitness（既定 0）", () => {
    expect(parseCoevoResult("not json")).toBe(0);
    expect(parseCoevoResult("{ broken")).toBe(0);
    expect(parseCoevoResult("")).toBe(0);
    expect(parseCoevoResult("   \n ")).toBe(0);
  });

  it("win_rate 欠如 / 非数値 / 非オブジェクトは failFitness", () => {
    expect(parseCoevoResult("{}")).toBe(0);
    expect(parseCoevoResult('{"win_rate": "x"}')).toBe(0);
    expect(parseCoevoResult('{"win_rate": null}')).toBe(0);
    expect(parseCoevoResult("[1,2]")).toBe(0);
    expect(parseCoevoResult("0.5")).toBe(0);
  });

  it("[0,1] にクランプ（汚染値ガード）", () => {
    expect(parseCoevoResult('{"win_rate": 1.5}')).toBe(1);
    expect(parseCoevoResult('{"win_rate": -0.3}')).toBe(0);
  });

  it("failFitness を明示指定できる（負値で失敗を弱候補と区別）", () => {
    expect(parseCoevoResult("garbage", -1)).toBe(-1);
    const failed = parseCoevoResult("spawn-died", -1);
    const realWeak = parseCoevoResult('{"win_rate": 0}');
    expect(failed).toBeLessThan(realWeak);
  });
});

describe("shouldPromote", () => {
  it("0.5 + margin を厳密に上回るときだけ昇格", () => {
    expect(shouldPromote(0.55, 0.02)).toBe(true); // 0.55 > 0.52
    expect(shouldPromote(0.52, 0.02)).toBe(false); // 同値は不可（厳密超過）
    expect(shouldPromote(0.5, 0.02)).toBe(false); // 互角は防衛
    expect(shouldPromote(0.4, 0.02)).toBe(false); // 負け越しは不可
  });

  it("既定 margin は 0.02", () => {
    expect(shouldPromote(0.53)).toBe(true); // 0.53 > 0.52
    expect(shouldPromote(0.51)).toBe(false); // 0.51 < 0.52
  });

  it("margin=0 なら 0.5 超過で昇格", () => {
    expect(shouldPromote(0.5001, 0)).toBe(true);
    expect(shouldPromote(0.5, 0)).toBe(false);
  });

  it("負の margin は 0 にクランプ（閾値は最低 0.5 超過）", () => {
    expect(shouldPromote(0.5, -1)).toBe(false);
    expect(shouldPromote(0.5001, -1)).toBe(true);
  });

  it("margin>=0.5 はクランプされ閾値が 1 に張り付かない（昇格不能化を防ぐ）", () => {
    // margin=0.5 なら閾値 ~1.0 になり win_rate(<=1) では昇格不能。クランプで 0.5-eps に抑える。
    expect(shouldPromote(1.0, 0.5)).toBe(true);
  });

  it("非有限な winRate は false（評価失敗で誤昇格しない）", () => {
    expect(shouldPromote(NaN)).toBe(false);
    expect(shouldPromote(Infinity)).toBe(false);
  });
});

describe("summarizeTrajectory", () => {
  const mk = (round: number, wr: number, promoted: boolean): CoevoRound => ({
    round,
    challengerWinRate: wr,
    archiveWinRate: wr,
    promoted,
    champion: { ...initialChampion },
    archiveSize: 1,
  });

  it("昇格 round は archiveWinRate、非昇格 round は 0.5 を並べる", () => {
    const rounds = [mk(1, 0.6, true), mk(2, 0.48, false), mk(3, 0.7, true)];
    expect(summarizeTrajectory(rounds)).toEqual([0.6, 0.5, 0.7]);
  });

  it("空配列は空 trajectory", () => {
    expect(summarizeTrajectory([])).toEqual([]);
  });

  it("全防衛（昇格なし）は全て 0.5", () => {
    const rounds = [mk(1, 0.4, false), mk(2, 0.3, false)];
    expect(summarizeTrajectory(rounds)).toEqual([0.5, 0.5]);
  });
});

describe("capArchive（殿堂サイズ制御）", () => {
  const mkP = (v: number): Params => ({ ...initialChampion, w_suit_balance: v });

  it("size 以下なら全件保持（コピーで返す）", () => {
    const a = [mkP(1), mkP(2)];
    const out = capArchive(a, 4);
    expect(out).toHaveLength(2);
    expect(out[0]).not.toBe(a[0]); // shallow copy
    expect(out[0]).toEqual(a[0]);
  });

  it("size 超過は直近優先で末尾 size 件を残す（古いものを押し出す）", () => {
    const a = [mkP(1), mkP(2), mkP(3), mkP(4), mkP(5)];
    const out = capArchive(a, 3);
    expect(out.map((p) => p["w_suit_balance"])).toEqual([3, 4, 5]);
  });

  it("size<=0 は空配列（殿堂無効に縮退）", () => {
    expect(capArchive([mkP(1), mkP(2)], 0)).toEqual([]);
    expect(capArchive([mkP(1)], -3)).toEqual([]);
  });
});

describe("meanWinRate（殿堂平均勝率）", () => {
  it("通常の平均", () => {
    expect(meanWinRate([0.4, 0.6])).toBeCloseTo(0.5, 10);
    expect(meanWinRate([0.6, 0.7, 0.8])).toBeCloseTo(0.7, 10);
  });

  it("空配列は 0.5（中立）", () => {
    expect(meanWinRate([])).toBe(0.5);
  });

  it("非有限値は 0.5 に倒してから平均（NaN 伝播を断つ）", () => {
    expect(meanWinRate([1.0, NaN])).toBeCloseTo(0.75, 10);
    expect(meanWinRate([Infinity, 0.5])).toBeCloseTo(0.5, 10);
  });
});

describe("serializeChampion", () => {
  it("paramKeys 順・8 キーの整形 JSON（末尾改行付き）", () => {
    const out = serializeChampion({ ...initialChampion });
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out) as Params;
    expect(Object.keys(parsed)).toEqual([...paramKeys]);
  });

  it("欠けキー/非有限は initialChampion の既定値で補完", () => {
    const out = serializeChampion({ w_edge_distance: 9, w_blocking: NaN });
    const parsed = JSON.parse(out) as Params;
    expect(parsed["w_edge_distance"]).toBe(9);
    expect(parsed["w_blocking"]).toBe(initialChampion.w_blocking);
    expect(parsed["w_suit_balance"]).toBe(initialChampion.w_suit_balance);
    expect(Object.keys(parsed)).toHaveLength(8);
  });

  it("決定的: 同じ champion なら同じ文字列", () => {
    const c: Params = { ...initialChampion, w_edge_distance: 1.23 };
    expect(serializeChampion(c)).toBe(serializeChampion(c));
  });
});

describe("writeChampion", () => {
  it("dir/champion_params.json に提出物を書き、内容が serializeChampion と一致", () => {
    const dir = mkdtempSync(join(tmpdir(), "coevo-sub-"));
    try {
      const c: Params = { ...initialChampion, w_release_urgency: 0.9 };
      const path = writeChampion(c, dir);
      expect(path).toBe(join(dir, CHAMPION_FILENAME));
      const content = readFileSync(path, "utf8");
      expect(content).toBe(serializeChampion(c));
      const parsed = JSON.parse(content) as Params;
      expect(parsed["w_release_urgency"]).toBe(0.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ───────── coevolveXq 駆動（evalFn 注入で spawn 回避・決定的）─────────

describe("coevolveXq（evalFn 注入・決定的駆動）", () => {
  /**
   * 決定的ダミー評価器: challenger の w_suit_balance が champion より大きいほど勝率が高い、
   * という単調な代理目的（spawn 不要・seed 非依存で決定的）。0..1 にクランプ。
   * これにより populationGA が w_suit_balance を引き上げ、challenger が champion を上回り続ける
   * ＝毎 round 昇格して trajectory が立ち上がる、という性質をテストできる。
   */
  const monotoneEval = async (
    challenger: Params,
    champion: Params,
    _seed: number,
  ): Promise<number> => {
    const c = challenger["w_suit_balance"] ?? 0;
    const o = champion["w_suit_balance"] ?? 0;
    // sigmoid 的に 0.5 を中心に差で勝率を作る。差 0（自己対戦相当）で 0.5。
    const diff = c - o;
    return Math.min(1, Math.max(0, 0.5 + 0.2 * Math.tanh(diff)));
  };

  it("最良 challenger が champion を上回ると昇格し champion が更新される", async () => {
    const res = await coevolveXq({
      seed: 1,
      rounds: 3,
      popSize: 8,
      generations: 5,
      games: 10,
      evalFn: monotoneEval,
      writeSubmission: false,
    });
    expect(res.rounds).toHaveLength(3);
    // 単調代理目的なので少なくとも 1 度は昇格し、champion の w_suit_balance が初期より増える。
    const promotedAny = res.rounds.some((r) => r.promoted);
    expect(promotedAny).toBe(true);
    expect(res.champion["w_suit_balance"]!).toBeGreaterThan(
      initialChampion.w_suit_balance,
    );
  });

  it("seed 固定で完全再現（champion / rounds / trajectory が一致）", async () => {
    const opts = {
      seed: 42,
      rounds: 3,
      popSize: 6,
      generations: 4,
      games: 10,
      evalFn: monotoneEval,
      writeSubmission: false,
    } as const;
    const r1 = await coevolveXq(opts);
    const r2 = await coevolveXq(opts);
    expect(r1.champion).toEqual(r2.champion);
    expect(r1.trajectory).toEqual(r2.trajectory);
    expect(r1.rounds).toEqual(r2.rounds);
  });

  it("trajectory は rounds と同長で summarizeTrajectory と一致", async () => {
    const res = await coevolveXq({
      seed: 7,
      rounds: 4,
      popSize: 5,
      generations: 3,
      games: 10,
      evalFn: monotoneEval,
      writeSubmission: false,
    });
    expect(res.trajectory).toHaveLength(4);
    expect(res.trajectory).toEqual(summarizeTrajectory(res.rounds));
  });

  it("互角の評価器（常に 0.5）では昇格せず champion は初期値のまま", async () => {
    const drawEval = async (): Promise<number> => 0.5;
    const res = await coevolveXq({
      seed: 3,
      rounds: 3,
      popSize: 5,
      generations: 2,
      games: 10,
      evalFn: drawEval,
      writeSubmission: false,
    });
    expect(res.rounds.every((r) => !r.promoted)).toBe(true);
    expect(res.trajectory).toEqual([0.5, 0.5, 0.5]);
    expect(res.champion).toEqual({ ...initialChampion });
  });

  it("rounds/popSize/generations は最低値にクランプ（rounds>=1, popSize>=1）", async () => {
    const res = await coevolveXq({
      seed: 1,
      rounds: 0, // → 1
      popSize: 0, // → 1
      generations: -3, // → 0
      games: 0, // → 1
      evalFn: monotoneEval,
      writeSubmission: false,
    });
    expect(res.rounds).toHaveLength(1);
    expect(res.trajectory).toHaveLength(1);
  });

  it("writeSubmission:true で champion_params.json を submissionDir に書く", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coevo-run-"));
    try {
      const res = await coevolveXq({
        seed: 5,
        rounds: 2,
        popSize: 5,
        generations: 2,
        games: 10,
        evalFn: monotoneEval,
        submissionDir: dir,
        writeSubmission: true,
      });
      const path = join(dir, CHAMPION_FILENAME);
      expect(res.submissionPath).toBe(path);
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Params;
      expect(Object.keys(parsed)).toEqual([...paramKeys]);
      expect(parsed).toEqual(res.champion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promoteMargin を上げると昇格しにくくなる（防衛寄り）", async () => {
    // 差が出ても勝率は最大 0.7（0.5+0.2）。margin=0.25 なら閾値 0.75 で昇格不能。
    const base = {
      seed: 9,
      rounds: 3,
      popSize: 6,
      generations: 4,
      games: 10,
      evalFn: monotoneEval,
      writeSubmission: false,
    } as const;
    const easy = await coevolveXq({ ...base, promoteMargin: 0.0 });
    const hard = await coevolveXq({ ...base, promoteMargin: 0.25 });
    const easyPromotions = easy.rounds.filter((r) => r.promoted).length;
    const hardPromotions = hard.rounds.filter((r) => r.promoted).length;
    expect(hardPromotions).toBeLessThanOrEqual(easyPromotions);
    expect(hardPromotions).toBe(0); // 閾値 0.75 は到達不能
  });

  it("殿堂（archive）を result に公開し archiveSize で上限を保つ", async () => {
    const res = await coevolveXq({
      seed: 11,
      rounds: 5,
      popSize: 8,
      generations: 5,
      games: 10,
      evalFn: monotoneEval,
      archiveSize: 2,
      writeSubmission: false,
    });
    // 上限 2 を超えない・最低 1（初期 champion を起点に持つ）。
    expect(res.archive.length).toBeGreaterThanOrEqual(1);
    expect(res.archive.length).toBeLessThanOrEqual(2);
    // 各 round の archiveSize も上限内。
    expect(res.rounds.every((r) => r.archiveSize >= 1 && r.archiveSize <= 2)).toBe(true);
    // 昇格があれば殿堂の末尾（最新）は最終 champion と一致。
    if (res.rounds.some((r) => r.promoted)) {
      expect(res.archive[res.archive.length - 1]).toEqual(res.champion);
    }
  });

  it("archiveSize=0 は殿堂無効＝archiveWinRate が challengerWinRate と一致（旧挙動に縮退）", async () => {
    const res = await coevolveXq({
      seed: 11,
      rounds: 4,
      popSize: 6,
      generations: 4,
      games: 10,
      evalFn: monotoneEval,
      archiveSize: 0,
      writeSubmission: false,
    });
    expect(res.archive).toEqual([]);
    expect(res.rounds.every((r) => r.archiveWinRate === r.challengerWinRate)).toBe(true);
  });

  it("単調（推移的）評価では殿堂平均 >= 直近勝率（古い champion ほど弱い）", async () => {
    const res = await coevolveXq({
      seed: 13,
      rounds: 5,
      popSize: 8,
      generations: 5,
      games: 10,
      evalFn: monotoneEval,
      archiveSize: 4,
      writeSubmission: false,
    });
    for (const r of res.rounds) {
      if (r.promoted) {
        // 殿堂には過去の（より弱い）champion が混ざる → challenger は平均でより勝ち越す。
        expect(r.archiveWinRate).toBeGreaterThanOrEqual(r.challengerWinRate - 1e-9);
      }
    }
  });

  it("seed 固定で殿堂（archive）まで完全再現", async () => {
    const opts = {
      seed: 21,
      rounds: 4,
      popSize: 6,
      generations: 4,
      games: 10,
      evalFn: monotoneEval,
      archiveSize: 3,
      writeSubmission: false,
    } as const;
    const r1 = await coevolveXq(opts);
    const r2 = await coevolveXq(opts);
    expect(r1.archive).toEqual(r2.archive);
  });

  it("初期 champion を破壊しない（initialChampion は読み取り専用の意図を保つ）", async () => {
    const before = { ...initialChampion };
    await coevolveXq({
      seed: 1,
      rounds: 2,
      popSize: 4,
      generations: 2,
      games: 10,
      evalFn: monotoneEval,
      writeSubmission: false,
    });
    expect({ ...initialChampion }).toEqual(before);
  });
});
