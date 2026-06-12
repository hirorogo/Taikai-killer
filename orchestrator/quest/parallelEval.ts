/**
 * parallelEval: quest 評価の並列化のための純ロジック（並行プール mapConcurrent）。
 * 正本: docs/decisions.md「進化（D18）」/ orchestrator/quest/populationGA.ts・runQuest.ts。
 *
 * 位置づけ:
 * - populationGA / runQuest は「世代の候補群」をそれぞれ evaluate で採点する。
 *   各 evaluate は xqAdapter のように **Python サイドカーを spawn する独立プロセス**で、
 *   I/O 待ちが支配的＝直列だと候補数ぶん待つ。これを並行化すると壁時計時間が大きく縮む。
 * - 本モジュールは「並行プール」を純ロジックで提供する。最適化器（GA / ヒルクライム）から
 *   独立した道具で、共有 .ts を **読むだけ**・配線は別途（呼び出し側が evaluate を渡す）。
 *
 * 譲れない条件（CLAUDE.md / populationGA.ts を継承）:
 * - **LLM を呼ばない純ロジック**。渡された fn のみを呼ぶ。
 * - **決定的な結果順序**: 結果配列は **入力順**（完了順ではない）。並行実行しても
 *   items[i] の結果は必ず out[i] に入る（GA の sortByFitness 等が順序非依存に保たれる）。
 * - **Date.now / setTimeout に依存しない**。並行度の上限はプール構造そのもので保証する
 *   （時間待ちでなくワーカー数で律速）。テストはカウンタで同時実行数を測れる。
 * - **1 つ失敗しても他を止めない**（Promise.allSettled 的）。失敗は throw でなく結果に反映する
 *   形（SettledResult）も提供し、CLAUDE.md「単一ワーカーの失敗でループを止めない」を守る。
 */

/** map 関数。要素 T を受け R を非同期に返す（evaluate 等）。 */
export type MapFn<T, R> = (item: T, index: number) => Promise<R>;

/**
 * settle 版の結果（Promise.allSettled と同形だが index を保持し決定的に辿れる）。
 * status:"fulfilled" のとき value、"rejected" のとき reason を持つ判別共用体。
 */
export type SettledResult<R> =
  | { index: number; status: "fulfilled"; value: R }
  | { index: number; status: "rejected"; reason: unknown };

/**
 * concurrency を 1 以上の整数に正規化する（決定的・時間非依存）。
 * 0 以下・小数・NaN/Inf は 1 に丸める（プールが必ず前進するよう最低 1 ワーカーを保証）。
 * 上限は items.length（ワーカーが要素数を超えても無意味なので切り詰める）。
 */
function normalizeConcurrency(concurrency: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  if (!Number.isFinite(concurrency)) return 1;
  const c = Math.trunc(concurrency);
  if (c < 1) return 1;
  return Math.min(c, itemCount);
}

/**
 * items を fn で並行に map する（並行度 concurrency の固定サイズプール）。順序保持・決定的。
 *
 * 仕組み:
 * - 共有カーソル（next）から各ワーカーが次の未処理 index を取り、自分のスロットに結果を書く。
 *   同時に走るワーカーは最大 concurrency 個＝同時実行数の上限がプール構造で保証される
 *   （setTimeout 等の時間待ちに依存しない＝テストはカウンタで上限を検証できる）。
 * - 結果は out[index] に書くので **入力順**（完了順ではない）。並行でも決定的順序。
 *
 * 失敗の扱い: いずれかの fn が reject すると **最初の reject 理由で全体が reject** する
 * （Promise.all 的）。ただし他の進行中ワーカーは「止めない」＝既に走っている fn は最後まで
 * 走り切らせる（中断 API を持たない純ロジックのため。新規 index の取得だけを止める）。
 * **失敗で止めたくない**用途は mapConcurrentSettled を使う（結果に reject を反映する形）。
 *
 * @param items       入力要素。
 * @param fn          各要素の非同期処理（evaluate 等）。第2引数に元の index を渡す。
 * @param concurrency 同時実行数の上限（>=1 に正規化、items.length で頭打ち）。
 * @returns           items と同順・同長の結果配列。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  fn: MapFn<T, R>,
  concurrency: number,
): Promise<R[]> {
  const n = items.length;
  const out: R[] = new Array<R>(n);
  const workers = normalizeConcurrency(concurrency, n);
  if (workers === 0) return out;

  let next = 0;
  // 最初の reject を捕まえたら新規 index の取得を止める（進行中の fn は止められない）。
  let aborted = false;
  let firstError: { value: unknown } | undefined;

  const runWorker = async (): Promise<void> => {
    while (!aborted) {
      const index = next;
      if (index >= n) return;
      next = index + 1;
      const item = items[index] as T;
      try {
        out[index] = await fn(item, index);
      } catch (err) {
        // 最初の失敗だけを記録（決定的に「最初に取得された index の失敗」が優先）。
        if (!aborted) {
          aborted = true;
          firstError = { value: err };
        }
        return;
      }
    }
  };

  const pool: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    pool.push(runWorker());
  }
  await Promise.all(pool);

  if (firstError !== undefined) {
    throw firstError.value;
  }
  return out;
}

/**
 * mapConcurrent の settle 版。失敗を throw せず結果に反映する（Promise.allSettled 的）。
 * **1 つ失敗しても他を止めず**最後まで全要素を処理する（CLAUDE.md「単一ワーカーの失敗で
 * ループを止めない」）。GA / runQuest が候補群評価で「失敗候補は低 fitness 扱い」にしたい
 * ときに使う（呼び出し側が rejected を任意の fitness に畳める）。
 *
 * - 順序保持・決定的: out[index] に status 付きで書くので **入力順**。
 * - 並行度の上限は mapConcurrent と同じプール構造で保証（時間非依存）。
 *
 * @param items       入力要素。
 * @param fn          各要素の非同期処理。
 * @param concurrency 同時実行数の上限（>=1 に正規化、items.length で頭打ち）。
 * @returns           items と同順・同長の SettledResult 配列。
 */
export async function mapConcurrentSettled<T, R>(
  items: readonly T[],
  fn: MapFn<T, R>,
  concurrency: number,
): Promise<SettledResult<R>[]> {
  const n = items.length;
  const out: SettledResult<R>[] = new Array<SettledResult<R>>(n);
  const workers = normalizeConcurrency(concurrency, n);
  if (workers === 0) return out;

  let next = 0;

  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      if (index >= n) return;
      next = index + 1;
      const item = items[index] as T;
      try {
        const value = await fn(item, index);
        out[index] = { index, status: "fulfilled", value };
      } catch (reason) {
        // 失敗を結果に反映して続行（止めない）。
        out[index] = { index, status: "rejected", reason };
      }
    }
  };

  const pool: Promise<void>[] = [];
  for (let w = 0; w < workers; w++) {
    pool.push(runWorker());
  }
  await Promise.all(pool);

  return out;
}
