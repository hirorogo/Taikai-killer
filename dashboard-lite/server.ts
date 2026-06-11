/**
 * dashboard-lite の最小 read-only HTTP サーバ（node:http のみ・依存ゼロ）。
 * 「ウェブダッシュボードは参考用(vendor speca)しか無い」ため、自前の最小ダッシュボードを提供する。
 *
 * ルート（全て read-only / GET のみ）:
 *   GET /                          → index.html（run 一覧 + leaderboard を fetch で表示）
 *   GET /api/runs                  → RunSummary[]
 *   GET /api/runs/:id/result       → BenchResult | null
 *   GET /api/runs/:id/events       → PipelineEvent[]
 *   GET /api/leaderboard           → LeaderboardEntry[]
 *
 * 方針:
 * - 純ロジックは readers.ts。ここは HTTP の薄いアダプタ（ルーティング + JSON 整形）のみ。
 * - outputs パスは paths.ts 規約（リポジトリ直下 outputs/）。OUTPUTS_DIR で上書き可。
 * - :id はディレクトリトラバーサルを拒否（read-only でも outputs 外は読ませない）。
 * - 書き込み系メソッドは 405。未知ルートは 404。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { listRuns, readResult, readEvents, readLeaderboard } from "./readers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** outputs/ はリポジトリ直下（dashboard-lite/ の隣の親）。OUTPUTS_DIR で上書き可。 */
export function defaultOutputsDir(): string {
  return process.env["OUTPUTS_DIR"] ?? join(HERE, "..", "outputs");
}

const INDEX_HTML = join(HERE, "index.html");

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(json);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res: ServerResponse): void {
  if (!existsSync(INDEX_HTML)) {
    sendText(res, 500, "index.html missing");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(INDEX_HTML, "utf8"));
}

/** :id がパス区切りや .. を含まない単一セグメントか検証（トラバーサル拒否）。 */
function safeRunId(id: string): string | null {
  const decoded = decodeURIComponent(id);
  if (decoded.length === 0) return null;
  if (decoded.includes("/") || decoded.includes("\\") || decoded.includes("..")) return null;
  // 念のため basename 正規化後と一致することを確認（記号混入の保険）
  if (basename(decoded) !== decoded) return null;
  return decoded;
}

/**
 * 1 リクエストを処理する純粋なルータ（テスト容易性のため createServer から分離）。
 * outputsDir を引数で受け取り、副作用は readers.ts の read-only 読み取りのみ。
 */
export function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  outputsDir: string,
): void {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const path = rawUrl.split("?")[0] ?? "/";

  if (method !== "GET" && method !== "HEAD") {
    sendText(res, 405, "method not allowed (read-only dashboard)");
    return;
  }

  if (path === "/" || path === "/index.html") {
    sendHtml(res);
    return;
  }

  if (path === "/api/runs") {
    sendJson(res, 200, listRuns(outputsDir));
    return;
  }

  if (path === "/api/leaderboard") {
    sendJson(res, 200, readLeaderboard(outputsDir));
    return;
  }

  // /api/runs/:id/result  /  /api/runs/:id/events
  const m = /^\/api\/runs\/([^/]+)\/(result|events)$/.exec(path);
  if (m) {
    const id = safeRunId(m[1] ?? "");
    const kind = m[2];
    if (id === null) {
      sendJson(res, 400, { error: "invalid run id" });
      return;
    }
    const runDir = join(outputsDir, id);
    if (!existsSync(runDir)) {
      sendJson(res, 404, { error: "run not found", id });
      return;
    }
    if (kind === "result") {
      sendJson(res, 200, readResult(runDir));
    } else {
      sendJson(res, 200, readEvents(runDir));
    }
    return;
  }

  sendJson(res, 404, { error: "not found", path });
}

/** HTTP サーバを構築する（listen はしない。呼び出し側が .listen する）。 */
export function createDashboardServer(outputsDir: string = defaultOutputsDir()): Server {
  return createServer((req, res) => {
    try {
      handleRequest(req, res, outputsDir);
    } catch (err) {
      // 観測用ダッシュボードなので1リクエストの失敗で落とさない
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: "internal", message: msg });
    }
  });
}

const DEFAULT_PORT = 8787;

/** CLI: ポートを listen して起動する。`tsx dashboard-lite/server.ts` で直接実行。 */
export function startDashboard(port: number = DEFAULT_PORT): Server {
  const server = createDashboardServer();
  server.listen(port, () => {
    console.log(`[dashboard-lite] read-only dashboard on http://localhost:${port}`);
  });
  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const envPort = process.env["PORT"];
  const port = envPort !== undefined && envPort.length > 0 ? Number(envPort) : DEFAULT_PORT;
  startDashboard(Number.isFinite(port) ? port : DEFAULT_PORT);
}
