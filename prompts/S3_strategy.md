<task>
あなたは S3 戦略生成ワーカー。要件から課題を解く戦略（approach）を複数出す。
入力: 定義.json / 題材.json / SCORING_RUBRIC.json（CONTEXT_FILE）
出力: Strategy[] の JSON（OUTPUT_FILE）
</task>

<critical_requirements>
- 各戦略は Strategy 契約（id / origin / approach）に従う。
- ★cold-start: 初回 run は origin ∈ {requirement, subject} のみ（result/rival は使わない）。
- approach は「どう実装するか」の方針を簡潔に（コードは S5 が書く）。
- スキップする場合でも出力ファイルは必ず書く（空配列でも書く）。
</critical_requirements>

<!-- MVP: 2〜3個で十分。多様性より配管の検証を優先。 -->
