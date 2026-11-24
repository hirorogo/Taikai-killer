## 🧭 追加で固めるべき要件 — 他事例のベストプラクティス調査

既存 issue #1（先行研究・類似OSS）と `docs/decisions.md`（D1〜D8）の**漏れ**を、実在の自律ハーネス／eval／進化探索フレームワークから収集した。サブエージェント3並列で領域別に調査。
**【確認】= 出典のURL/コードに明記**、**【推測】= Taikai-killer への当てはめ判断**。既出の D1〜D8 と L9（ループ方針）は除外。

> 調査領域: ①長時間稼働ハーネス運用 ②eval/再現性/進化的最適化 ③マルチモデル・プロンプト・コスト

---

### ⭐ 最重要 TOP3（先に潰すべき落とし穴）

1. **スコア関数のハック耐性（報酬ハッキング）** — 2026-02 に **SWE-bench Verified が実質崩壊**。監査で **59.4%** の問題が「機能的に正しい解を不当に却下するテスト設計欠陥」（狭すぎ35.5%／広すぎ18.8%）。【確認: [OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)】
   → 大会勝利が目的＝**報酬ハッキング誘因が最大**。S6 スコア関数を「機能的に観測可能な振る舞い」で定義し、特定実装を強制しない／同スコアなら単純解優先／**別エージェント＋人手でレビューしてから凍結**／held-out 検証。**「評価器・テストを書き換えて勝つ」自己欺瞞を契約レベルで禁止**。

2. **マルチエージェントは ~15倍課金、トークンが性能分散の80%を説明** 【確認: [Anthropic multi-agent](https://www.anthropic.com/engineering/multi-agent-research-system)】
   → 「レート枯渇まで無限ループ」は**15倍前提**。フェーズ価値でマルチエージェント発動を gate、**prompt caching 必須**（実績59〜70%削減）、ハードバジェットで強制終了。

3. **停滞検知の具体閾値が既に実在する**（OpenHands Stuck Detector）【確認: [docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector) / [code](https://github.com/OpenHands/OpenHands/blob/main/openhands/controller/stuck.py)】
   → 同一action→同一obs **4回**／同一action→error **3回**／独白 **3連続**／交替pattern **6サイクル**／context窓エラー反復、で自動停止。**「正当な長時間待機（ベンチ実行中）を停滞と誤殺しない除外窓」を必ず併設**（誤kill バグ実例あり）。

---

### D9. 状態モデル：中間JSONスナップショット vs append-only イベントログ
- 【確認】Anthropic は agent を **session（append-only ログ）/ harness / sandbox** に三分割、`wake(sessionId)`→イベント replay で再開（[managed-agents](https://www.anthropic.com/engineering/managed-agents)）。OpenHands も append-only EventLog + replay（[SDK論文](https://arxiv.org/html/2511.03690v1)）。
- **固める**: resume の単位を「最後の完了フェーズ」か「最後のイベント」か。無限ループで中間JSONが巨大化するため **追記専用イベント＋小さなメタファイルの二層**が有利【推測】。

### D10. 冪等キーと実行済みマーカー（二重課金・二重送信防止）
- 【確認】`hash(prompt+model+params+phase)` の **content-derived idempotency key** で重複排除＝**二重課金防止 + dedup + prompt caching を同一キーで統合**（[Redis](https://redis.io/blog/what-is-idempotency-in-redis/)他）。resume 時は履歴に結果がある呼び出しを再実行しない。
- **固める**: 外部送信・課金API・クロール・publish に冪等キー必須。サンドボックス無効・使い捨てでも**外部に副作用が漏れる操作だけは冪等化**。（※OpenAI/Anthropic 公式 Idempotency ヘッダ仕様は要追加確認）

### D11. 暴走対策＝stuck検知＋circuit-breaker の条件と復帰
- 【確認】SWE-Squad: **失敗率80%で trip / 30分pause**、**チケットあたり最大3試行で HITL エスカレーション**、Stability Gate（赤いうちは新規作業block）、heartbeat 5分（[SWE-Squad](https://github.com/ArtemisAI/SWE-Squad)）。出力**schema検証の3連続失敗で fallback モデルに切替**。
- **固める**: 「レート枯渇まで無限」なので breaker は **連続失敗／無進捗時間／コスト** でトリップ（レート系は待機・別枠）。フェーズ最大リトライ（例3）、開後の挙動（pause / モデルエスカレーション / 縮退）。

### D12. baseline 緑ゲート + 自動 revert + 報酬ハック禁止
- 【確認】SWE-Squad/Anthropic: 各試行を隔離ブランチで、**テスト失敗＝`git reset --hard` 自動revert、壊れたコードを main に到達させない**。「テストを消す/編集するのは不許可」。
- **固める**: baseline は緑のときだけ進める／赤は自動revert。**評価器・テスト改ざんの契約レベル禁止**（TOP3-①と一体）。

### D13. 並列ワーカーの worktree 分離 + `.git` 書込直列化
- 【確認】worktree は FS 分離を与えるが、**N並列commitで `.git/index.lock` 競合は不可避**、auto-cleanup で未マージ作業が消える実例（[Claude Code #55724](https://github.com/anthropics/claude-code/issues/55724)）。ポート/DB 衝突も既知。
- **固める**（D1の具体化）: index.lock の retry-backoff 層、未マージ worktree を消さないガード、共有`.git` commit を直列化するミューテックス、ワーカー毎にポート/DB/tmp の名前空間分離。

### D14. エージェント間プロトコル（A2A）の状態語彙とフォールバックチェーン
- 【確認】A2A: タスク状態機械 **submitted/working/input-required/completed/failed/canceled**、一時失敗 vs 恒久失敗 + `Retry-After`、client が retry→別エージェント→縮退を判断（[A2A spec](https://a2a-protocol.org/latest/specification/)）。
- **固める**（D4の具体化）: JSON契約に状態語彙と「一時/恒久失敗」フィールドを採用、**retry→別ワーカー→graceful degrade** を明文化。委譲は「orchestratorのツール呼び出し」として実装しコアを薄く。

### D15. 観測の最小契約（trajectory 監査）
- 【確認】OpenHands/SWE-agent は全 (thought, action, observation) を immutable な trajectory（`<id>.traj`）に保存（[SWE-agent](https://swe-agent.com/latest/usage/trajectories/)）。Anthropic は `claude-progress.txt` + 構造化feature list、ループ開始時に git log/progress を読んで自己ブリーフィング。
- **固める**: 各ワーカー出力を **agent_id 付き trajectory** として独立保存し「誰が何を根拠に何を決めたか」を監査可能に。ループ開始時の自己ブリーフィングを必須化。

### D16. secret の redact / context 圧縮の二層化
- 【確認】OpenHands は state シリアライズ時に secret を redact/暗号化。無限ループの履歴膨張には **要約圧縮（LLMSummarizingCondenser でコスト約半減・性能維持）**＋完全イベントログ別途保持。
- **固める**: 中間JSON・ログの認証情報 redact 方針。context は要約圧縮しつつ生ログは別保全。

---

### D17. eval ハーネスの再現性（学術目標の核）
- 【確認】[lm-eval-harness lessons (2405.14782)](https://arxiv.org/pdf/2405.14782): プロンプトは**タスク名でなく完全テンプレート（doc_to_text等）をYAMLで**共有、出力に version+commit hash、**不確実性（標準誤差/CI）を必ず併記**、N-gram でデータ汚染検査。[HELM](https://crfm.stanford.edu/helm/) は raw prompt+completion を全公開・多次元メトリクス。[NeurIPS checklist](https://neurips.cc/Conferences/2022/PaperInformation/PaperChecklist)。
- 【確認】**LLM API は seed 固定でも bit再現不可**（[CodeEvolve](https://arxiv.org/html/2510.14150v2)）→ 再現性は「**統計的再現（複数seedの分布一致）**」で定義し、ログからの決定的 replay を別途用意。
- **固める**（D3の具体化）: 実行マニフェストに model完全ID/temp/top_p/seed/dataset_version/harness_commit/prompt_hash。スコアは `mean ± stderr (n≥3)`、閾値判定は**点でなくCI**（下側CI > ベースライン上側CI）。評価ランナーをコンテナ化し依存pin。

### D18. 進化的最適化（遺伝子セッション）の実ハイパラ
- 【確認】[FunSearch OSS](https://github.com/google-deepmind/funsearch) 実コード値: **island=10**、4時間ごと下位半分リセット、prompt に過去2解を inspiration、評価器:サンプラ=**140:15**（評価器を多めに並列）、**スコアsignatureでクラスタ化し同スコアなら短い解を優遇**。
- 【確認】[AlphaEvolve](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/): MAP-Elites+island、**評価カスケード**（難易度昇順で弱い解を早期足切り＝予算集中）、**LLMアンサンブル**（Flash広探索+Pro深掘り）、diff編集、複数seed集約（最良rank＋到達率）。
- 【確認】[CodeEvolve](https://github.com/inter-co/science-codeevolve): 5島ring、40epochで上位10%移住（origin1回のみ）、crossoverは初回移住後に解禁、`p_explore=0.3`、Flash80%/Pro20%、リソース超過解はfitness=0。
- **固める**（D3/L8の具体化）: island model（島5〜10、定期下位リセット、signatureクラスタ化、同スコア単純解優先、移住制御、crossover遅延）、評価カスケード、探索/深掘りLLMアンサンブル、改変はdiff形式、スコアは複数seed集約。**初期ハイパラは上記の実値を出発点に流用可**。

---

### D19. マルチモデル抽象 = 統一クライアント層に一本化
- 【確認】[LiteLLM Router](https://docs.litellm.ai/docs/routing): 100+ LLM を OpenAI形式で統一、順序付きフォールバック、cost-based/latency ルーティング、エラー種別 RetryPolicy、cooldown。
- **固める**（D4の具体化）: **LLM直叩き禁止→統一層に一本化**（二重抽象禁止）。フォールバック順を宣言（`claude→gemini→codex→ollama`）、認証失敗=即停止/レート=retry+cooldown、フェーズ別 routing_group（設計=高品質、量産=cost-based）。

### D20. プロンプト/template.md のイミュータブル版管理
- 【確認】プロンプトはコードから分離しレジストリへ、**イミュータブル版管理**（版ID・diff・timestamp・環境エイリアス）、placeholder で文体ルールと可変文脈を分離、新版は評価で quality gate してから昇格（[MLflow prompt registry](https://mlflow.org/prompt-registry)）。精度クリティカルは [DSPy](https://dspy.ai/) でコンパイル化。
- **固める**: `template.md` を版管理し、**版IDを中間JSON契約・実行ログに必須記録**（どの版で生成したか追跡）。自己改善出力は新版追記（旧版破壊禁止）。

### D21. 協調パターンの選択（採用しないものを決める）
- 【確認】本番の約70%が orchestrator-worker。**debate/blackboard/swarm は終了保証・監査が困難で大会ハーネス不向き**（[taxonomy](https://www.digitalapplied.com/blog/agent-architecture-patterns-taxonomy-2026)）。Anthropic 5パターン（chaining/routing/parallelization(sectioning,voting)/orchestrator-workers/evaluator-optimizer）。
- **固める**: 主軸=**orchestrator-worker**、自己改善=**evaluator-optimizer** の2本柱。**debate/blackboard/swarm は不採用**。dispatch は重複しない明示スコープを渡し dedup をプロンプト設計で予防。

---

### 追加決定点サマリ（D9–D21）
| # | 決定点 | 既存との関係 |
|---|---|---|
| D9 | 状態モデル（イベントログ+replay の二層化） | 新規 |
| D10 | 冪等キー（二重課金/送信防止・dedup・cache統合） | 新規 |
| D11 | stuck検知＋breakerの条件/復帰（実閾値あり） | L6拡張 |
| D12 | baseline緑ゲート+自動revert+報酬ハック禁止 | 新規・最重要 |
| D13 | worktree分離+`.git`直列化+名前空間分離 | D1具体化 |
| D14 | A2A状態語彙+フォールバックチェーン | D4具体化 |
| D15 | trajectory監査+自己ブリーフィング | 新規 |
| D16 | secret redact+context圧縮二層 | 新規 |
| D17 | eval再現性（CI報告/統計的再現/汚染検査） | D3具体化 |
| D18 | 進化的最適化の実ハイパラ（island等） | D3/L8具体化 |
| D19 | マルチモデル統一層一本化 | D4具体化 |
| D20 | template.mdイミュータブル版管理 | 新規 |
| D21 | 協調パターン選択（debate等不採用） | 新規 |

**推奨着手順**: TOP3（報酬ハッキング耐性・コスト15倍/caching・stuck検知）→ D10冪等キー → D9状態モデル → D17/D18（S6・最適化の核） の順で固めると、無限ループの安全性と学術再現性が同時に立つ。

---
*GitHub `gh` + Web 調査（サブエージェント3並列）。確認済みURLのみ記載、推測は明記。詳細な一次ソースは各項リンク参照。関連: #1 / `docs/decisions.md`*
