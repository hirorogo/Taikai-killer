/**
 * best-effort 通知（欠落5 / CLAUDE.md「通知は best-effort」）。
 * runner.ts のインライン notify と同型: (1) logs/notify.jsonl に必ず1行追記
 * (2) env TAIKAI_NOTIFY_WEBHOOK があれば fetch で POST、配信失敗でも throw しない。
 * 「無通知＝無限停止」を防ぐため、ファイル追記が本体・webhook は補助。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logsDir } from "./paths.ts";

/** 通知イベント本体（type ほか任意フィールド）。runner.ts の event 形に合わせる。 */
export type NotifyEvent = Record<string, unknown>;

/** notify.jsonl のファイル名（パス規約: logs/ 配下に固定）。 */
export const NOTIFY_LOG_FILE = "notify.jsonl";

/** webhook 切替の env キー（mvp-vertical-slice 欠落5）。 */
export const NOTIFY_WEBHOOK_ENV = "TAIKAI_NOTIFY_WEBHOOK";

const isoNow = (): string => new Date().toISOString();

/**
 * イベントを JSONL の1行（末尾改行なし）に整形する純関数。
 * ts を必ず注入する（呼び側が ts を渡せば上書き＝後勝ち。runner と同じ {...event, ts}）。
 * 副作用なしなのでテスト対象はここ。
 */
export function formatNotifyLine(event: NotifyEvent, ts: string = isoNow()): string {
  return JSON.stringify({ ...event, ts });
}

/** webhook へ送る payload（runner.ts と同じ `[taikai] <line>` テキスト体）。 */
export function formatWebhookBody(line: string): string {
  return JSON.stringify({ text: `[taikai] ${line}` });
}

/** notify.jsonl の絶対/相対パス（runDir 起点）。 */
export function notifyLogPath(runDir: string): string {
  return join(logsDir(runDir), NOTIFY_LOG_FILE);
}

/**
 * best-effort 通知本体。
 * 1) logs/notify.jsonl に必ず1行追記（失敗は握り潰す＝本体を止めない）
 *    - logs/ が無ければ作る（runner 側 ensureDirs 前の単独呼び出し＝doctor 早期 exit /
 *      ensureDirs 前のエラー通知でも『必ず1行追記』を成立させる。events.ts と同型）。
 *    - ただし notify は best-effort なので mkdir 失敗も throw せず握り潰す
 *      （events.ts の appendEvent は監査用で throw する設計だが、notify は止めないのが正）。
 * 2) TAIKAI_NOTIFY_WEBHOOK があれば POST。失敗しても throw しない。
 */
export async function notify(runDir: string, event: NotifyEvent): Promise<void> {
  const line = formatNotifyLine(event);
  try {
    const dir = logsDir(runDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(notifyLogPath(runDir), line + "\n", "utf8");
  } catch {
    /* ignore: ディレクトリ作成・ファイル追記失敗でも本体を止めない（best-effort） */
  }
  const hook = process.env[NOTIFY_WEBHOOK_ENV];
  if (!hook) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: formatWebhookBody(line),
    });
  } catch {
    /* best-effort: 配信失敗でも本体を止めない */
  }
}
