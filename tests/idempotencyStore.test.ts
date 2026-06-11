import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { partialsDir, partialName } from "../orchestrator/paths.ts";
import { idempotencyKey, type IdempotencyInput } from "../orchestrator/idempotency.ts";
import { IdempotencyStore, inputFromArtifact } from "../orchestrator/idempotencyStore.ts";
import type { PhaseArtifact, Provenance } from "../orchestrator/types.ts";

/** 冪等キー入力のベース（idempotency.test.ts と同形）。 */
const baseInput: IdempotencyInput = {
  phase: "S5",
  worker: 0,
  batch: 1,
  parentIds: ["S3:b", "S3:a"],
  promptVersion: "v1",
  model: "claude",
};

/** baseInput に対応する PhaseArtifact（partial 本体）を組む小道具。 */
function artifactOf(
  input: IdempotencyInput,
  status: PhaseArtifact<unknown>["status"],
  iso: string,
): PhaseArtifact<unknown> {
  const provenance: Provenance = {
    produced_by: input.phase,
    agent: input.model,
    prompt_version: input.promptVersion,
    derived_from: [...input.parentIds],
    timestamp: iso,
  };
  return {
    id: `${input.phase}:${input.worker}.${input.batch}`,
    phase: input.phase,
    worker: input.worker,
    batch: input.batch,
    timestamp: iso,
    schema_version: "0",
    status,
    provenance,
    payload: {},
  };
}

/** partial を runDir に書き、書いた PhaseArtifact を返す。 */
function writePartial(
  runDir: string,
  input: IdempotencyInput,
  status: PhaseArtifact<unknown>["status"],
  iso: string,
): PhaseArtifact<unknown> {
  const art = artifactOf(input, status, iso);
  writeFileSync(
    join(partialsDir(runDir), partialName(input.phase, input.worker, input.batch, iso)),
    JSON.stringify(art),
    "utf8",
  );
  return art;
}

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "taikai-idemstore-"));
  mkdirSync(partialsDir(runDir), { recursive: true });
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("inputFromArtifact", () => {
  it("provenance から冪等キー入力を復元（往復一致）", () => {
    const art = artifactOf(baseInput, "ok", "2026-06-11T12:00:00Z");
    const back = inputFromArtifact(art);
    expect(idempotencyKey(back)).toBe(idempotencyKey(baseInput));
  });

  it("agent 欠落は claude、prompt_version 欠落は空文字で安全側に埋める", () => {
    const art = artifactOf(baseInput, "ok", "2026-06-11T12:00:00Z");
    // 来歴の一部を欠落させた古い partial を模す。
    delete art.provenance.agent;
    delete art.provenance.prompt_version;
    const back = inputFromArtifact(art);
    expect(back.model).toBe("claude");
    expect(back.promptVersion).toBe("");
  });
});

describe("IdempotencyStore.has / mark（純ロジック）", () => {
  it("空 store は何も hit しない", () => {
    const store = new IdempotencyStore();
    expect(store.size).toBe(0);
    expect(store.has(baseInput)).toBe(false);
  });

  it("mark した input は hit、不一致 input は miss", () => {
    const store = new IdempotencyStore();
    store.mark(baseInput);
    expect(store.has(baseInput)).toBe(true);
    // 親集合の並び替えは同一視（key 一致で hit）
    expect(store.has({ ...baseInput, parentIds: ["S3:a", "S3:b"] })).toBe(true);
    // model 違いは別キー（miss）
    expect(store.has({ ...baseInput, model: "gemini" })).toBe(false);
    // 親集合の中身違いは別キー（miss）
    expect(store.has({ ...baseInput, parentIds: ["S3:a"] })).toBe(false);
  });

  it("markFromPartial は partial 由来のキーで hit させる", () => {
    const store = new IdempotencyStore();
    const art = artifactOf(baseInput, "ok", "2026-06-11T12:00:00Z");
    const key = store.markFromPartial(art);
    expect(key).toBe(idempotencyKey(baseInput));
    expect(store.has(baseInput)).toBe(true);
    expect(store.hasKey(key)).toBe(true);
  });

  it("constructor に既存キー列を渡して構築できる", () => {
    const key = idempotencyKey(baseInput);
    const store = new IdempotencyStore([key]);
    expect(store.has(baseInput)).toBe(true);
    expect(store.snapshot()).toEqual([key]);
  });
});

describe("IdempotencyStore.loadFromRun", () => {
  it("空 run（partials 無し）は空 store", () => {
    rmSync(partialsDir(runDir), { recursive: true, force: true });
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.size).toBe(0);
    expect(store.has(baseInput)).toBe(false);
  });

  it("完了 partial のキーで hit（key 一致）、不一致は miss", () => {
    writePartial(runDir, baseInput, "ok", "2026-06-11T12:00:00Z");
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.has(baseInput)).toBe(true);
    // 同じ {phase,worker,batch,親集合,model} を別順序の親で問い合わせても hit
    expect(store.has({ ...baseInput, parentIds: ["S3:a", "S3:b"] })).toBe(true);
    // 親集合が違えば miss
    expect(store.has({ ...baseInput, parentIds: ["S3:a"] })).toBe(false);
  });

  it("status error の partial はマーカーに入らない（未完＝再試行可能）", () => {
    writePartial(runDir, baseInput, "error", "2026-06-11T12:00:00Z");
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.size).toBe(0);
    expect(store.has(baseInput)).toBe(false);
  });

  it("同一 {worker,batch} が error→ok と複数あれば ok 側のキーで hit に昇格", () => {
    writePartial(runDir, baseInput, "error", "2026-06-11T12:00:00Z");
    writePartial(runDir, baseInput, "ok", "2026-06-11T12:00:05Z");
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.has(baseInput)).toBe(true);
    expect(store.size).toBe(1);
  });

  it("別 phase の完了 partial は混ざらない", () => {
    writePartial(runDir, baseInput, "ok", "2026-06-11T12:00:00Z");
    const s3 = IdempotencyStore.loadFromRun(runDir, "S3");
    expect(s3.size).toBe(0);
    expect(s3.has(baseInput)).toBe(false);
    const s5 = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(s5.has(baseInput)).toBe(true);
  });

  it("複数 worker/batch の完了をすべてマーク（件数一致）", () => {
    const a: IdempotencyInput = { ...baseInput, worker: 0, batch: 0 };
    const b: IdempotencyInput = { ...baseInput, worker: 1, batch: 0, model: "gemini" };
    writePartial(runDir, a, "ok", "2026-06-11T12:00:00Z");
    writePartial(runDir, b, "partial", "2026-06-11T12:00:01Z");
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.size).toBe(2);
    expect(store.has(a)).toBe(true);
    expect(store.has(b)).toBe(true);
    // baseInput(worker0,batch1) は書いていないので miss
    expect(store.has(baseInput)).toBe(false);
  });

  it("壊れた JSON partial は scanCompleted が未完扱い→マーカーに入らない", () => {
    writeFileSync(
      join(partialsDir(runDir), partialName("S5", 0, 1, "2026-06-11T12:00:00Z")),
      "{ not json",
      "utf8",
    );
    const store = IdempotencyStore.loadFromRun(runDir, "S5");
    expect(store.size).toBe(0);
  });
});
