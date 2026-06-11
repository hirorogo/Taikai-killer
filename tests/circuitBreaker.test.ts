import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../orchestrator/circuitBreaker.ts";
import { CB } from "../orchestrator/config.ts";

describe("CircuitBreaker", () => {
  it("初期状態は未トリップ", () => {
    const cb = new CircuitBreaker();
    expect(cb.tripped()).toBe(false);
    expect(cb.reason()).toBeNull();
  });

  it("連続失敗が consecutiveFailures に達するとトリップ", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CB.consecutiveFailures - 1; i++) cb.recordResult(false);
    expect(cb.tripped()).toBe(false);
    cb.recordResult(false);
    expect(cb.tripped()).toBe(true);
    expect(cb.reason()).toBe("consecutive_failures");
  });

  it("成功で連続失敗カウンタがリセットされる", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CB.consecutiveFailures - 1; i++) cb.recordResult(false);
    cb.recordResult(true); // リセット
    for (let i = 0; i < CB.consecutiveFailures - 1; i++) cb.recordResult(false);
    expect(cb.tripped()).toBe(false);
  });

  it("recordSkip は一切カウンタを触らない（death-spiral 回避）", () => {
    const cb = new CircuitBreaker();
    // consecutiveFailures しきい値を超える回数 skip しても発火しない
    for (let i = 0; i < CB.consecutiveFailures + 5; i++) cb.recordSkip("ratelimit");
    for (let i = 0; i < CB.totalRetries + 5; i++) cb.recordSkip("idempotent_hit");
    expect(cb.tripped()).toBe(false);
    expect(cb.reason()).toBeNull();
  });

  it("失敗の間に skip を挟んでも連続失敗カウントは途切れない", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CB.consecutiveFailures; i++) {
      cb.recordResult(false);
      cb.recordSkip("missing_parent"); // skip は no-op
    }
    expect(cb.reason()).toBe("consecutive_failures");
  });

  it("連続空出力が consecutiveEmptyResults に達するとトリップ", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CB.consecutiveEmptyResults - 1; i++) cb.recordEmpty();
    expect(cb.tripped()).toBe(false);
    cb.recordEmpty();
    expect(cb.reason()).toBe("consecutive_empty_results");
  });

  it("非空の成功で連続空出力カウンタがリセットされる", () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < CB.consecutiveEmptyResults - 1; i++) cb.recordEmpty();
    cb.recordResult(true); // empty リセット
    expect(cb.tripped()).toBe(false);
  });

  it("総リトライが totalRetries に達するとトリップ（成功でリセットされない）", () => {
    const cb = new CircuitBreaker();
    // 失敗4回ごとに成功を挟み consecutiveFailures は発火させずに totalRetries を積む
    let fails = 0;
    while (fails < CB.totalRetries) {
      cb.recordResult(false);
      fails++;
      if (cb.reason() === "consecutive_failures") {
        // ここに来る前に total で発火するはずだが安全弁
        break;
      }
      // consecutiveFailures 手前で成功を挟んで連続失敗発火を避ける
      if (fails % (CB.consecutiveFailures - 1) === 0 && fails < CB.totalRetries) {
        cb.recordResult(true);
      }
    }
    expect(cb.reason()).toBe("total_retries");
  });

  it("consecutive_failures が total_retries より優先される", () => {
    const cb = new CircuitBreaker();
    // 連続失敗だけで両方を超えさせる（5 < 20 なので先に failures が発火）
    for (let i = 0; i < CB.totalRetries + 1; i++) cb.recordResult(false);
    expect(cb.reason()).toBe("consecutive_failures");
  });
});
