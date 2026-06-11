/**
 * dashboard-lite/readers.ts の readEventsSince（SSE tail のコア純ロジック）を tmpdir で検証する。
 * server は起動しない・外部プロセス/ネット非依存。検証の主眼:
 *   - オフセット境界（offset 以降の新行だけ返す / offset の前進が正しい）
 *   - 壊れ行スキップ（events からは除外しつつ offset は消費して前進）
 *   - 書き込み途中の部分行（末尾に改行が無い行）は採用しない＝次 append で完結してから返す
 * append-only な pipeline.jsonl を前提にしているので、events.ts の appendEvent で実ログを作って読む。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEventsSince } from "../dashboard-lite/readers.ts";
import { appendEvent, pipelineLogPath } from "../orchestrator/events.ts";

describe("dashboard-lite readEventsSince (SSE tail 純ロジック)", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "taikai-sse-"));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  it("events ログが無ければ空・offset 0", () => {
    const since = readEventsSince(runDir, 0);
    expect(since.events).toEqual([]);
    expect(since.offset).toBe(0);
  });

  it("offset 0 で既存イベントを全部返し、offset をファイル長まで進める", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    appendEvent(runDir, { type: "PhaseStarted", phase: "S1" });

    const since = readEventsSince(runDir, 0);
    expect(since.events.map((e) => e.type)).toEqual(["PipelineStarted", "PhaseStarted"]);
    expect(since.offset).toBe(statSync(pipelineLogPath(runDir)).size);
  });

  it("オフセット境界: 返した offset を渡すと差分（新規 append 分）だけ返る", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    const first = readEventsSince(runDir, 0);
    expect(first.events.map((e) => e.type)).toEqual(["PipelineStarted"]);

    // 同じ offset で再問い合わせ → 新規なしで空、offset 据え置き
    const idle = readEventsSince(runDir, first.offset);
    expect(idle.events).toEqual([]);
    expect(idle.offset).toBe(first.offset);

    // 新イベントを追記 → 差分だけ返る
    appendEvent(runDir, { type: "PhaseCompleted", phase: "S1", status: "ok" });
    const next = readEventsSince(runDir, first.offset);
    expect(next.events.map((e) => e.type)).toEqual(["PhaseCompleted"]);
    expect(next.offset).toBe(statSync(pipelineLogPath(runDir)).size);
  });

  it("オフセット境界: 行境界（返却 offset）から差分を読むと重複・欠落しない", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    const a = readEventsSince(runDir, 0);
    appendEvent(runDir, { type: "PhaseStarted", phase: "S1" });
    appendEvent(runDir, { type: "PhaseCompleted", phase: "S1", status: "ok" });

    // 前回返した行境界 offset から読むと、未読の 2 行だけが返る（1 行目の重複なし）。
    const b = readEventsSince(runDir, a.offset);
    expect(b.events.map((e) => e.type)).toEqual(["PhaseStarted", "PhaseCompleted"]);
    expect(b.offset).toBe(statSync(pipelineLogPath(runDir)).size);
  });

  it("オフセット境界: 行の途中を指す offset は、その行頭の残骸を壊れ行として捨てる", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    appendEvent(runDir, { type: "PhaseStarted", phase: "S1" });

    // 1 行目の途中（数バイト先）を offset にすると、1 行目の後半だけが残り壊れ行扱いになる。
    // → 1 行目は欠落、以降の完結行のみ返る（行境界 offset を使えば避けられる、という契約の明示）。
    const fromMid = readEventsSince(runDir, 3);
    expect(fromMid.events.map((e) => e.type)).toEqual(["PhaseStarted"]);
    expect(fromMid.offset).toBe(statSync(pipelineLogPath(runDir)).size);
  });

  it("壊れ行スキップ: 不正 JSON 行は events から除外しつつ offset は前進する", () => {
    mkdirSync(join(runDir, "events"), { recursive: true });
    const log = pipelineLogPath(runDir);
    writeFileSync(
      log,
      [
        '{"type":"PhaseFailed","phase":"S5","error":"E_CODE_TEST","ts":"2026-06-11T13:00:00Z"}',
        "{partial broken json",
        '{"type":"PhaseCompleted","phase":"S6","status":"ok","ts":"2026-06-11T13:02:00Z"}',
        "",
      ].join("\n"),
      "utf8",
    );

    const since = readEventsSince(runDir, 0);
    expect(since.events.map((e) => e.type)).toEqual(["PhaseFailed", "PhaseCompleted"]);
    // 壊れ行も「消費済み」として offset はファイル末尾まで進む（次回再パースしない）。
    expect(since.offset).toBe(statSync(log).size);
  });

  it("部分行（末尾改行なし）は採用せず offset を前進させない＝次 append で完結時に返す", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    const log = pipelineLogPath(runDir);
    const afterFirst = statSync(log).size;

    // 改行で終わらない書き込み途中の行を直接足す（append-only の中途状態を再現）。
    appendFileSync(log, '{"type":"PhaseStarted","phase":"S1"', "utf8");

    const mid = readEventsSince(runDir, afterFirst);
    expect(mid.events).toEqual([]); // 部分行は返さない
    expect(mid.offset).toBe(afterFirst); // offset 据え置き（最後の改行直後のまま）

    // 行が完結したら（残り＋改行を足す）その行が返る。
    appendFileSync(log, ',"worker":0}\n', "utf8");
    const done = readEventsSince(runDir, mid.offset);
    expect(done.events.map((e) => e.type)).toEqual(["PhaseStarted"]);
    expect(done.offset).toBe(statSync(log).size);
  });

  it("不正カーソル（負/NaN/ファイル長超）でも落とさず安全側に倒す", () => {
    appendEvent(runDir, { type: "PipelineStarted", run_id: "r1" });
    const size = statSync(pipelineLogPath(runDir)).size;

    // 負 → 0 にクランプして全行返す
    const neg = readEventsSince(runDir, -100);
    expect(neg.events.map((e) => e.type)).toEqual(["PipelineStarted"]);

    // NaN → 0 にクランプ
    const nan = readEventsSince(runDir, Number.NaN);
    expect(nan.events.map((e) => e.type)).toEqual(["PipelineStarted"]);

    // ファイル長超 → 新規なし・offset はファイル長に正規化
    const over = readEventsSince(runDir, size + 999);
    expect(over.events).toEqual([]);
    expect(over.offset).toBe(size);
  });
});
