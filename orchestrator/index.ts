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
    case "evolve": {
      // D18①: じゃんけんパラメータを LLM 非依存で進化（数値最適化トラック）
      const { evolveJankenDemo } = await import("../evolution/evolveDemo.ts");
      const seed = Number(getOpt("seed") ?? 42);
      const iterations = Number(getOpt("iterations") ?? 80);
      const r = await evolveJankenDemo({ seed, iterations });
      console.log(
        `[evolve] win_rate ${r.initialWinRate.toFixed(3)} -> ${r.evolvedWinRate.toFixed(3)} (improved=${r.improved})`,
      );
      console.log(`[evolve] evolvedParams=${JSON.stringify(r.evolvedParams)}`);
      process.exit(r.improved ? 0 : 1);
      break;
    }
    case "doctor": {
      const { doctor } = await import("./runner.ts");
      await doctor(runDir);
      break;
    }
    case "experiment": {
      // 多戦略実験ループ: 複数戦略を実装・採点→いいとこ比較→閾値実験→round くるくる
      const { runExperiment } = await import("./runner.ts");
      const rounds = Number(getOpt("rounds") ?? 2);
      const topK = Number(getOpt("topK") ?? 2);
      await runExperiment(runDir, { rounds, topK });
      break;
    }
    case "quest": {
      // 標準化フレームワーク: クエストを GA で自律最適化（LLM不要・numeric）。--quest で選択。
      const which = getOpt("quest") ?? "xq";
      const { runQuest } = await import("./quest/runQuest.ts");
      type NumAdapter = import("./quest/adapter.ts").QuestAdapter<Record<string, number>>;
      let adapter: NumAdapter;
      let subDir: string;
      if (which === "ai") {
        adapter = (await import("./quest/aiHyperoptAdapter.ts")).aiHyperoptAdapter;
        subDir = "quests/ai-hyperopt";
      } else if (which === "robo") {
        adapter = (await import("./quest/roboControlAdapter.ts")).roboControlAdapter;
        subDir = "quests/robo-control";
      } else {
        adapter = (await import("./quest/xqAdapter.ts")).xqAdapter;
        subDir = "quests/xq-7narabe";
      }
      const generations = Number(getOpt("generations") ?? 15);
      const seed = Number(getOpt("seed") ?? 42);
      const init = await adapter.evaluate(adapter.initialCandidate());
      console.log(`[quest:${adapter.questId}] initial fitness=${init.toFixed(3)}`);
      const res = await runQuest(adapter, { seed, generations, submissionDir: subDir });
      console.log(
        `[quest] best fitness=${res.bestScore.toFixed(3)} (evals=${res.evaluations}, improved=${res.bestScore >= init})`,
      );
      console.log(`[quest] best=${JSON.stringify(res.best)} → ${subDir}/best_params.json`);
      break;
    }
    case "status": {
      // run ディレクトリの要約（フェーズ進捗・結果・leaderboard 上位）
      const { summarizeRun } = await import("./runSummary.ts");
      const d = summarizeRun(runDir);
      console.log(JSON.stringify(d, null, 2));
      break;
    }
    default:
      console.error("usage: taikai <probe|run|doctor|status|evolve|experiment|quest> [--run-dir <path>] [--quest xq] [--generations N] [--rounds N] [--topK N] [--seed N] [--iterations N]");
      process.exit(2);
  }
}

void main();
