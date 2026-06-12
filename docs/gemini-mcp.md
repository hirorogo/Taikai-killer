# gemini を MCP として動かす案 — 検証結果（正直版）

> 要望: 「gemini を MCP として動かせば（認証問題が）解決できるのでは」
> 結論: **解決しない。** MCP/ACP は transport であって credential ではない。認証は CLI 側に与えるしかない。
>
> 検証環境: gemini CLI **v0.41.2** / Windows 11 / 2026-06-11。以下「確認」は実コマンド出力、「文献」は Web ドキュメント由来。推測は明示する。

関連: [decisions.md](./decisions.md) D4 ／ runtime 実装 [`orchestrator/runtimes/geminiRunner.ts`](../orchestrator/runtimes/geminiRunner.ts)（CLI 直叩き）／本案スタブ [`orchestrator/runtimes/geminiMcp.ts`](../orchestrator/runtimes/geminiMcp.ts)。

---

## TL;DR

| 問い | 答え | 根拠 |
|---|---|---|
| `gemini mcp` で gemini を MCP **サーバ**として公開できる？ | **できない。** `gemini mcp` は gemini を MCP **クライアント（ホスト）**にするためのサブコマンド群（外部 MCP サーバを add/remove/list する） | 確認 |
| `gemini --acp` は MCP？ | 別物。**ACP（Agent Client Protocol）**エージェントとして stdio 起動する（IDE/エディタ統合用）。MCP ツールの口ではない | 確認 |
| では gemini を MCP サーバ化する手段は？ | **コミュニティ製ラッパ**（例 `gemini-cli-mcp`）。実体は内部で同じ `gemini -p` を spawn するだけ | 文献 |
| MCP/ACP 経由なら認証問題は消える？ | **消えない。** ラッパ越しでも同じ `gemini` バイナリを起動するので、未認証なら中で同じ `error.code=41` が出る | 確認（41 を実機再現） |
| 正しい解決策は？ | CLI 側に認証を与える: 対話 OAuth ログイン / `GEMINI_API_KEY` / `GOOGLE_GENAI_USE_GCA`(Code Assist) / `GOOGLE_GENAI_USE_VERTEXAI` | 確認（41 メッセージが列挙） |

---

## 確認: `gemini mcp` の実体（gemini = MCP クライアント）

```
> gemini mcp --help
gemini mcp
Manage MCP servers
Commands:
  gemini mcp add <name> <commandOrUrl> [args...]  Add a server
  gemini mcp remove <name>                        Remove a server
  gemini mcp list                                 List all configured MCP servers
  gemini mcp enable <name>                        Enable an MCP server
  gemini mcp disable <name>                       Disable an MCP server
```

```
> gemini mcp add --help
Usage: gemini mcp add [options] <name> <commandOrUrl> [args...]
  commandOrUrl  Command (stdio) or URL (sse, http)   [required]
  -t, --transport  Transport type (stdio, sse, http) [default: "stdio"]
  ...
```

```
> gemini mcp list
No MCP servers configured.
```

`add` が取るのは「外部サーバの起動コマンド or URL」。つまり **gemini が他の MCP サーバへ接続する側**。`gemini mcp serve` のような「自分をサーバとして公開する」コマンドは**存在しない**。

## 確認: `--acp` は ACP（MCP ではない）

`gemini --help` 抜粋:

```
      --acp                 Starts the agent in ACP mode  [boolean]
      --experimental-acp    Starts the agent in ACP mode (deprecated, use --acp instead)
```

空 stdin で起動すると JSON-RPC を待たず即 exit 0（対話的に JSON-RPC を喋る前提のサーバ）:

```
> printf '' | gemini --acp ; echo EXIT:$?
EXIT:0
```

ACP は Zed 等エディタが「コーディングエージェント」を組み込むためのプロトコルで、**MCP（モデルにツール/リソースを供給する）とは層も用途も異なる**。orchestrator から「gemini をツールとして呼ぶ」口にはならない。

---

## 確認: 認証問題は MCP/ACP では解決しない（核心）

無認証状態で CLI を直叩きすると（geminiRunner と同じフラグ）:

```
> printf 'hi' | gemini -p "" -o json --approval-mode yolo
{
  "session_id": "5ef3c9bb-...",
  "error": {
    "type": "Error",
    "message": "Please set an Auth method in your C:\\Users\\shieru_k\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    "code": 41
  }
}
```

検証時の env / 資格情報状態（確認）:

```
GEMINI_API_KEY set: false
GOOGLE_API_KEY set: false
GOOGLE_CLOUD_PROJECT: (unset)
GOOGLE_GENAI_USE_GCA: (unset)
GOOGLE_GENAI_USE_VERTEXAI: (unset)
~/.gemini/oauth_creds.json exists: false
~/.gemini/settings.json exists: false
```

**なぜ MCP/ACP でも解決しないか:**
gemini を MCP サーバ化する唯一の手段はコミュニティ製ラッパ（文献: `gemini-cli-mcp` / DiversioTeam の wrapper など）で、その実装は MCP の `tools/call` を受けたら**内部で同じ `gemini -p ...` を子プロセス起動する**だけ。認証は gemini バイナリが解決する責務なので、ラッパの一層内側でこの `code=41` が再発する。MCP は「どう呼ぶか（transport）」を抽象化するが「誰として呼ぶか（credential）」は抽象化しない。

> つまり「MCP にすれば認証が要らなくなる」は誤り。MCP にしても **同じ認証を、ラッパの設定として、結局どこかで与える**必要がある。経路が一段増えるぶん運用は複雑化する。

---

## 認証経路の整理（何が要るか）

41 のメッセージが列挙する3 env ＋ 対話ログインが正規経路。**どれを使っても最終的に gemini CLI に効かせる**（MCP/ACP は無関係）。

| 経路 | 与えるもの | サブスク利用 | 備考 |
|---|---|---|---|
| **対話 OAuth ログイン** | ブラウザでログイン → `~/.gemini/oauth_creds.json` | （無料枠 / Code Assist） | 本プロジェクトの想定（CLAUDE.md「サブスク認証をそのまま利用」）。env 不要 |
| **`GOOGLE_GENAI_USE_GCA`** | `=true` で Gemini Code Assist 経路を有効化（OAuth と併用） | Code Assist サブスク | 文献: 会社/学校アカウントや Code Assist ライセンスでは `GOOGLE_CLOUD_PROJECT` も要求されうる |
| **`GEMINI_API_KEY`** | AI Studio 発行の API キー | （従量/無料枠 API） | サブスクでなく API キー。本プロジェクトは「API キーは持たない」方針（CLAUDE.md） |
| **`GOOGLE_GENAI_USE_VERTEXAI`** | `=true` ＋ `GOOGLE_API_KEY` / ADC | （Vertex 課金） | エンタープライズ向け |

> 推測（要確認とは別の運用判断）: 本プロジェクトはサブスク前提なので **対話 OAuth ログイン**で `~/.gemini/oauth_creds.json` を一度作るのが筋。これさえ済めば geminiRunner（CLI 直叩き）が 41 を出さずに動く。MEMORY の `GOOGLE_GENAI_USE_GCA` メモは正しい（41 メッセージにも載っている）。ただし `GOOGLE_GENAI_USE_VERTEXAI` が canonical で GCA は無い、という一部 Web 記述は **このバージョンでは誤り**（実機メッセージが両方を列挙）。

---

## 結論と本プロジェクトでの扱い

1. **gemini を MCP サーバとして公開する built-in 機能は無い**（`gemini mcp` は逆向き、`--acp` は別プロトコル）。
2. MCP サーバ化したいならコミュニティ製ラッパが要るが、**認証問題は何も解決しない**（同じ 41 が一段内側で出る）＋外部依存が増える（確定制約「外部依存を増やさない」に反する）。
3. よって **MVP は CLI 直叩き（geminiRunner）を正**とし、認証は **対話 OAuth ログインを一度実施**して `~/.gemini/oauth_creds.json` を用意する運用で解く。
4. [`geminiMcp.ts`](../orchestrator/runtimes/geminiMcp.ts) は「動くフリ」をせず、**方針コメント＋ availability/認証レディネス診断（`checkAvailable`）のみ**の最小スタブに留める。`run()` は意図的に未実装（throw）。将来コミュニティ製ラッパを正式採用する場合のみ、stdio JSON-RPC 接続コードをここに足す。

### geminiMcp.ts が提供する診断（純ロジック・テスト可能）

- `GEMINI_AUTH_ENV_VARS` — 41 メッセージが列挙する3 env を定数化。
- `hasAuthEnv(env)` — 認証 env が1つでも与えられているか（空/空白は未設定扱い）。
- `isAuthError(raw)` — gemini 出力（JSON `error.code=41` / 素テキスト）が認証未設定エラーかを判定。MCP/ACP ラッパ越しでも 41 が表面化するため、診断メッセージを一意化する用途。
- `geminiMcp.checkAvailable()` — `gemini --version` の存在確認に加え、認証 env レディネスも報告（未認証なら MCP 経路でも詰まる事実を先に可視化）。

---

## 出典（Web 文献）

- [MCP servers with the Gemini CLI — Gemini CLI Docs](https://geminicli.com/docs/tools/mcp-server/)（gemini は MCP **クライアント**側）
- [Gemini CLI authentication setup](https://geminicli.com/docs/get-started/authentication/)（OAuth / GEMINI_API_KEY / Code Assist + GOOGLE_CLOUD_PROJECT）
- [google-gemini/gemini-cli (GitHub)](https://github.com/google-gemini/gemini-cli)
- コミュニティ製ラッパの存在（gemini を MCP サーバ化）: `gemini-cli-mcp`（DiversioTeam / epicsagas）等 — いずれも内部で gemini CLI を spawn する薄いブリッジ。
