## 🔎 追加調査: nyx foundation / speca の構造・プレゼンツール・grandchildrice

README が「全体パイプラインの参考」とする **speca**、「スライド生成の参考」とする **nyx のプレゼンツール**、および頻繁にコミットしている **grandchildrice** をサブエージェントで調査した。（確認済み事実と推測を区別して記載）

### 1. nyx foundation
- GitHub org: **[NyxFoundation](https://github.com/NyxFoundation)**（CamelCase 表記。`nyx-foundation` は404）。2025-07 作成、公開リポジトリ33。
- 実態は **Ethereum / 暗号 / 形式検証（Formal Verification）に特化した研究組織**。`verity`（Lean4 形式検証済み Ethereum クライアント）、各コンセンサスプロトコルの FV ノート、`speca`（旗艦・⭐429）、`presentation-agent` 等。
- 「LLMエージェントで専門的な検証タスクを自動パイプライン化する」のが得意 → Taikai-killer が参照するのは妥当。

### 2. speca の構造 — **SPECA: Specification-to-Checklist Agentic Auditing Framework**
- **[NyxFoundation/speca](https://github.com/NyxFoundation/speca)**（Python, ⭐429, MIT, `arXiv:2604.26495`）。docs: https://speca.pages.dev/ ・ CLI: `speca-cli`。
- **設計思想**: 既知バグパターンを探すのでなく、**自然言語仕様から型付きセキュリティ特性(property)を導出し、各実装に不変条件を「証明させる」**ことで仕様レベル違反を検出。Sherlock Ethereum Fusaka 監査で in-scope H/M/L 全15件回収＋366人が見逃した新規バグ4件発見の実績。
- **パイプライン（直列フェーズ＋各フェーズ内並列ワーカー）**:
  ```
  0a スコープ抽出 → 0b/0c 検証
  → 01a 仕様収集(crawl) → 01b 構造化サブグラフ抽出(Mermaid+JSON)
  → 01e トラスト境界＋型付きproperty生成(STRIDE/CWE)
  → 02c コード位置解決(MCP→Glob/Grep多段フォールバック)
  → 03 監査マップ(Map→Prove→Stress-Test)
  → 04 レビュー(3ゲートFPフィルタ) → 05 PoC → 06 レポート
  ```
- **ディレクトリ構成（実取得）**:
  ```
  speca/
  ├── scripts/orchestrator/  # 中核: runner, queue, watchdog, circuit breaker, resume, factory, batch
  ├── scripts/run_phase.py   # 統一フェーズランナー（依存解決・cleanup・resume）
  ├── prompts/               # フェーズ別ワーカープロンプト
  ├── schemas/               # 50超のJSON Schema = フェーズ間契約
  ├── cli/                   # speca-cli（Node + Ink TUI）
  ├── benchmarks/            # RQ1/RQ2 ハーネス＋論文図
  ├── website/               # Docusaurus
  └── outputs/               # フェーズ出力（gitignore）
  ```
- **オーケストレーション**: 各フェーズが `<phase>_PARTIAL_W{worker}B{batch}_{ts}.json` を出力→下流はglobで消費。Circuit Breaker / Cost Tracker(USD予算上限) / Resume Manager / Log Watcher を全フェーズ共有。ワーカーは `claude` CLI + MCP を駆動。

**→ Taikai-killer が speca を「全体参考」にできる理由**:
1. **フェーズ分割＋フェーズ間 JSON 契約(schemas/)** — README の「各フェーズで json 出力」「フォルダ構成を定義しておく」と完全一致。型固定で検証・上書き・再開が可能。
2. **orchestrator が独立分離**（resume / circuit breaker / コスト上限 / watchdog）— README の「止まったら叩く」「ratelimitで待機して再開」「無限ループ運用」の雛形そのもの。
3. **中間JSONを全段で残す** → 人間が任意の段を検査・差し替え（ヒューマンレビュー必須セッションに対応）。
4. **設定駆動オンボーディング**（`BUG_BOUNTY_SCOPE.json`+`TARGET_INFO.json` を書くだけで新ターゲット投入）= 大会ごとに設定だけ差し替える運用に直結。

### 3. nyx のプレゼン/スライド生成ツール
- **[NyxFoundation/presentation-agent](https://github.com/NyxFoundation/presentation-agent)**（本命）— **Claude駆動で単一Markdownブリーフ→Slidevデッキを生成**（Slidev/Vue/Bun）。speca と同じ「フェーズ分割＋各段JSON」思想。
  - 入力 `inputs/introduction.md`（frontmatterで target_audience/max_slides/output_language）→ `make all`
  - **9〜13段プロンプトパイプライン**: `01 Context_Analysis → 02 Audience_Persona → 03 Core_Strategy → 04 Governing_Argument → 05 Narrative_Blueprint → 06 Slide_Drafting → 07 Visual_Design → 08 Executive_Review → 09 Final_Export`（＋`10/11 自己改善ループ`, `3D_Scene_Generation`）
  - 三原則: Strategy-First / Logic & Emotion(ピラミッド原則) / Iterative Refinement。**自己改善ループ内蔵**。
- **[NyxFoundation/nyx-slidev-template](https://github.com/NyxFoundation/nyx-slidev-template)** — nyx 標準 Slidev テンプレ。

**→** Taikai-killer が「優勝のための成果物＝発表資料」まで自律生成するなら、presentation-agent の 9段＋自己改善ループがほぼそのまま発表モジュールになる。speca と presentation-agent は**同一設計言語（フェーズ分割＋中間JSON＋Claude CLIワーカー）**で、合わせると「監査/生成ロジック ＋ 発表資料」の end-to-end が揃う。

### 4. grandchildrice
- **[github.com/grandchildrice](https://github.com/grandchildrice)** — 表示名 **gohan**、bio: Ethereum / Cryptography。
- **speca の筆頭コントリビュータ（427コミット, 全体1位）。フレームワーク中核の主著者。**（2位は `hirorogo`／304コミット）
- SPECA論文著者 *Masato Kamba, Hirotake Murakami, Akiyoshi Sannai* と照合し、**grandchildrice ≒ Hirotake Murakami（SPECA共著者・主実装者）と高確度で推定**（推測）。本人リポジトリは ZKP/zkVM/folding scheme/FHE 等、nyx の技術領域と一致。
- プレゼンツールへの直接コミット内訳は未取得。

### 5. Taikai-killer への落とし込み案（追記）
- [ ] **speca の orchestrator 設計をハーネス基盤として直接流用**（runner/queue/watchdog/circuit-breaker/resume/cost-tracker）。README の「無限ループ＋ratelimit復帰＋止まったら叩く」要件をほぼ満たす。
- [ ] **フェーズ間 JSON Schema 契約（speca schemas/）の設計パターンを採用** → README の `質問.json`/`定義.json`/`題材.json`/`検索ワード.json`/`urlクロール.json`/`result.json` をスキーマ化。
- [ ] **発表生成は presentation-agent の9段パイプラインを移植**（README「nyxのプレゼンツール導入」の具体化）。
- [ ] speca/presentation-agent の `prompts/` 分割粒度を Taikai-killer の各セッションプロンプト設計の参考にする。

---
*GitHub API（`gh`）＋Web検索による自動収集。コミット数・スター数は調査時点。推測箇所は明記。*
