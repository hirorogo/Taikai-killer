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

/** gemini スパイク: gemini CLI が available か＋実発火（認証）を最小プロンプトで確認。 */
async function probeGemini(): Promise<void> {
  const avail = await geminiRunner.checkAvailable();
  console.log(`[probe:gemini] available: ${avail.ok}${avail.hint ? ` (${avail.hint})` : ""}`);
  if (!avail.ok) process.exit(2);
  const out = await geminiRunner.run({
    prompt: 'Reply with exactly this JSON and nothing else: {"ok": true}',
    timeoutMs: 60_000,
  });
  console.log(`[probe:gemini] exitCode=${out.exitCode} empty=${out.emptyResult}`);
  if (out.errorCode !== undefined) {
    // 認証未設定（code=41）等を明示。設定例も出して次アクションを示す。
    console.error(`[probe:gemini] error.code=${out.errorCode}: ${out.errorMessage ?? ""}`);
    if (out.errorCode === 41) {
      console.error(
        "[probe:gemini] 認証未設定。サブスク(Gemini Code Assist)なら `setx GOOGLE_GENAI_USE_GCA true`、" +
          "または `setx GEMINI_API_KEY <key>` を設定して再実行（CLAUDE.md 環境変数）。",
      );
    }
    process.exit(1);
  }
  console.log(`[probe:gemini] text: ${out.text.slice(0, 200)}`);
  process.exit(out.emptyResult ? 1 : 0);
}

async function main(): Promise<void> {
  const runDir = getOpt("run-dir") ?? "outputs/dev-run";
  switch (cmd) {
    case "probe":
      await probe();
      break;
    case "probe-gemini":
      await probeGemini();
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
    case "coevolve": {
      // 自己対戦コオエボリューション: 現champion に勝つ challenger を GA で探し、勝てば交代（軍拡競争）
      const { coevolveXq } = await import("./quest/coevolve.ts");
      const seed = Number(getOpt("seed") ?? 42);
      const rounds = Number(getOpt("rounds") ?? 5);
      const popSize = Number(getOpt("popSize") ?? 6);
      const generations = Number(getOpt("generations") ?? 4);
      const games = Number(getOpt("games") ?? 60);
      const archiveOpt = getOpt("archiveSize"); // 殿堂サイズ（過去 champion 保持上限）。未指定は既定 4。
      const res = await coevolveXq({
        seed,
        rounds,
        popSize,
        generations,
        games,
        ...(archiveOpt !== undefined ? { archiveSize: Number(archiveOpt) } : {}),
      });
      const promotions = res.rounds.filter((r) => r.promoted).length;
      console.log(`[coevolve:xq] ${rounds}round / 昇格 ${promotions}回 / 殿堂 ${res.archive.length}体`);
      console.log(`[coevolve] trajectory=${res.trajectory.map((t) => t.toFixed(3)).join(" -> ")}`);
      console.log(`[coevolve] champion → quests/xq-7narabe/champion_params.json`);
      break;
    }
    case "loop": {
      // ぐるぐる回る本体: S1一度 → S3→S5→S6 を結果再投入＋いいとこ取りで回し続ける（収束で停止）
      const { runLoop } = await import("./runner.ts");
      const maxRounds = Number(getOpt("max-rounds") ?? 50);
      const topK = Number(getOpt("topK") ?? 2);
      const patience = Number(getOpt("patience") ?? 4);
      await runLoop(runDir, { maxRounds, topK, patience });
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
      } else if (which === "data") {
        adapter = (await import("./quest/dataInsightAdapter.ts")).dataInsightAdapter;
        subDir = "quests/data-insight";
      } else if (which === "xq-mixed") {
        // 混合フィールド最適化（§7.6 intransitivity 対策）: random/medium/heuristic 混在卓で最大化。
        adapter = (await import("./quest/xqMixedAdapter.ts")).xqMixedAdapter;
        subDir = "quests/xq-7narabe";
      } else {
        adapter = (await import("./quest/xqAdapter.ts")).xqAdapter;
        subDir = "quests/xq-7narabe";
      }
      const generations = Number(getOpt("generations") ?? 15);
      const seed = Number(getOpt("seed") ?? 42);
      const gaPop = getOpt("ga"); // --ga N で本格GA（popSize=N）。未指定はヒルクライム。
      const init = await adapter.evaluate(adapter.initialCandidate());
      console.log(`[quest:${adapter.questId}] initial fitness=${init.toFixed(3)}${gaPop ? ` (GA pop=${gaPop})` : ""}`);
      const res = await runQuest(adapter, {
        seed,
        generations,
        submissionDir: subDir,
        ...(gaPop ? { gaPopSize: Number(gaPop) } : {}),
      });
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
      console.error("usage: taikai <probe|probe-gemini|run|doctor|status|evolve|experiment|quest|coevolve|loop> [--run-dir <path>] [--quest xq|xq-mixed|ai|robo|data] [--ga N] [--rounds N] [--popSize N] [--games N] [--archiveSize N] [--max-rounds N] [--patience N] [--generations N] [--topK N] [--seed N]");
      process.exit(2);
  }
}

void main();
