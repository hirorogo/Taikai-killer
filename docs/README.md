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
- [../CLAUDE.md](../CLAUDE.md) — エージェント共通指示（Key Design Decisions・命名規約・env）

## 関連 Issue（外部知見の調査結果）
- **#1** 先行研究・類似OSS（speca / presentation-agent / FunSearch ほか）
- **#2** 追加で固めるべき要件 D9–D21（他事例のベストプラクティス）

## 現在の確定状況（サマリ）— 2026-06-11 ヒアリングで大量確定
- ✅ **スタック**: TypeScript/Node 統一（Scrapling のみ Python サイドカー）。モデル= Claude+Gemini サブスク、CLI subprocess 駆動
- ✅ **実行前提**: 通常マシン・サンドボックス無効（隔離なし・使い捨てホスト撤回）
- ✅ ループ方針（L9）: S1=1回 / S2=最大4回・新規率<10%で早期終了 / S3–S6=レート枯渇まで
- ✅ D1 フォルダ / D2 契約 / D3 ルブリックはS1由来 / D4 CLI手動割当 / D5 無制限 / D6 非同期承認 / D7 Scrapling sidecar / D8 通常マシン / D9 イベントログ+replay / D10 冪等キー / D11 CB(5/20/3) / D17 学会フル
- ✅ D18 進化: まず単一プール、変異=戦略データ＋閾値のみ（prompt 静的）
- ✅ 縦串MVPの欠落8点を全部設計（[mvp-vertical-slice.md](./mvp-vertical-slice.md)）: S5実行環境/テスト供給3分類/コールドスタート/S1手書き入力/通知/バックアップ/提出フロー/leaderboard
- 🔧 残＝実装タスク: `orchestrator/`(TS)移植 ＋ `schemas/*.json` 実体化 ＋ 縦串MVPのコード化 ＋ dashboard server の TS 書換

### 実装フェーズの到達点（2026-06-11 実測）
設計だけでなく **コードが動く段階に到達**している。詳細・正直版の棚卸しは [implementation-status.md](./implementation-status.md)。

- ✅ **CLI が実動**: `taikai probe`（claude CLI 駆動確認）/ `taikai run`（縦串 1 周 S3→S5→S6）/ `taikai doctor`（起動前バリデータ）/ `taikai evolve`（D18① じゃんけん数値進化デモ）。
- ✅ **縦串MVP が `result.json` を実生成**: test型（fizzbuzz）と battle型（janken）の両方が `taikai run` で `outputs/` に成果物を出した実績あり（`dev-run`/`fbp-run`/`janken-run`）。
- ✅ **テスト**: `npx vitest run` = **25 ファイル / 333 テスト 全 pass**（純ロジックの vitest。LLM 発火・spawn 層はテスト外）。
- ✅ **dashboard-lite**: outputs/leaderboard を read-only 提供する TS サーバを実装済み（runner とは別プロセス、実起動は未検証）。
- ⚠️ **ただし MVP スコープ**: runner に配線済みは S3→S5→S6 の最小経路のみ。**S2 / `resume.ts`・`idempotencyStore.ts` モジュール / archiver / 進化ループ / Gemini 2モデル目 は実装＋テスト緑だが runner 未配線**。resume は S3 段だけ runner の inline `loadExistingS3()` で動く（AC5 ⚠部分。未配線は S5 attempt 単位 resume と idempotency 二重実行ガード）。誇張せず、動く/テストのみ/未配線の区別は implementation-status.md に従う。
