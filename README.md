<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Orchestrator-3178c6?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Python-Crawl_Sidecar-3776ab?logo=python&logoColor=white" alt="Python sidecar">
  <img src="https://img.shields.io/badge/Claude-CLI-d97757?logo=anthropic&logoColor=white" alt="Claude CLI">
  <img src="https://img.shields.io/badge/Gemini-CLI-4285f4?logo=google&logoColor=white" alt="Gemini CLI">
  <img src="https://img.shields.io/badge/status-design_phase-yellow" alt="Design phase">
</p>

<h1 align="center">Taikai-killer</h1>

<p align="center">
  <strong>大会で勝つために、寝ている間も戦略を進化させ続ける自律 AI ハーネス</strong>
</p>

<p align="center">
  大会要項を渡すと、要件抽出 → 外部知見収集 → 戦略立案 → コード生成 → 評価 を<br>
  レート枯渇まで無限ループで回し、結果をフィードバックに戦略を世代交代させ続ける。
</p>

<p align="center">
  Built on
  <a href="https://github.com/NyxFoundation/speca">speca</a> (orchestrator) &bull;
  <a href="https://github.com/Codium-ai/AlphaCodium">AlphaCodium</a> (test-anchored flow) &bull;
  <a href="https://github.com/faveos8758/reflexion-agent-ts">Reflexion</a> (self-improve) &bull;
  <a href="https://github.com/google-deepmind/funsearch">FunSearch</a> (evolution)
</p>

> [!NOTE]
> **これは設計フェーズのリポジトリです。** 実装の正は [`docs/`](./docs/README.md)、確定事項は [docs/decisions.md](./docs/decisions.md)。
> シンギュラリティバトルクエスト＋ハッカソンを狙う。前提リスク（出場資格 R1・サブスク自動化規約 R2・全自動提出 R3・通常マシン実行 R4）は[受任済み](./docs/decisions.md)。

---

## Overview

Taikai-killer は**1回だけのブートストラップ S1 ＋ 無限ループ S2〜S6** で動く自律パイプライン：

1. **S1 要件定義** — 大会ルールを抽出し、評価指標 `SCORING_RUBRIC.json` を**大会から導出**（一度きり）
2. **S2 外部知見** — 検索ワード生成 → クロール（論文は Semantic Scholar API）。最大4回 or 新規率<10%で早期終了
3. **S3 戦略生成** — 要件・知見・論文・ライバル予測から戦略を大量生成
4. **S4 要件精緻化** — 戦略ごとに要件を詰める
5. **S5 コード生成** — 戦略を実装し、テストを通すまで自己改善（Reflexion ループ）
6. **S6 ベンチマーク** — ルブリックで採点 → `result.json`。これを S2 に再投入して次の周回へ

1周 = 1 result。`result.json` をフィードバックに戦略を進化させ、レート枯渇まで回り続ける。

### 構成（2 codebase ＋ サイドカー）

| レイヤ | 言語 | 役割 |
|---|---|---|
| **Orchestrator** | TypeScript | フェーズ実行・並列ワーカー・resume・暴走/コスト制御（speca を移植） |
| **Dashboard** | TypeScript (React/Vite) | run 監視・結果可視化・ヒューマンレビュー承認（speca web/ を vendor） |
| **Crawl sidecar** | Python | Scrapling による外部知見クロール（TS から subprocess） |

### Key Capabilities

- **サブスク CLI 駆動** — Claude / Gemini の CLI を subprocess で叩く（従量課金なし）。フェーズ×モデルは config で指定
- **Partial = 唯一の真実源** — フェーズ間は中間 JSON 契約。Resume はディレクトリ glob だけ（状態 DB を持たない）
- **来歴(provenance)チェーン** — 全レコードが親 ID と元ソースを持ち、`result.json` から大会ルールまで JSON だけで遡れる
- **安全ガード（隔離の代わり）** — Circuit Breaker（`recordSkip` で待機を失敗に数えない）・2段自己修復（LLM cooldown）・コスト追跡
- **自己改善（D22 Reflexion）** — execute → evaluate → reflect → retry。テストアンカー回帰ガードで単調改善を強制
- **2トラック進化** — 数値（閾値/パラメータ）は LLM 不要のコードで最適化、構造（approach）は LLM が変異
- **学術的再現性** — 全 prompt/schema/親 partial の hash を固定、手続き的再現を担保

---

## Architecture

```mermaid
flowchart TD
    subgraph ctrl [" Orchestrator (TypeScript) "]
        Runner["Phase Runner\nrunPhase.ts"]
        CB["Circuit Breaker\nrecordResult / recordSkip"]
        WD["Watchdog\nTier1 機械修復 / Tier2 LLM"]
        Resume["Resume\npartial glob スキャン"]
        Runner --- CB & WD & Resume
    end

    subgraph boot [" Bootstrap (1回のみ) "]
        S1["S1 要件定義\n→ SCORING_RUBRIC.json"]
    end

    subgraph loop [" Infinite Loop — rate枯渇まで (S2..S6) "]
        S2["S2 外部知見"] --> S3["S3 戦略生成"] --> S4["S4 要件精緻化"] --> S5["S5 コード生成\nReflexion ループ"] --> S6["S6 ベンチマーク"]
        S6 -->|"result.json 再投入"| S2
    end
    S1 --> S2

    subgraph agents [" Models (CLI subprocess) "]
        Claude["Claude CLI"]
        Gemini["Gemini CLI"]
    end

    subgraph io [" State / IO "]
        Store[("outputs/{run}/\npartials + events + result")]
        Dash["Dashboard\nレビュー承認 / 通知"]
    end

    Runner -->|"初回起動"| boot
    Runner -->|"フェーズ起動"| loop
    loop <-->|"dispatch"| agents
    loop <-->|"read/write"| Store
    S1 -.->|"質問.json"| Dash

    classDef ctrlNode fill:#6366f1,stroke:#4338ca,color:#fff,stroke-width:2px
    classDef bootNode fill:#f59e0b,stroke:#d97706,color:#fff,stroke-width:2px
    classDef loopNode fill:#3b82f6,stroke:#2563eb,color:#fff,stroke-width:1.5px
    classDef agentNode fill:#ef4444,stroke:#dc2626,color:#fff,stroke-width:1.5px
    classDef ioNode fill:#10b981,stroke:#059669,color:#fff,stroke-width:2px
    classDef box fill:transparent,stroke:#e5e7eb,stroke-width:1px,color:#6b7280

    class Runner,CB,WD,Resume ctrlNode
    class S1 bootNode
    class S2,S3,S4,S5,S6 loopNode
    class Claude,Gemini agentNode
    class Store,Dash ioNode
    class ctrl,boot,loop,agents,io box
```

### セッションの進み方

```
S1(一度きり) ─▶ S2 ─▶ S3 ─▶ S4 ─▶ S5 ─▶ S6 ─▶ result.json ─┐
                ▲                                              │
                └──────────── 次の周回へ再投入 ────────────────┘
```

各周回は前回 `result.json` を見て前進：高得点の戦略を残し、進化させ、統合する。停止はレート枯渇・予算上限・暴走停止(CB)・ヒューマンレビューのみ。

---

## How the S5 Self-Improve Loop Works（D22 Reflexion）

```mermaid
flowchart TD
    Start(["戦略を実装"]):::startNode --> Gen["execute\nCLI でコード生成"]:::genNode
    Gen --> Test{"テスト\n通過?"}:::testNode
    Test -->|"通過"| Anchor["既通過テストを再実行\n(回帰ガード)"]:::okNode
    Anchor -->|"退行なし"| Done(["success\nresult.json へ"]):::doneNode
    Anchor -->|"退行した"| Revert["直前解に revert\n単調改善を強制"]:::revertNode
    Test -->|"不通過"| Reflect["reflect\n失敗理由→改善指示"]:::reflectNode
    Revert --> Reflect
    Reflect --> Cap{"maxAttempts\n到達?"}:::capNode
    Cap -->|"未到達"| Gen
    Cap -->|"到達"| Best(["best-so-far を返す\n(recordSkip)"]):::bestNode

    classDef startNode fill:#6366f1,stroke:#4338ca,color:#fff
    classDef genNode fill:#3b82f6,stroke:#2563eb,color:#fff
    classDef testNode fill:#f59e0b,stroke:#d97706,color:#fff
    classDef okNode fill:#10b981,stroke:#059669,color:#fff
    classDef reflectNode fill:#8b5cf6,stroke:#7c3aed,color:#fff
    classDef revertNode fill:#ef4444,stroke:#dc2626,color:#fff
    classDef capNode fill:#f59e0b,stroke:#d97706,color:#fff
    classDef doneNode fill:#059669,stroke:#047857,color:#fff
    classDef bestNode fill:#6b7280,stroke:#4b5563,color:#fff
```

- **失敗理由を全文注入**して再生成（盲目的リトライ禁止）。修正は構造化出力で受け `tsc --noEmit` 検証
- **テストを書く者 ≠ コードを書く者**。テストは S5 開始時に sha256 凍結、S6 が再ハッシュ検証（報酬ハック対策）

---

## Status / Roadmap

- ✅ **設計確定**：パイプライン全体・データ契約・オーケストレータ・受任リスク（[decisions.md](./docs/decisions.md)）
- ✅ **縦串MVP仕様**：1大会で1result出す最小経路を定義（[mvp-vertical-slice.md](./docs/mvp-vertical-slice.md)）
- 🔧 **実装中（未）**：`orchestrator/` TS 移植・`schemas/*.json` 実体化・縦串のコード化・dashboard server の TS 化
- 🔜 **次スコープ**：進化(island)・監査ハッシュチェーン・提出物 attestation・presentation 生成

## Docs

| ドキュメント | 内容 |
|---|---|
| [docs/README.md](./docs/README.md) | 設計の単一ソース・目次 |
| [architecture.md](./docs/architecture.md) | 全体図・データ契約・エラー経路 |
| [directory-structure.md](./docs/directory-structure.md) | 確定ディレクトリ構成 |
| [decisions.md](./docs/decisions.md) | 設計判断（L1-L9 / D1-D22 / 受任リスク R1-R4） |
| [mvp-vertical-slice.md](./docs/mvp-vertical-slice.md) | 縦串MVP仕様（致命的欠落を全部埋めた） |
| [steal-from-speca.md](./docs/steal-from-speca.md) / [integrations-issue1.md](./docs/integrations-issue1.md) | 外部OSSからの流用パターン |
| [execution-premise.md](./docs/execution-premise.md) / [troubleshooting.md](./docs/troubleshooting.md) | 実行前提・運用 Runbook |

---

<p align="center"><sub>設計の正は <code>docs/</code>。本 README は概観であり、矛盾時は docs/decisions.md を優先。</sub></p>
