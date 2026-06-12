# 縦串MVP仕様 — 1大会で1result出す最小経路

レビューが「Taikai固有の核心（S5実行環境・テスト供給・コールドスタート・提出フロー…）が空欄」と指摘した**致命的欠落を全部埋める**。
全レイヤを薄く1回ずつ貫いて `result.json` を1枚出す最小経路を、確定制約（TS/Node・Claude+Gemini CLI・通常マシン・受任リスク R1-R4）のもとで定義する。

> 原則: 無限ループ・並列・進化・island・dashboard・2モデル目は**入れない**。縦串が通ってから横に広げる。

---

## 縦串の流れ（MVP）

```
S1(手書きJSON) → S3(戦略 数個) → S5(D22ループで実装+テスト) → S6(最小採点) → result.json → 通知1本
                  ↑ S2/S4 は MVP では薄くスキップ可（S2=手で1知見 or 無し、S4=S3に統合）
```

---

## 欠落1: S5 生成コードの実行環境 確定

**「1大会＝1言語」で固定する。** 汎用化は後。`TOURNAMENT_INFO.json` が言語と実行/テストコマンドを宣言し、ランナーはそれを呼ぶだけ。

```ts
// projects/{strategy_id}/manifest.json
interface ProjectManifest {
  language: "python" | "node" | "ts";   // MVP はこの3つから1つ
  entrypoint: string;                    // 例 "src/main.py"
  run_cmd: string;                       // 例 "python3 src/main.py"
  test_cmd: string;                      // 例 "python3 -m pytest -q" / "vitest run"
  timeout_ms: number;                    // ハード timeout（D4 の subprocess timeout を生成コード実行にも適用）
}
```

- 生成コードは `projects/{strategy_id}/`（D1 のフォルダ並行）の中だけに書く。**書き込みは run ワークスペースに限定**（R4 受容下の最小ガード）。
- 実行は subprocess + **ハード timeout 必須**（無限ループ生成コードを殺す）。stdout/exit code を捕捉。
- `projects/_skeleton/` に言語別テンプレ（entrypoint 雛形・テスト配線）。MVP はまず1言語ぶんだけ用意。
- サンドボックスはしない（R4）が、timeout＋ワークスペース限定＋(任意で)別ユーザ/コンテナは D8 緩和に委ねる。

---

## 欠落2: テストの供給源（3分類）確定

**テストを書く者とコードを書く者を必ず分離**（報酬ハック対策／CLAUDE.md「評価器・テスト改ざん禁止」）。`TOURNAMENT_INFO.test_source` で分岐：

| test_source | 供給元 | 扱い |
|---|---|---|
| **`provided`** | 大会が公式 I/O 例・テストを出す | そのまま**信頼アンカー**として使う。S5 は読むだけ・改変禁止 |
| **`generate`** | 公式が無い/薄い | **S5 とは別のテスト生成ワーカー**が `SCORING_RUBRIC`/仕様からテストを生成。S5 開始前に**ハッシュ凍結**、S5 はそれを編集できない |
| **`heldout`** | 一部を隠す | テストの一部を S5 から隠蔽し S6 だけが持つ（過適合＝暗黙汚染の検出） |

- テストは `projects/{strategy_id}/tests/`。**S5 開始時に各テストファイルの sha256 を記録**し、S6 が採点前に再ハッシュして**改変が無いことを検証**（改変検知＝失格扱い）。
- これで「自分で甘いテストを書いて勝つ」自己欺瞞を構造的に防ぐ（禁止条項に強制力を与える）。
- D22 の evaluator はこのテストを実行して `{passed, reason}` を返すだけ。

---

## 欠落3: コールドスタート（初回 result 無し）確定

無限ループは `result.json` を S2 に再投入する設計だが、**初回はそれが無い**。Null-safe 分岐を定義：

- **S3 の origin は初回 result/rival を要求しない。** 初回は `origin ∈ {requirement, paper, subject}` だけで戦略を生成。`origin ∈ {result, rival, human_idea}` は対応データが空ならスキップ（CLAUDE.md「Required — no hardcoded defaults」だが、これらは**任意入力**なので空＝スキップが正）。
- **進化（D18）の種プール**: 初回 S3 がゼロから初期プール（`evolution/pool.json`）を作る（親なし）。numericOptimizer は初期パラメータをランダム/既定から開始。
- 初回判定: `outputs/` に前 run の `result.json` が無ければ cold-start モードで S3 を起動。これは resume の glob スキャン（partial 有無）と同じ仕組みで判定。

---

## 欠落4: S1 入力が無い/非公開大会 確定

URL クロールは**主経路にしない**。`TOURNAMENT_INFO.json` を人間が手書きできるのが MVP の主経路（S1 はブートストラップ1回だから許容）。

```ts
// TOURNAMENT_INFO.json（最小必須フィールド）
interface TournamentInfo {
  name: string;
  language: ProjectManifest["language"];
  run_cmd: string;
  test_cmd: string;
  test_source: "provided" | "generate" | "heldout";
  submission: { format: "zip" | "repo_url" | "web_url" | "pdf"; deadline?: string };
  // 受任リスク R1-R3 のゲート（S1 が判定）
  eligibility?: string;          // 出場資格メモ（R1）
  automation_allowed?: boolean;  // AI自動化可否（R2/R3）。false でも MVP は研究目的で続行可、提出は人間
  source_url?: string;           // あれば S1 がクロール、無ければ手入力で成立
}
```

- **必須フィールド（name/language/run_cmd/test_cmd/test_source/submission）が欠けたら S1 は exit 1**（黙ってデフォルトで進めない／CLAUDE.md）。人間が埋める。
- `source_url` は**任意**。URL が PDF/ログイン必須/Discord告知のみでも、手入力だけで S1 が成立する。
- 非STOP原則との整合: 欠落は**そのフェーズ（S1）だけ**を止めて通知。S1 は一度きりなので全パイプラインを永久ブロックしない。

---

## 欠落5: エラー通知（best-effort）確定 ★初回必須

無人ループは通知が無いと「無限ループ」が「無限停止」になる。**最小1本**を初回実装必須にする。

```ts
// notify(): best-effort delivery（流用: SWE-Squad a2a）
// 1) env TAIKAI_NOTIFY_WEBHOOK（Slack/Discord）へ POST
// 2) 失敗しても throw せず、必ず outputs/{run}/logs/notify.jsonl に追記
```

- **発火条件**: exit 64(予算)/65(CB)/2(runtime未実装)、S1 必須入力欠落、ヒューマンレビューの `質問.json`、run 完了（result.json 生成）。
- best-effort＝配信先不達でも本体を止めない（architecture「単一失敗でループを止めない」と同型）。

---

## 欠落6: outputs のバックアップ 確定

`outputs/` は `.gitignore`（揮発）。R4（通常マシン・壊れたら困る）の緩和として、**成果物だけ別所へ複製**。

- 各周回の `result.json` 確定時に、`result.json` + `run_manifest.json` + 最新 partial を `TAIKAI_BACKUP_DIR`（別ディスク/クラウド同期フォルダ）へ複製。
- **Windows/USB 宛ては C: ステージ経由でバルク転送**（exFAT 小ファイル多数は致命的に遅い → 一旦 C: に置き `robocopy /MT:32` で一括／MEMORY 既知）。
- MVP は「result 確定ごとにコピー」で十分。差分同期・世代管理は後。

---

## 欠落7: 提出物のフォーマット・提出フロー 確定

`submitted/` はディレクトリ名だけだったのを、フロー化する。

```
S6 で提出候補が決まる → submission アセンブル（TOURNAMENT_INFO.submission.format に従う）
   → ★ヒューマンレビューゲート必須（不可逆操作／R3）
   → 人間が提出（automation_allowed=true かつ規約OKのときだけ自動提出を検討）
```

- `format` 別アセンブル: `zip`=src/を固める / `repo_url`=push して URL / `web_url`=デプロイ URL / `pdf`=生成。
- **提出は必ずレビューゲートを通す**（covenant の capability `submit.tournament` は passed=false 固定、ゲート通過でのみ true＝次スコープで監査可視化）。
- MVP は「アセンブル＋レビュー提示」で止める。実提出は人間（R3 受任）。

---

## 欠落8: run 横断の最強選抜（leaderboard）確定

∞ループで大量の `result.json` が出るが、**run 間でどれが最強か**の集約が無かった。

```ts
// outputs/leaderboard.json（run 横断インデックス）
interface LeaderboardEntry {
  run_id: string;
  strategy_id: string;
  rubric_ref: string;     // どの SCORING_RUBRIC で測ったか（大会が同じなら比較可能）
  score: number;
  passed_test_ratio: number;
  result_ref: string;     // outputs/{run}/result.json への参照
  ts: string;
}
```

- 各 S6 完了時に、その run のベストを leaderboard に追記。
- **提出候補 = leaderboard 上位**（同一 `rubric_ref` のもの同士で比較）。README「現時点での最強を生成」をこれで実体化。
- 異なる rubric（採点軸が変わった）を跨いだ比較はしない（`rubric_ref` でグルーピング）。

---

## 縦串MVP の最小ファイル/手順

1. 人間が `outputs/{run}/TOURNAMENT_INFO.json` ＋ `SCORING_RUBRIC.json` を手書き（欠落4）
2. `projects/_skeleton/` に対象言語のテンプレ（欠落1）
3. S3: Claude CLI 1呼び出しで戦略 数個（cold-start＝requirement/subject origin のみ／欠落3）
4. S5: 1戦略を `projects/{id}/` に実装 → テスト供給（欠落2）→ D22 Reflexion ループで通す
5. S6: テスト再ハッシュ検証 → `passed_test_ratio` 採点 → `result.json`（欠落2,8）
6. leaderboard 追記（欠落8）＋ `result.json` をバックアップ（欠落6）＋ 通知1本（欠落5）
7. 提出候補をアセンブル → レビューゲート提示（欠落7）

**入れない**: 無限ループ・S2大量クロール・S4独立・並列・進化・island・dashboard・2モデル目・covenant監査。これらは縦串が通ってから。

---
*関連: architecture.md（データ契約）/ decisions.md（D1-D22・受任リスク）/ integrations-issue1.md（D22 等）*
