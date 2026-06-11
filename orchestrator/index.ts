#!/usr/bin/env -S npx tsx
/**
 * taikai CLI エントリ。`taikai run --run-dir outputs/{run}` で縦串MVPを1周。
 * 実装は Issue #3 のチェックリストに沿う。現状は骨格（スタブ）。
 */

const argv = process.argv.slice(2);
const cmd = argv[0];

function getOpt(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const runDir = getOpt("run-dir") ?? "outputs/dev-run";
  switch (cmd) {
    case "run":
      // TODO(Issue#3): S1 → S3 → S5(D22) → S6 → result.json → notify（1周だけ）
      console.error(`[taikai] run --run-dir ${runDir} : 未実装（Issue #3 のスタブ）`);
      process.exit(1);
      break;
    case "doctor":
      // TODO(Issue#3): TOURNAMENT_INFO.json / SCORING_RUBRIC.json のロード可能性検証
      console.error(`[taikai] doctor --run-dir ${runDir} : 未実装`);
      process.exit(1);
      break;
    default:
      console.error("usage: taikai <run|doctor> --run-dir <path>");
      process.exit(2);
  }
}

void main();
