# dashboard/ の出自（vendored from speca）

このディレクトリは **[NyxFoundation/speca](https://github.com/NyxFoundation/speca) の `web/`**（MIT License）を取り込んだもの。
Taikai-killer の Web ダッシュボード（ヒューマンレビューゲート D6 / run 監視 / 結果可視化）の出発点として流用する。

- 取得元: `https://github.com/NyxFoundation/speca` → `web/`
- ライセンス: MIT（`LICENSE.speca` に原文を同梱）
- 取得日: 2026-06-11

## 構成（speca から継承）
- `server/` — FastAPI backend
  - `routers/`: `runs.py` / `runs_ws.py`(WebSocket) / `findings.py` / `chat.py` / `runtime.py` / `diagnostics.py` / `auth.py` / `integrations.py` / `picker.py`
  - `services/chat_runtime_*.py` — **マルチランタイム**（claude/codex/copilot/gemini/ollama）。D19/D4 の実装参考そのもの
  - `services/chat_approvals.py` — **承認フロー**（→ ヒューマンレビューゲート D6 に直結）
- `frontend/` — React + Vite SPA
  - `src/features/`: `runs` / `findings` / `chat` / `diagnostics` / `settings` / `picker` / `onboarding` / `auth`
  - `src/components/`: AppShell / ConfirmDialog / ErrorModal / ShortcutsHelp / ThemeToggle / OpenInVSCode ほか

## Taikai-killer 向けに差し替える点（TODO）
- `findings`（脆弱性監査findings）→ **`results`（大会 result.json / 戦略ランキング）** にドメイン置換
- `bounty_scope` サービス → **`tournament` スコープ**（`TOURNAMENT_INFO.json` / `SCORING_RUBRIC.json`）に置換
- `runs` 監視は流用（S1..S6 フェーズ進捗・partial・event ログ表示に対応づけ）
- 承認フロー（chat_approvals / ApprovalCard）は **`質問.json` の非同期承認**（D6）に流用
- Slack/Discord bot 連携は `integrations` を拡張
- backend は `orchestrator/`（speca fork）と接続（run state / event ログを読む）

> 起動方法は `README.md`（speca由来）参照。現状は **vendor したスケルトン**で、上記ドメイン置換と orchestrator 接続を行うまでは speca 文脈のまま。
