# Issue #1 OSS レポ統合記録

Issue #1 の5 OSS レポを**深掘り→客観レビュー→自己改善ループ**（サブエージェント・オーケストレーション）で処理し、既存アーキテクチャへ統合した結果。
各パターンは「実物コードを読んだ事実ベース」で、確定制約（TS/Node・Claude+Gemini CLI subprocess・通常マシン・MVP優先・受任リスク R1-R4）に適合するものだけを採用。

> レビュー通過スコア: AlphaCodium 78 / Linear 78(good) / SWE-Squad 82(good) / reflexion 82(good) / covenant 86(good)
> **MVP（1大会で1result出す縦串）に乗るもの**＝本コミットで既存docへ反映。**次スコープ**＝本ファイルに記録して後続で着手。

---

## 1. Codium-ai/AlphaCodium — test-anchored flow（S5/S6）

> フロー設計のみ流用可。LLMドライバ層（litellm/従量API/temperature）は CLI subprocess(D4) と非互換で流用不可。

### MVP 反映
- **テストアンカー回帰ガード**：修正適用後は既通過 `passed_anchor_ids` を必ず再実行し、退行したら直前解に revert＝**単調改善を強制**。作業状態は実行中 in-memory、各 attempt 確定時に partial を append-write、**resume 時のみ glob 再構築**（D9 を満たしつつ S5 速度を殺さない）。→ `architecture.md` E_CODE_TEST ＋ データ契約 `CodeAttempt`/`CodegenResult`。
- **analyze→fix 構造化修正**：自己改善プロンプトに**失敗テストの input/expected/actual を全文注入**し、構造化出力(JSON `fixed_code`)で受け、`tsc --noEmit`/esbuild parse で構文検証してから採用。盲目的再生成でない（steal A-1 の具体化）。→ `CLAUDE.md`。
- **ステージ別キャップ（config駆動）**：1コード生成試行内は有限回で打ち切り **best-so-far を返す**（CB の failures に非加算＝E_RATELIMIT と同類）。ただし `newly_passed` 空（無進捗）の打ち切り連続は **D5③ stall としてカウント**（best-so-far 素通りで stall を検知できない抜け穴を塞ぐ）。数値は config 駆動でハードコードしない。

### 次スコープ（backlog）
- graded distance（d_tot で best-so-far／S6 順位補助）。MVP は `BenchResult.distance?` の型予約のみ。
- public-anchor AI テストのドリフト検知（公式テストが薄い大会向け）。
- 候補解ローテーション（S5 が S3 戦略の次点に切替＝複数戦略/進化 D18 段で）。

---

## 2. coleam00/Linear-Coding-Agent-Harness — 運用規律（CLAUDE.md）

> 骨格（並列フェーズ・JSON契約・CB・resume）は speca が上位互換で既出＝流用不可。純増分は**worker プロンプトの運用規律**のみ。Linear/Agent SDK in-process/OSサンドボックス前提は確定制約と衝突。

### MVP 反映（CLAUDE.md に散文追記のみ・新規型なし）
- **worker は毎起動 fresh context 前提**：`<task>` 冒頭で `TOURNAMENT_INFO`/`SCORING_RUBRIC` と自フェーズ partial を再読し自己オリエンテーション（partial-first B-1/C-2/D10 の運用面の言語化）。
- **クリーンハンドオフ（golden rule）**：**1 worker 起動 = 最大1項目**。context を使い切る前に必ず partial を確定して終了。途中で次項目に着手しない（中途半端に進めて context 切れで失うより綺麗に partial を残す）。

### 次スコープ
- bash コマンド粒度の fail-safe allowlist → steal C-3「集中力ガード」の追補（多戦略並行で脱線が実害化したら着手）。
- verify-before-new-work 回帰ゲート（多戦略を継続生成する段階で）。

---

## 3. ArtemisAI/SWE-Squad — CB/フォールバック/自己修復

> SWE-Squad も claude CLI を subprocess で叩いており Taikai と相性良い。Supabase常駐DB・GitHub issue常駐ループ・SSH fleet は流用不可。

### MVP 反映
- **recordSkip**：CB は `recordResult(ok)` と別に **`recordSkip(reason)`** を持つ。E_RATELIMIT・冪等キーhit・親partial欠落の局所スキップは全て recordSkip 扱いで**失敗率に加算しない**（death spiral 回避）。→ `architecture.md` CB節 ＋ `decisions.md` D11。
- **OutcomeTracker（agent別ヘルス）**：LLM判断でなく**コードレベル統計**でフォールバック判定。各 CLI dispatch 直後に `record({phase,agent,success,emptyResult,durationMs,error})`、agent ごと `consecutiveFailures>=3` で `isAgentHealthy=false`→そのフェーズの dispatch 対象から外し残モデルへ。状態は `outputs/{run}/AGENT_HEALTH.json`（状態DB禁止と整合）。→ `decisions.md` D4。
- **空出力を exit 0 でも失敗扱い**：returncode 0 でも「stdout 実質空＋成果物未生成」を E_LLM_COMM 失敗とし `consecutive_empty_results` を+1。サブスクCLIはエラー時も0で空を返すことがある。→ `architecture.md` E_LLM_COMM。
- **2段自己修復 + LLM cooldown ロック**：watchdog を Tier1（LLM無しの機械修復＝orphan reconcile/stall kill→resume/破損partial rm）→ Tier2（直らない時のみ LLM 自己改善）に分け、**Tier2 の LLM 呼び出しは cooldown ロック必須**（`.taikai/locks/self_heal_llm.lock` の mtime で最短間隔強制）。これが無いと「LLM自己修復→また失敗→またLLM」が**サブスク枠を焼く（R2 濫用）**。→ `architecture.md` watchdog ＋ `decisions.md` D5/R2。

### 次スコープ
- A2A best-effort 配信（hub→standalone、通知失敗で本体を止めない）→ D6 bot連携段で。

---

## 4. faveos8758/reflexion-agent-ts — S5 自己改善ループ（★最重要・TS実装）

> Reflexion論文(2303.11366)の TS 実装。ループ/型/memory は流用可。モデル層（Vercel AI SDK=OpenAI/Ollama API前提）は D4/R2 と衝突＝`generateTextOverride` seam に CLI runner を注入して回避。

### MVP 反映 — **新 D22 として S5 の正式契約に確定**
- **Reflexion ループ = S5 自己改善の唯一の正式契約**：`execute(CLI)→evaluator(テスト実行)→reflector(失敗理由→改善指示)→retry`、`maxAttempts`（MVP=3）ガード。steal A-1 が言う「内容を変えて再生成」の**中身（reflector）**を埋める。directory-structure の `prompts/S5_eval_optimizer.md` に残る**未定義の「D21」番号は D22 に統合・改名**。
- **generate seam 集約**：execute も reflector も1関数 seam に集約し `runtimeRegistry.runCLISubprocess` を注入（ai/Vercel SDK 依存は持ち込まない）。実装メモ扱い、D22 に1行参照のみ（D4 と二重化しない）。
- **feedbackHistory をプロバナンス化**：S5 partial payload に `attempts`/`feedbackHistory[]`/`finalFeedback` を載せ「何回・どんな失敗を経たか」を JSON だけで追える（追加コストほぼゼロ、新ファイル無し）。→ `architecture.md` データ契約。
- **template reflector は opt-in 緩和策**：MVP 既定は **LLM reflector**（品質確保）。rate 枯渇頻発時に config フラグで決定的テンプレに切替えて reflector の CLI 呼び出しを省く。

### 次スコープ
- Jaccard キーワード教訓メモリ（戦略横断の教訓共有）。MVP は単一戦略×maxAttempts=3 で過去失敗が高々2件＋直前は feedbackHistory で連結済み＝価値ゼロ。run 数3桁/進化 D18 段で、events/ 配下の write-only 監査ログ扱いで導入。

### ライセンス
取込 MIT コードは `vendor/reflexion-agent-ts/` 配下に元 LICENSE 同梱。repo ルートには LICENSE を置かない（本体=非公開/未定のまま、third-party 帰属義務は vendor ローカルで両立）。

---

## 5. open-covenant/covenant — capability 運用層（監査/provenance）

> 本体は Rust＋on-chain settlement 前提でコードレベルでは噛み合わない。`scripts/provenance.mjs` は純Node で流用可だが **win32 適応（`C:\Users\`・バックスラッシュ・ドライブレター変動・UNC）が必須**。**4パターンとも mvp_relevant=false＝縦串が通った次スコープ**。R4(隔離なし)を運用ガードで担保する Taikai 思想と相性良い。

### 次スコープ（縦串の直後）
- **監査イベントログのハッシュチェーン化（tamper-evidence）**：events 各行に `event_hash`/`chain_hash` を並走ファイルに持ち、`verify_integrity()`。**events 行数≠chain 行数なら再構築せず停止**（黙って作り直すと改ざんが検証を通る）。R4＋USB物理切断環境で「result.json は本当にそのrunの産物か」を保証。1ファイル（events.ts が同関数で chain 追記）で完結。
- **capability チェックの許可/拒否両監査**：危険操作（`net.outbound`/`fs.write_outside_run`/`submit.tournament`）を試みた事実を許可/拒否どちらも構造化イベントで残す。`submit.tournament` は passed=false 固定、レビューゲート通過でのみ true＝不可逆操作の二重ガードを監査ログ上に可視化。提出フェーズ実装後に発火。
- **提出物 attestation envelope（純Node）**：`submitted/` を出す時に commit + 変更ファイルの gitBlob/sha256 + run_manifest + audit root_hash + テスト結果を1枚に封筒化（D17 手続き的再現の機械化）。書く前に `assertNoPrivateStrings`（win32 パターンで個人情報走査）。既存 per-record Provenance チェーンを**置換せず run 単位で束ねる補完層**。
- **write-only ログの最小エンベロープ規律**：プロンプト全文・LLM生出力はチェーンに焼かず sha256+長さだけ。構造的副作用（フェーズ開始/完了・partial書込・テスト結果・能力チェック）のみ残す。tamper-evidence チェーンを軽量に保つ付帯規約（steal B-4=トークン削減 とは動機が別＝チェーン軽量化＋秘匿非焼込）。

---

## 統合の実装着手順（MVP）

1. **D22 確定**（S5=Reflexion ループ）→ S5 の骨格
2. `architecture.md` E_CODE_TEST（回帰ガード＋analyze→fix＋best-so-far）／E_LLM_COMM（空出力）／CB（recordSkip）
3. `CLAUDE.md` 運用規律（fresh context・golden rule・analyze→fix注入）
4. `decisions.md` D4（OutcomeTracker）／D11（recordSkip）／D5（self-heal cooldown）
5. データ契約 `CodegenResult`（attempts/feedbackHistory）
6. 次スコープ：covenant 4点（縦串が通ってから）

*出典: Issue #1 の各リポジトリ（実コード精読）。サブエージェント・オーケストレーション（19エージェント・レビュー/自己改善ループ）の確定出力。*
