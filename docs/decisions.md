# 設計判断 — 確定事項と固めるべき決定点

現時点の設計を「**確定（Locked）**」と「**要確定（Open＝固めるべき）**」に分けて整理する。
Open は実装着手前に決め切る必要がある順に並べた。各項目に推奨と理由を付す。

関連: [architecture.md](./architecture.md) / [execution-premise.md](./execution-premise.md) / Issue #1

---

## ✅ 確定事項（Locked）

| # | 決定 | 根拠 |
|---|---|---|
| L1 | 全体構造は **直列フェーズ S1..S6 ＋ 無限ループ**、1周 = 1 result | README / speca |
| L2 | フェーズ間は **中間 JSON で受け渡し**（全段で出力を残す） | README / speca |
| L3 | Orchestrator は **resume / circuit-breaker / cost-tracker / watchdog** を持つ | speca orchestrator |
| L4 | **マルチエージェント並列**（claude/gemini/codex/ollama/copilot） | README |
| L5 | 実行は **サンドボックス無効・マシン破壊前提**（使い捨てホスト） | execution-premise.md |
| L6 | 失敗は局所スキップ、**停止は予算上限とヒューマンレビューゲートのみ** | architecture.md |
| L7 | 発表資料生成は **presentation-agent（Slidev）** を参考に組み込む | Issue #1 |
| L8 | 戦略・閾値の最適化は **進化的探索（FunSearch 系）** を採用方針 | Issue #1 |

---

## 🔴 固めるべき決定点（Open）— 着手前に決める

### D1. 並行作業モデル：branch か フォルダか ★最優先
README で未決（「branch を切るか → project フォルダで管理か」）。**下流の全構造がここに依存**。
- **推奨: フォルダ構造（戦略ごとに `projects/<strategy_id>/` を切る）＋ 任意で git worktree**
- 理由: 戦略を大量並行生成・実装するため、branch 切替コストより**独立フォルダの方が並列に強い**。フォルダ構成は speca のように使い回しテンプレ化できる。git はスナップショット用途に留める。

### D2. フェーズ間 JSON 契約の厳密度と命名 ★最優先
`PhaseArtifact<T>` エンベロープ（architecture.md）を**正式スキーマとして固定**するか。
- **推奨: `schemas/` に JSON Schema を置き、CI/ランナーで検証必須にする（speca と同形式）**
- 理由: 型契約が緩いと resume・統廃合・人間差し替えが破綻する。命名 `<phase>_PARTIAL_W{w}B{b}_{ts}.json` を規約として確定。

### D3. ベンチマーク評価器の定義 ★最優先（README 最大の「未定」）
S6 が「未定・自動生成？」のまま。**スコア関数・閾値・遺伝子セッションの具体が無いと最適化ループが回らない**。
- **固めるべき**: ①スコアの定義（大会の採点 or 代理指標）②閾値の初期値と更新規則 ③遺伝子セッションの交叉/変異の対象（戦略 or プロンプト or パラメータ）④対照実験の比較単位
- **推奨: 最小版を先に固定** — 「テスト通過率＋実行時間」の単一スコア → FunSearch 流の評価器に差し込み、後から大会固有指標へ差し替え可能にする。

### D4. マルチエージェント抽象インターフェース ★高
claude/gemini/codex/ollama/copilot を**どう統一して呼ぶか**。
- **推奨: CLI + MCP の統一ワーカー IF（speca と同じく `claude` CLI 駆動を基準に、他モデルはアダプタで吸収）**
- 理由: API 直叩きはモデル差異・認証差異が漏れる。CLI/MCP 層で正規化し、dispatch を均質化。フォールバック順（落ちたら次モデル）も定義。

### D5. レート/コスト制御ポリシー ★高
- **固めるべき**: ①USD 予算上限（result 単位 / 日次）②ratelimit 復帰戦略（待機上限・指数バックオフ・モデル切替）③暴走停止条件
- **推奨: result 単位の上限を必須化**。超過時は result を保存して通知（E_COST）。

### D6. ヒューマンレビューゲートの実装 ★中
- **固めるべき**: STOP / 非STOP モードの切替、入力経路（Dashboard / Slack / Discord / issue）、`質問.json` の提示単位
- **推奨: 非同期承認** — STOP せず `質問.json` を Dashboard/bot に出し、回答が来たら resume で反映（README「後でも行える」に合致）。

### D7. 外部知見クロールのフォールバック確定 ★中
- **固めるべき**: Scrapling / playwright-mcp の役割分担、論文取得経路
- **推奨: 論文は Semantic Scholar API を一次経路に確定**（arXiv export は egress IP で 503 ブロック実績／Issue #1）。一般Webは Scrapling、JS必須サイトは playwright-mcp。

### D8. 実行ホストの再作成手段 ★中
- **固めるべき**: 使い捨てホストのプロバイダ・イメージ化（snapshot / cloud-init / Dockerfile）・resume 再投入手順
- **推奨: IaC 1コマンド再生成 ＋ result.json から resume** を破壊時の標準復旧フローに（execution-premise.md）。

---

## 着手順（依存関係）

```mermaid
flowchart LR
  D2[D2 JSON契約] --> D1[D1 フォルダ/並行]
  D2 --> D4[D4 エージェントIF]
  D2 --> D3[D3 評価器]
  D1 --> SKEL[骨組み: orchestrator + run_phase]
  D4 --> SKEL
  D3 --> S6IMPL[S6 ベンチ実装]
  SKEL --> S1IMPL[S1..S5 実装]
  D5 --> SKEL
  D6 -.後追い可.-> S1IMPL
  D7 -.後追い可.-> S1IMPL
  D8 -.運用前.-> RUN[本番ループ起動]
```

**最初に固める3点: D2(契約) → D1(フォルダ) → D3(評価器)。** ここが決まれば orchestrator 骨組みに着手できる。

---

## 次アクション
- [ ] D2: `schemas/` に `PhaseArtifact` ＋ 各 payload の JSON Schema を起こす
- [ ] D1: `projects/<strategy_id>/` テンプレ構成を確定
- [ ] D3: 最小スコア（テスト通過率＋実行時間）＋ 評価器 IF を定義
- [ ] D4: ワーカー dispatch アダプタ（CLI/MCP）とフォールバック順を定義
- [ ] speca orchestrator を fork/vendor して骨組みに流用（Issue #1）
