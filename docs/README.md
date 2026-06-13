# docs — 設計の単一ソース

Taikai-killer の**狙い・設計・確定事項はすべてこの `docs/` に集約**する。実装はここを正とする。

## 読む順番

1. [architecture.md](./architecture.md) — 全体アーキテクチャ（構成・mermaid設計図・データ契約・エラー経路）
2. [directory-structure.md](./directory-structure.md) — **確定したディレクトリ構成**（nyx speca / presentation-agent 準拠）
3. [decisions.md](./decisions.md) — 設計判断（確定 L1–L9 / D1–D8 ＋ ヒアリング確定表）。**何が決まり何が未決かの一覧**。D9–D21 の定義実体は Issue #2 にあり、確定はヒアリング確定表に集約
4. [steal-from-speca.md](./steal-from-speca.md) — speca md 精読で抽出した**流用パターン集**（A〜F）
4b. [integrations-issue1.md](./integrations-issue1.md) — Issue #1 の5 OSSレポを深掘り統合した記録（AlphaCodium/Linear/SWE-Squad/reflexion/covenant）。**D22 (S5=Reflexion) ほか**
4c. [mvp-vertical-slice.md](./mvp-vertical-slice.md) — **1大会で1result出す縦串MVP仕様**。レビュー指摘の致命的欠落8点（S5実行環境・テスト供給・コールドスタート・S1入力・通知・バックアップ・提出フロー・leaderboard）を全部埋めた
5. [troubleshooting.md](./troubleshooting.md) — 無限ループ運用の Runbook（4ステップ確認・終了コード）
6. [execution-premise.md](./execution-premise.md) — 実行前提（通常マシン・サンドボックス無効・隔離なし）
7. [quests.md](./quests.md) — **標準化AIフレームワーク（SBQ 横断ハーネス）**。QuestAdapter で 4 クエスト（X=7並べ/AI/Robo/Data）を 1 つの最適化器で攻略。**§4.3 横断汎化の実測 / §7.5–7.7 の 7並べ研究（自己対戦過適合→混合フィールド修正→over-engineering の負の結果）が競技戦略の正本**。
- [../CLAUDE.md](../CLAUDE.md) — エージェント共通指示（Key Design Decisions・命名規約・env）

## 関連 Issue（外部知見の調査結果）
- **#1** 先行研究・類似OSS（speca / presentation-agent / FunSearch ほか）
- **#2** 追加で固めるべき要件 D9–D21（他事例のベストプラクティス）

## 現在の確定状況（サマリ）— 2026-06-11 ヒアリングで大量確定
- **スタック**: TypeScript/Node 統一（Scrapling のみ Python サイドカー）。モデル= Claude+Gemini サブスク、CLI subprocess 駆動
- **実行前提**: 通常マシン・サンドボックス無効（隔離なし・使い捨てホスト撤回）
- ループ方針（L9）: S1=1回 / S2=最大4回・新規率<10%で早期終了 / S3–S6=レート枯渇まで
- D1 フォルダ / D2 契約 / D3 ルブリックはS1由来 / D4 CLI手動割当 / D5 無制限 / D6 非同期承認 / D7 Scrapling sidecar / D8 通常マシン / D9 イベントログ+replay / D10 冪等キー / D11 CB(5/20/3) / D17 学会フル
- D18 進化: まず単一プール、変異=戦略データ＋閾値のみ（prompt 静的）
- 縦串MVPの欠落8点を全部設計（[mvp-vertical-slice.md](./mvp-vertical-slice.md)）: S5実行環境/テスト供給3分類/コールドスタート/S1手書き入力/通知/バックアップ/提出フロー/leaderboard
- 残＝実装タスク（2026-06-13 時点）: 上記はすべて実装済み（orchestrator TS・schemas 実体・縦串MVP・dashboard-lite）。残るは **S2 クロール配線 / LLM 構造変異ループ（AI/Robo/X の approach 進化）/ PIMC の strategy-fusion バイアス解消（IS-MCTS 級）/ フェーズ別 model 切替の実運用** — いずれも MVP スコープ外の発展項目（[implementation-status.md](./implementation-status.md) §6・[quests.md](./quests.md) §4.2）

### 実装フェーズの到達点（2026-06-13 更新）
設計だけでなく **コードが動く段階に到達**している。詳細・正直版の棚卸しは [implementation-status.md](./implementation-status.md)。

- **CLI が実動**: `taikai probe`（claude 駆動確認）/ `taikai probe-gemini`（gemini 認証診断）/ `taikai run`（縦串 1 周 S3→S5→S6）/ `taikai doctor` / `taikai quest --quest xq|xq-mixed|ai|robo|data`（数値最適化・LLM不要）/ `taikai coevolve`（自己対戦＋Hall of Fame）/ `taikai loop`/`experiment`。
- **Issue #3 の AC は 6/6 全達成**（resume S3+S5 / E_TEST_TAMPER / D22 multi-attempt / result provenance を実 run で実証・§4 of implementation-status.md）。
- **テスト**: `npx vitest run` = **37 ファイル / 604 テスト 全 pass**（数値の正は implementation-status.md）。
- **標準化クエストフレームワークが実測で汎化**: AI/Robo/Data の数値最適化が held-out（別 seed）で改善を保つ（[quests.md](./quests.md) §4.3）。X（7並べ）は自己対戦が過適合→**混合フィールド最適化（`xq-mixed`）で解消**、現状最強は mixed_champ v1（§7.6/§7.7）。一貫原理: **fitness が真の目的と整合するほど汎化、狭い proxy は過適合**。
- **Gemini（D4 2モデル目）**: Windows spawn バグを修正し実発火可能に（認証段まで実機確認）。残るはユーザの認証設定（OAuth ログイン or `GOOGLE_GENAI_USE_GCA`）。MCP/ACP は認証を解決しない（[gemini-mcp.md](./gemini-mcp.md)）。
- **resume/idempotency 配線済み**（2026-06-13）: S3 段＋S5 attempt 段とも resume が動く（AC5 達成）。未配線で残るのは S2 クロールと LLM 構造変異ループ。動く/テストのみ/未配線の区別は implementation-status.md に従う。
