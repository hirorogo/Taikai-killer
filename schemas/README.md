# schemas/

フェーズ間 JSON 契約（D2）。speca 同型の3+1層：
- データ型: `Provenance` / `TournamentInfo` / `ScoringRubric` / `Strategy` / `CodeAttempt` / `CodegenResult` / `BenchResult` / `LeaderboardEntry` / `ProjectManifest`
- フェーズ partial: `S{n}Partial`
- イベント: `*Event`（append-only / 観測用）
- メタ: `RunManifest` / `PartialMetadata`

TS 型の正は [`orchestrator/types.ts`](../orchestrator/types.ts)。ここには各 `*.schema.json`（JSON Schema 実体）を置き、`orchestrator/schemas.ts`（ajv）が検証する。

> Issue #3: MVP は上記データ型の最小スキーマから実体化する。
