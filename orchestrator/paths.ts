/**
 * outputs パス規約（D2 / docs/directory-structure.md）。
 * partial = S{n}_PARTIAL_W{worker}B{batch}_{ISO8601}.json
 */
import { join } from "node:path";

export function partialsDir(runDir: string): string {
  return join(runDir, "partials");
}
export function eventsDir(runDir: string): string {
  return join(runDir, "events");
}
export function logsDir(runDir: string): string {
  return join(runDir, "logs");
}
export function partialName(phase: string, worker: number, batch: number, iso: string): string {
  // ISO8601 の ":" はファイル名に使えない環境があるため "-" に正規化
  const safeIso = iso.replace(/:/g, "-");
  return `${phase}_PARTIAL_W${worker}B${batch}_${safeIso}.json`;
}
export function resultPath(runDir: string): string {
  return join(runDir, "result.json");
}
export function tournamentInfoPath(runDir: string): string {
  return join(runDir, "TOURNAMENT_INFO.json");
}
export function scoringRubricPath(runDir: string): string {
  return join(runDir, "SCORING_RUBRIC.json");
}
export function leaderboardPath(): string {
  return join("outputs", "leaderboard.json");
}
