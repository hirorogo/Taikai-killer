import { describe, it, expect } from "vitest";
import {
  mapConcurrent,
  mapConcurrentSettled,
} from "../orchestrator/quest/parallelEval.ts";
import type { SettledResult } from "../orchestrator/quest/parallelEval.ts";

/**
 * 外部から解決できる遅延 Promise（deferred）。
 * setTimeout / Date.now に依存せず、テストが完了タイミングを手で制御するために使う
 * （並行度の検証は「時間」でなく「同時実行カウンタ」で行う＝決定的）。
 */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** マイクロタスクを数回流して、保留中のプール進行を確定させる（時間に依存しない）。 */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("mapConcurrent", () => {
  it("順序保持: 完了順がバラバラでも結果は入力順に並ぶ", async () => {
    // 後ろの要素ほど先に resolve させても、出力は入力順であることを確認。
    const gates = [0, 1, 2, 3, 4].map(() => deferred<number>());
    const p = mapConcurrent(
      [0, 1, 2, 3, 4],
      (i) => gates[i]!.promise,
      5,
    );
    // 逆順に解決（4→3→2→1→0）。それぞれ値は index*10。
    for (let i = 4; i >= 0; i--) gates[i]!.resolve(i * 10);
    const res = await p;
    expect(res).toEqual([0, 10, 20, 30, 40]);
  });

  it("index がコールバックに渡る（map のシグネチャ）", async () => {
    const res = await mapConcurrent(
      ["a", "b", "c"],
      async (item, index) => `${item}${index}`,
      2,
    );
    expect(res).toEqual(["a0", "b1", "c2"]);
  });

  it("concurrency 上限が守られる（同時実行数をカウンタで計測）", async () => {
    const concurrency = 3;
    const total = 10;
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: total }, () => deferred<number>());

    const p = mapConcurrent(
      Array.from({ length: total }, (_, i) => i),
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const v = await gates[i]!.promise;
        active--;
        return v;
      },
      concurrency,
    );

    // 立ち上がりでプールが満杯になるまでマイクロタスクを流す。
    await flush();
    // 開始時点で同時実行は concurrency を超えない。
    expect(active).toBe(concurrency);
    expect(maxActive).toBe(concurrency);

    // 1 つずつ解決しては流す。常に上限を超えないことを確認。
    for (let i = 0; i < total; i++) {
      gates[i]!.resolve(i);
      await flush();
      expect(active).toBeLessThanOrEqual(concurrency);
      expect(maxActive).toBe(concurrency);
    }

    const res = await p;
    expect(res).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(maxActive).toBe(concurrency);
    expect(active).toBe(0);
  });

  it("concurrency=1 は直列（同時実行は常に 1）", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const res = await mapConcurrent(
      [0, 1, 2, 3],
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(i);
        await Promise.resolve();
        active--;
        return i * 2;
      },
      1,
    );
    expect(maxActive).toBe(1);
    expect(order).toEqual([0, 1, 2, 3]); // 直列なので入力順に着手
    expect(res).toEqual([0, 2, 4, 6]);
  });

  it("concurrency が要素数より大きくても要素数で頭打ち（過剰ワーカーを作らない）", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [0, 1].map(() => deferred<number>());
    const p = mapConcurrent(
      [0, 1],
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const v = await gates[i]!.promise;
        active--;
        return v;
      },
      100, // 要素数 2 より大きい
    );
    await flush();
    expect(maxActive).toBe(2); // items.length で頭打ち
    gates[0]!.resolve(0);
    gates[1]!.resolve(1);
    expect(await p).toEqual([0, 1]);
  });

  it("concurrency<=1 / 小数 / 非有限は 1 に正規化される（プールが前進する）", async () => {
    const run = (c: number): Promise<number[]> =>
      mapConcurrent([1, 2, 3], async (x) => x, c);
    expect(await run(0)).toEqual([1, 2, 3]);
    expect(await run(-5)).toEqual([1, 2, 3]);
    expect(await run(2.7)).toEqual([1, 2, 3]); // trunc→2 でも結果は同じ
    expect(await run(Number.NaN)).toEqual([1, 2, 3]);
    expect(await run(Number.POSITIVE_INFINITY)).toEqual([1, 2, 3]);
  });

  it("空配列は空配列を返す（fn を一度も呼ばない）", async () => {
    let called = 0;
    const res = await mapConcurrent(
      [] as number[],
      async (x) => {
        called++;
        return x;
      },
      4,
    );
    expect(res).toEqual([]);
    expect(called).toBe(0);
  });

  it("1 要素が失敗すると最初の理由で reject する", async () => {
    const err = new Error("boom");
    await expect(
      mapConcurrent(
        [0, 1, 2],
        async (i) => {
          if (i === 1) throw err;
          return i;
        },
        3,
      ),
    ).rejects.toBe(err);
  });

  it("失敗時、新規 index の取得は止まる（進行中は止められない）", async () => {
    // concurrency=1 なので失敗後の要素には着手しない＝処理済みは [0] のみ。
    const seen: number[] = [];
    await expect(
      mapConcurrent(
        [0, 1, 2, 3],
        async (i) => {
          seen.push(i);
          if (i === 0) throw new Error("stop");
          return i;
        },
        1,
      ),
    ).rejects.toThrow("stop");
    // 失敗した 0 には着手したが、後続 1/2/3 の新規取得は止まる。
    expect(seen).toEqual([0]);
  });
});

describe("mapConcurrentSettled", () => {
  it("失敗要素があっても他を止めず全要素を処理する（順序保持）", async () => {
    const err = new Error("bad-1");
    const res = await mapConcurrentSettled(
      [0, 1, 2, 3],
      async (i) => {
        if (i === 1) throw err;
        return i * 10;
      },
      2,
    );
    const expected: SettledResult<number>[] = [
      { index: 0, status: "fulfilled", value: 0 },
      { index: 1, status: "rejected", reason: err },
      { index: 2, status: "fulfilled", value: 20 },
      { index: 3, status: "fulfilled", value: 30 },
    ];
    expect(res).toEqual(expected);
  });

  it("失敗候補を低 fitness に畳める（GA での使い方）", async () => {
    const settled = await mapConcurrentSettled(
      [0, 1, 2],
      async (i) => {
        if (i === 1) throw new Error("spawn failed");
        return 0.7 + i;
      },
      3,
    );
    const fitness = settled.map((r) => (r.status === "fulfilled" ? r.value : 0));
    expect(fitness).toEqual([0.7, 0, 2.7]);
  });

  it("concurrency 上限が守られる（settled 版・カウンタで計測）", async () => {
    const concurrency = 2;
    const total = 6;
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: total }, () => deferred<number>());

    const p = mapConcurrentSettled(
      Array.from({ length: total }, (_, i) => i),
      async (i) => {
        active++;
        maxActive = Math.max(maxActive, active);
        const v = await gates[i]!.promise;
        active--;
        if (i === 3) throw new Error("x"); // 失敗も含めて上限を保つ
        return v;
      },
      concurrency,
    );

    await flush();
    expect(active).toBe(concurrency);

    for (let i = 0; i < total; i++) {
      gates[i]!.resolve(i);
      await flush();
      expect(active).toBeLessThanOrEqual(concurrency);
    }

    const res = await p;
    expect(maxActive).toBe(concurrency);
    expect(active).toBe(0);
    expect(res).toHaveLength(total);
    expect(res[3]!.status).toBe("rejected");
    expect(res[0]!.status).toBe("fulfilled");
  });

  it("空配列は空配列（fn を呼ばない）", async () => {
    let called = 0;
    const res = await mapConcurrentSettled(
      [] as number[],
      async (x) => {
        called++;
        return x;
      },
      4,
    );
    expect(res).toEqual([]);
    expect(called).toBe(0);
  });

  it("全要素失敗でも全件 rejected で返る（順序保持・throw しない）", async () => {
    const res = await mapConcurrentSettled(
      [0, 1, 2],
      async (i) => {
        throw new Error(`e${i}`);
      },
      2,
    );
    expect(res.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    expect(res.map((r) => r.index)).toEqual([0, 1, 2]);
  });
});
