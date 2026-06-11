#!/usr/bin/env -S npx tsx
/**
 * taikai CLI エントリ。
 *   taikai probe                    D4検証: claude CLI が駆動できるか
 *   taikai run --run-dir outputs/X  縦串MVPを1周（S1→S3→S5→S6→result）
 *   taikai doctor --run-dir X        起動前バリデータ
 */
import { register, runCLISubprocess } from "./runtimeRegistry.ts";
import { claudeRunner } from "./runtimes/claudeRunner.ts";
import { geminiRunner } from "./runtimes/geminiRunner.ts";

register(claudeRunner);
register(geminiRunner);

const argv = process.argv.slice(2);
const cmd = argv[0];

function getOpt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** D4 スパイク: claude CLI に最小プロンプトを投げ、JSON が返るか確認。 */
async function probe(): Promise<void> {
  const avail = await claudeRunner.checkAvailable();
  console.log(`[probe] claude available: ${avail.ok}${avail.hint ? ` (${avail.hint})` : ""}`);
  if (!avail.ok) process.exit(2);
  const out = await runCLISubprocess("claude", {
    prompt: 'Reply with exactly this JSON and nothing else: {"ok": true}',
    timeoutMs: 60_000,
  });
  console.log(`[probe] exitCode=${out.exitCode} empty=${out.emptyResult}`);
  console.log(`[probe] text: ${out.text.slice(0, 200)}`);
  process.exit(out.emptyResult ? 1 : 0);
}

async function main(): Promise<void> {
  const runDir = getOpt("run-dir") ?? "outputs/dev-run";
  switch (cmd) {
    case "probe":
      await probe();
      break;
    case "run": {
      const { runSlice } = await import("./runner.ts");
      await runSlice(runDir);
      break;
    }
    case "doctor": {
      const { doctor } = await import("./runner.ts");
      await doctor(runDir);
      break;
    }
    default:
      console.error("usage: taikai <probe|run|doctor> [--run-dir <path>]");
      process.exit(2);
  }
}

void main();
