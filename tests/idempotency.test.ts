import { describe, it, expect } from "vitest";
import { idempotencyKey, type IdempotencyInput } from "../orchestrator/idempotency.ts";

const base: IdempotencyInput = {
  phase: "S5",
  worker: 0,
  batch: 1,
  parentIds: ["S3:b", "S3:a"],
  promptVersion: "v1",
  model: "claude",
};

describe("idempotencyKey", () => {
  it("hex sha256（64文字）を返す", () => {
    const key = idempotencyKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同一入力で決定論的（同じキー）", () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }));
  });

  it("parentIds は集合扱い＝並び順に依存しない", () => {
    const reordered: IdempotencyInput = { ...base, parentIds: ["S3:a", "S3:b"] };
    expect(idempotencyKey(reordered)).toBe(idempotencyKey(base));
  });

  it("phase が変われば別キー", () => {
    expect(idempotencyKey({ ...base, phase: "S3" })).not.toBe(idempotencyKey(base));
  });

  it("worker が変われば別キー", () => {
    expect(idempotencyKey({ ...base, worker: 1 })).not.toBe(idempotencyKey(base));
  });

  it("batch が変われば別キー", () => {
    expect(idempotencyKey({ ...base, batch: 2 })).not.toBe(idempotencyKey(base));
  });

  it("promptVersion が変われば別キー", () => {
    expect(idempotencyKey({ ...base, promptVersion: "v2" })).not.toBe(idempotencyKey(base));
  });

  it("model が変われば別キー", () => {
    expect(idempotencyKey({ ...base, model: "gemini" })).not.toBe(idempotencyKey(base));
  });

  it("親集合の中身が変われば別キー", () => {
    expect(idempotencyKey({ ...base, parentIds: ["S3:a"] })).not.toBe(idempotencyKey(base));
  });

  it("親なし（空集合）でも安定して生成できる", () => {
    const empty: IdempotencyInput = { ...base, parentIds: [] };
    expect(idempotencyKey(empty)).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey(empty)).toBe(idempotencyKey({ ...empty, parentIds: [] }));
  });

  it("フィールド境界の混同が無い（区切り文字でセグメントが分離される）", () => {
    // worker=12,batch=3 と worker=1,batch=23 が衝突しないこと
    const a = idempotencyKey({ ...base, worker: 12, batch: 3 });
    const b = idempotencyKey({ ...base, worker: 1, batch: 23 });
    expect(a).not.toBe(b);
  });
});
