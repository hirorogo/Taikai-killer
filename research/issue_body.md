## 📚 外部知見リサーチ: 関連論文・類似OSSプロジェクト調査

README のパイプライン設計（自律ハーネスで要件定義→外部知見→戦略→コード生成→ベンチマークを無限ループ）を実装に進めるための **先行研究・類似実装の調査結果** をまとめる。
各セッション案（README の 1〜6）にマッピングして整理した。

> 調査手段: Semantic Scholar API（arXiv索引）＋ GitHub repo search。arXiv export API は egress IP が 503 ブロックのため Semantic Scholar 経由で取得。

---

### 1. 関連論文（arXiv）

#### 自己改善ハーネス / パイプライン（→ README 全体・5コード生成）
- **DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines** — `arXiv:2310.03714`（764 cites）
  - 宣言的にLM呼び出しを記述し、パイプラインを自己最適化（プロンプト/重みをコンパイル）。**「template.md で文体一致」「自己改善系プロンプト」を仕組み化する直接の土台。**
- **Agentic Context Engineering: Evolving Contexts for Self-Improving Language Models** — `arXiv:2510.04618`（173 cites）
  - コンテキスト（プレイブック）を実行結果から進化させる自己改善。**ネタ帳/戦略の蓄積→再投入ループに対応。**
- **Reflexion**（verbal RL／失敗トレースを言語で内省して再試行）— 実装多数（後述 OSS）。**「AIが止まる/失敗→自動で叩き直す」ループの理論的裏付け。**

#### マルチエージェント・コード生成（→ README 5コード生成）
- **CodeCoR: An LLM-Based Self-Reflective Multi-Agent Framework for Code Generation** — `arXiv:2501.07811`（34 cites）
  - 自己反省つきマルチエージェントで生成→テスト→修正。**5b/5cのテスト通すまでループに直結。**
- **Self-Organized Agents: A LLM Multi-Agent Framework toward Ultra Large-Scale Code Generation and Optimization** — `arXiv:2404.02183`（100 cites）
  - 大規模並列コード生成のエージェント自己組織化。**「マルチエージェント・オーケストレーションで並行実装」の参考。**
- **AutoSafeCoder: Multi-Agent Framework for Securing LLM Code Generation (Static Analysis + Fuzz)** — `arXiv:2409.10737`（44 cites）
  - 静的解析＋ファジングをエージェントに組込み。**5cの「エラーが起きないか確かめる」を堅牢化。**

#### 競技プログラミング / 大会（→ README 目的・3戦略・6ベンチ）
- **Competitive Programming with Large Reasoning Models** — `arXiv:2502.06807`（106 cites）
  - OpenAI の推論モデルによる競プロ。**シンギュラリティバトルクエスト等を狙う本プロジェクトのベースライン水準。**
- **CodeGen: An Open LLM for Code with Multi-Turn Program Synthesis** — `arXiv:2203.13474`（1492 cites）— マルチターン生成の古典。

#### 進化・遺伝的最適化（→ README「遺伝子学習で最適化」「しきい値・遺伝子セッション」）
- **FunSearch: Mathematical discoveries from program search with large language models** — Romera-Paredes et al. 2023（964 cites）
  - LLM＋進化的探索（評価器でスコア→上位を交叉/変異）で新規プログラムを発見。**「遺伝子学習で戦略を最適化」の本命リファレンス。後継の AlphaEvolve も要追跡。**

#### フロー工学（→ README 5コード生成・6ベンチ）
- **Code Generation with AlphaCodium: From Prompt Engineering to Flow Engineering**（OSSは下記）
  - テストを軸にした反復フロー設計。**単発生成より「テストで回す」設計が効くという実証。**

---

### 2. 類似OSSプロジェクト（GitHub）

#### フロー/コード生成の中核
- **[Codium-ai/AlphaCodium](https://github.com/Codium-ai/AlphaCodium)** ⭐3,942 — 上記論文の公式実装。テスト駆動フローエンジニアリング。**6ベンチ/5生成のフロー設計をそのまま参考にできる。**

#### 自律コーディングハーネス（→ README 全体構造）
- **[coleam00/Linear-Coding-Agent-Harness](https://github.com/coleam00/Linear-Coding-Agent-Harness)** ⭐223 — 線形・長時間稼働の自律ハーネス。**「無限ループで回す」設計の実例。**
- **[ArtemisAI/SWE-Squad](https://github.com/ArtemisAI/SWE-Squad)** ⭐11 — Claude Code + A2A プロトコルで自己修復するSWEチーム。**マルチモデル協調の参考。**
- 多数の "two-agent pattern" ハーネス（scan→plan→code→validate→git-commit ループ）: `xukaifu/autonomous-harness`, `lk19940215/claude-coder`, `gost404-cmd/agent-harness-py` など。**「人間役を代替するClaude＋実装Claude」の2エージェント構成の既存パターン。**

#### 自己改善エージェント（→ README 自己改善ループ）
- **[faveos8758/reflexion-agent-ts](https://github.com/faveos8758/reflexion-agent-ts)** ⭐12 — Reflexion（評価器＋内省メモリ）の実装。**失敗検知→再試行ループの参考実装。**

#### 長時間稼働の安全装置（→ README「レートリミット/無限ループ」の運用）
- **[open-covenant/covenant](https://github.com/open-covenant/covenant)** ⭐7 — 長時間自律エージェント向けの capability ベース運用層（署名付き権限・追記専用監査ログ・fail-closed サンドボックス・provenance）。**「無限で回す」前提の暴走対策/監査として要検討。**

---

### 3. Taikai-killer 設計への示唆

| README セッション | 取り込み候補 |
|---|---|
| 全体ハーネス | DSPy（自己改善パイプラインのコンパイル）, two-agent harness パターン |
| 1 要件定義 | （手法は薄い領域。構造化JSON出力は自前設計でよい） |
| 2 外部知見 | （Scrapling/playwright-mcp は既選定。論文クロールは本issueの手法を流用可） |
| 3 戦略生成 | FunSearch（戦略の進化的探索）, Self-Organized Agents（並列大量生成） |
| 4 要件精緻化 | DSPy / Agentic Context Engineering（文脈の進化） |
| 5 コード生成 | CodeCoR, AlphaCodium（テスト駆動フロー）, AutoSafeCoder（堅牢化） |
| 6 ベンチ/閾値 | AlphaCodium のテスト軸 + FunSearch の評価器→交叉/変異（しきい値・遺伝子セッション） |
| 運用（無限ループ） | covenant（監査・サンドボックス・暴走対策） |

### 4. 次アクション案
- [ ] FunSearch / AlphaEvolve の評価器→交叉/変異ループを「3戦略」「6遺伝子セッション」のひな型に落とす
- [ ] AlphaCodium のフローを 5コード生成 のリファレンス実装として読む
- [ ] DSPy を `template.md`／自己改善プロンプトの実体として採用するか検討
- [ ] covenant の監査・サンドボックス設計を「無限ループ運用」の安全要件に反映
- [ ] 論文クロール（2外部知見）は Semantic Scholar API をフォールバック経路として正式採用（arXiv export は IP ブロックされうる）

---
*この調査は arXiv（Semantic Scholar 経由）と GitHub repo search の自動収集に基づく。引用数・スター数は調査時点。*
