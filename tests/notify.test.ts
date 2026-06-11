import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatNotifyLine,
  formatWebhookBody,
  notify,
  notifyLogPath,
  NOTIFY_LOG_FILE,
} from "../orchestrator/notify.ts";
import { logsDir } from "../orchestrator/paths.ts";

describe("notify pure helpers", () => {
  it("formatNotifyLine は ts を注入した1行 JSON を返す", () => {
    const line = formatNotifyLine({ type: "run_complete", passed: true }, "2026-06-11T12:00:00Z");
    expect(line).toBe('{"type":"run_complete","passed":true,"ts":"2026-06-11T12:00:00Z"}');
    // 改行を含まない（1行 = jsonl の1レコード）
    expect(line.includes("\n")).toBe(false);
  });

  it("event 側の ts は呼び側引数で後勝ち上書きされる（runner と同じ {...event, ts}）", () => {
    const line = formatNotifyLine({ type: "x", ts: "OLD" }, "NEW");
    expect(JSON.parse(line).ts).toBe("NEW");
  });

  it("ts 未指定でも ISO8601 文字列が入る", () => {
    const parsed = JSON.parse(formatNotifyLine({ type: "x" }));
    expect(typeof parsed.ts).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.ts))).toBe(false);
  });

  it("formatWebhookBody は [taikai] prefix の text フィールドを作る", () => {
    const body = formatWebhookBody('{"type":"x","ts":"T"}');
    expect(JSON.parse(body)).toEqual({ text: '[taikai] {"type":"x","ts":"T"}' });
  });

  it("notifyLogPath は logs/notify.jsonl を runDir 配下に解決する", () => {
    const p = notifyLogPath("outputs/run1");
    expect(p.endsWith(NOTIFY_LOG_FILE)).toBe(true);
    // logs ディレクトリを経由する（パス規約: logs/ 配下）
    expect(p.includes("logs")).toBe(true);
  });
});

/**
 * notify() 本体の I/O 契約（ネットワーク非依存）。
 * webhook env を確実に外して fetch を発火させない（best-effort のファイル側のみ検証）。
 */
describe("notify() best-effort I/O (network-independent)", () => {
  let base: string;
  const savedHook = process.env.TAIKAI_NOTIFY_WEBHOOK;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "taikai-notify-"));
    // webhook 未設定にして fetch を呼ばせない（純 I/O のみ）
    delete process.env.TAIKAI_NOTIFY_WEBHOOK;
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    if (savedHook === undefined) delete process.env.TAIKAI_NOTIFY_WEBHOOK;
    else process.env.TAIKAI_NOTIFY_WEBHOOK = savedHook;
  });

  it("logs/ が未作成でも自動生成して必ず1行追記する（high 修正の回帰検出）", async () => {
    // runDir 自体は存在するが logs/ サブディレクトリは無い状態
    expect(existsSync(logsDir(base))).toBe(false);
    await notify(base, { type: "run_complete", passed: true });

    expect(existsSync(notifyLogPath(base))).toBe(true);
    const raw = readFileSync(notifyLogPath(base), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe("run_complete");
    expect(typeof parsed.ts).toBe("string"); // ts 注入
  });

  it("連続呼び出しで append される（追記であって上書きでない）", async () => {
    await notify(base, { type: "a" });
    await notify(base, { type: "b" });
    const lines = readFileSync(notifyLogPath(base), "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(["a", "b"]);
  });

  it("存在しない runDir でも reject せず undefined を返す（throw しない契約）", async () => {
    const ghost = join(base, "does", "not", "exist");
    await expect(notify(ghost, { type: "x" })).resolves.toBeUndefined();
  });
});
