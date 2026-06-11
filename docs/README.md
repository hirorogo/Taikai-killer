# docs — 設計の単一ソース

Taikai-killer の**狙い・設計・確定事項はすべてこの `docs/` に集約**する。実装はここを正とする。

## 読む順番

1. [architecture.md](./architecture.md) — 全体アーキテクチャ（構成・mermaid設計図・データ契約・エラー経路）
2. [directory-structure.md](./directory-structure.md) — **確定したディレクトリ構成**（nyx speca / presentation-agent 準拠）
3. [decisions.md](./decisions.md) — 設計判断（確定 L1–L9 / 要確定 D1–D21）。**何が決まり何が未決かの一覧**
4. [steal-from-speca.md](./steal-from-speca.md) — speca md 精読で抽出した**流用パターン集**（A〜F）
5. [troubleshooting.md](./troubleshooting.md) — 無限ループ運用の Runbook（4ステップ確認・終了コード）
6. [execution-premise.md](./execution-premise.md) — 実行前提（サンドボックス無効・マシン破壊前提）
- [../CLAUDE.md](../CLAUDE.md) — エージェント共通指示（Key Design Decisions・命名規約・env）

## 関連 Issue（外部知見の調査結果）
- **#1** 先行研究・類似OSS（speca / presentation-agent / FunSearch ほか）
- **#2** 追加で固めるべき要件 D9–D21（他事例のベストプラクティス）

## 現在の確定状況（サマリ）
- ✅ ループ方針（L9）: S1=1回 / S2=最大4回・収束で早期終了 / S3–S6=レート枯渇まで
- ✅ D1 並行モデル: `projects/<strategy_id>/` フォルダ（branch不使用）
- ✅ D2 フェーズ契約: `schemas/` 3+1層（speca同型）＋命名規約
- ✅ D5 コスト制御: **デフォルト無制限**、`budget_usd` 指定時のみ強制終了。暴走は CB で停止
- 🔴 次に固める: D3 評価器 / D18 進化ハイパラ / D10 冪等キー / D9 状態モデル（#2参照）
- 🔧 実装着手可: `orchestrator/` 骨組み（speca fork）＋ `schemas/*.json` 起こし
