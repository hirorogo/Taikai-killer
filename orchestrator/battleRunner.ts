/**
 * S6 対戦モード（②battle）の「戦略プログラム同士の実対戦」ランナー。
 * 正本: docs/architecture.md「S6 の2評価モード」表②／orchestrator/types.ts BenchResult.battle。
 *
 * 方針（譲れない条件）:
 * - battle.ts（runRoundRobin / jankenCompare / toBattleRecord）の集計ロジックを **読むだけ** で再利用する。
 *   battle.ts は LLM 非依存・決定的な純集計。本モジュールは「外部プロセスから手を取り出す I/O 層」だけを足す。
 * - プレイヤープロトコル: 各 projects/{id}/ の run_cmd を **1手ごとに spawn** し、
 *     stdin  ← 過去手履歴 JSON（{ round, you, opponent, history:[{you,opponent}...] }）1 行
 *     stdout → 次の手 'rock' | 'paper' | 'scissors' を 1 行
 *   で受け渡す。worker は毎起動 fresh context 前提（CLAUDE.md）に倣い、状態は毎回履歴で渡し切る。
 * - 集計に渡す直前で **各 PlayFn を決定的にする**: 全マッチの手を先に spawn で確定させ、
 *   round → move の表に固めてから runRoundRobin に渡す（battle.ts の同期 PlayFn 契約を満たす）。
 *   これで集計部は bit 一致・再現可能、spawn の非決定性は move 収集フェーズに閉じ込まる。
 * - spawn は実プロセスなのでテスト対象外。純ロジック（buildHistoryPrompt / parseMove / 集計詰め
 *   packBattleResults）だけを vitest で固める。
 */

import { spawn } from "node:child_process";
// battle.ts の純集計を再利用（読むだけ）: 勝敗判定 jankenCompare と BenchResult.battle 詰め toBattleRecord。
import {
  jankenCompare,
  toBattleRecord,
  type Janken,
  type Participant,
  type ParticipantResult,
} from "./battle.ts";
import type { BenchResult } from "./types.ts";

const IS_WIN = process.platform === "win32";

/** 合法な手（型ガードと正規化に使う唯一の真実源）。 */
const MOVES = ["rock", "paper", "scissors"] as const;

/** 対戦に参加する1プレイヤー（projects/{id}/ の実行情報）。 */
export interface BattlePlayer {
  /** strategy_id（BenchResult.battle.opponents / provenance.derived_from に入る）。 */
  id: string;
  /** spawn するコマンド（TOURNAMENT_INFO.run_cmd と同形式。shell 解釈に委ねる）。 */
  run_cmd: string;
  /** 作業ディレクトリ（projects/{id}/）。run_cmd の相対パス基準。 */
  cwd: string;
}

/** 1ラウンドの結果（自分視点）。history で次手の判断材料に使う。 */
export interface MoveRecord {
  you: Janken;
  opponent: Janken;
}

/**
 * stdin で1手ごとにプレイヤーへ渡す状態。worker は毎回これだけで手を決める。
 * 決定的プレイヤー（常に rock / 履歴で相手に勝つ 等）はこの JSON だけ見れば再現できる。
 */
export interface PlayerState {
  /** 0 始まりのラウンド番号。 */
  round: number;
  /** 自分のこれまでの手（古い順）。 */
  you: Janken[];
  /** 相手のこれまでの手（古い順）。 */
  opponent: Janken[];
  /** {you,opponent} のペア履歴（古い順）。冗長だが Python 側で扱いやすい形も同梱。 */
  history: MoveRecord[];
}

export interface BattleRunnerOptions {
  /** 各ペアの対戦ラウンド数（>=1）。既定 1。 */
  rounds?: number;
  /** 1手 spawn あたりのハード timeout（ms）。既定 10s。 */
  moveTimeoutMs?: number;
  /** stdout が不正/タイムアウト時のフォールバック手（既定 "rock"）。負け筋だが決定的。 */
  fallbackMove?: Janken;
}

/** packBattleResults の戻り（各選手の BenchResult.battle と勝率を素のまま返す）。 */
export interface BattleTournamentResult {
  /** 選手ごとの集計（id / battle 形 / win_rate）。入力 players と同順。 */
  entries: {
    id: string;
    battle: NonNullable<BenchResult["battle"]>;
    win_rate: number;
  }[];
  /** 総マッチ数（= C(n,2)*rounds）。検証用。 */
  totalMatches: number;
  /** 各ペアの対戦ラウンド数。 */
  rounds: number;
}

// ───────── 純ロジック（テスト対象）─────────

/**
 * プレイヤーに stdin で渡す履歴プロンプトを 1 行 JSON で構築する。
 * 改行を含まない（stdin は 1 行＝1 リクエストの契約）。決定的。
 *
 * @param round    0 始まりラウンド番号
 * @param youMoves 自分のこれまでの手（古い順）
 * @param oppMoves 相手のこれまでの手（古い順）
 */
export function buildHistoryPrompt(round: number, youMoves: Janken[], oppMoves: Janken[]): string {
  const n = Math.min(youMoves.length, oppMoves.length);
  const history: MoveRecord[] = [];
  for (let i = 0; i < n; i++) {
    const you = youMoves[i];
    const opponent = oppMoves[i];
    if (you === undefined || opponent === undefined) continue; // noUncheckedIndexedAccess
    history.push({ you, opponent });
  }
  const state: PlayerState = {
    round,
    you: youMoves.slice(),
    opponent: oppMoves.slice(),
    history,
  };
  return JSON.stringify(state);
}

/**
 * プレイヤーの stdout を手にパースする。複数行・前後空白・大文字に頑健。
 * 不正なら null（呼び出し側が fallbackMove を使う）。LLM 非依存・決定的。
 */
export function parseMove(stdout: string): Janken | null {
  // 最後の非空行を採用（装飾ログが前に出ても末尾の手を拾う）。
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    if ((MOVES as readonly string[]).includes(token)) {
      return token as Janken;
    }
    // 末尾行が不正なら即 null（中間の正規行に誤マッチして取り違えるのを防ぐ）。
    return null;
  }
  return null;
}

/**
 * 確定済みの「全マッチの手の表」を集計し、各選手の BenchResult.battle 形（battle.ts の
 * toBattleRecord）＋ win_rate に詰める。決定的（同じ手の表→同じ集計）。
 *
 * movesById[id][opponentId][round] = その対戦・そのラウンドで id が出した手。
 *
 * 勝敗判定は battle.ts の jankenCompare を唯一の真実源として使う（優劣表を二重メンテしない）。
 * 詰め直しは toBattleRecord に委譲。集計の組み合わせ生成（C(n,2)*rounds）・record/opponents/
 * win_rate の式は battle.ts runRoundRobin と同形にしてある。runRoundRobin 本体をそのまま使えない
 * のは、その PlayFn が「現在の相手」を知らない設計（state=round のみ）で、本対戦は同じ選手が相手ごとに
 * 異なる手列を持つため。相手 id を play に渡す最小差分版をここに置く。
 *
 * @param players  参加選手（id 順を保持）。id 重複は弾く（来歴保護）。
 * @param movesById id→相手id→round→手。欠けは fallbackMove で埋める前提（spawn 層が保証）。
 * @param rounds   各ペアのラウンド数。
 */
export function packBattleResults(
  players: { id: string }[],
  movesById: Map<string, Map<string, Janken[]>>,
  rounds: number,
): BattleTournamentResult {
  // 相手別の手表を引く PlayFn を各選手に作る。state には [opponentId, round] を渡す。
  type BattleState = { opponentId: string; round: number };
  const participants: Participant<BattleState, Janken>[] = players.map((p) => ({
    id: p.id,
    play: (state: BattleState): Janken => {
      const vs = movesById.get(p.id)?.get(state.opponentId);
      const move = vs?.[state.round];
      // 表が欠けていても合法手を返す（spawn 層が埋めるが防御的に rock）。
      return move ?? "rock";
    },
  }));

  const r = Math.max(0, Math.trunc(rounds));
  const n = participants.length;
  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p.id)) throw new Error(`packBattleResults: duplicate participant id "${p.id}"`);
    seen.add(p.id);
  }
  const records = participants.map(() => ({ wins: 0, losses: 0, draws: 0 }));
  const oppLists: string[][] = participants.map(() => []);
  const oppSeen: Set<string>[] = participants.map(() => new Set<string>());
  let totalMatches = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pi = participants[i];
      const pj = participants[j];
      if (pi === undefined || pj === undefined) continue;
      const reci = records[i];
      const recj = records[j];
      if (reci === undefined || recj === undefined) continue;

      if (!oppSeen[i]!.has(pj.id)) {
        oppSeen[i]!.add(pj.id);
        oppLists[i]!.push(pj.id);
      }
      if (!oppSeen[j]!.has(pi.id)) {
        oppSeen[j]!.add(pi.id);
        oppLists[j]!.push(pi.id);
      }

      for (let round = 0; round < r; round++) {
        const ma = pi.play({ opponentId: pj.id, round });
        const mb = pj.play({ opponentId: pi.id, round });
        const outcome = jankenCompare(ma, mb);
        if (outcome === "a") {
          reci.wins += 1;
          recj.losses += 1;
        } else if (outcome === "b") {
          recj.wins += 1;
          reci.losses += 1;
        } else {
          reci.draws += 1;
          recj.draws += 1;
        }
        totalMatches += 1;
      }
    }
  }

  const results: ParticipantResult[] = participants.map((p, idx) => {
    const rec = records[idx] ?? { wins: 0, losses: 0, draws: 0 };
    const total = rec.wins + rec.losses + rec.draws;
    return {
      id: p.id,
      record: rec,
      win_rate: total === 0 ? 0 : rec.wins / total,
      opponents: oppLists[idx] ?? [],
    };
  });

  const entries = results.map((pr) => ({
    id: pr.id,
    battle: toBattleRecord(pr),
    win_rate: pr.win_rate,
  }));

  return { entries, totalMatches, rounds: r };
}

// ───────── spawn I/O 層（テスト対象外・実プロセス）─────────

/**
 * プレイヤープロセスを1手ぶん spawn し、stdin に履歴 JSON を流して stdout の手を読む。
 * ハード timeout で SIGKILL。不正/タイムアウト/異常終了は null（呼び出し側で fallback）。
 * claudeRunner.ts と同じ spawn 作法（shell on win / windowsHide / stdin で渡す）。
 */
function askMove(
  player: BattlePlayer,
  promptStdin: string,
  timeoutMs: number,
): Promise<Janken | null> {
  return new Promise<Janken | null>((resolve) => {
    const child = spawn(player.run_cmd, {
      cwd: player.cwd,
      shell: true, // run_cmd は "python main.py" のような文字列。shell に解釈させる。
      windowsHide: IS_WIN,
    });

    let stdout = "";
    let settled = false;
    const done = (m: Janken | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(m);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(null);
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.on("error", () => done(null));
    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        done(null);
        return;
      }
      done(parseMove(stdout));
    });

    child.stdin.on("error", () => {
      /* EPIPE 等は close で処理 */
    });
    child.stdin.write(promptStdin);
    child.stdin.end();
  });
}

/**
 * 1ペア（a vs b）を rounds 回対戦させ、両者の手の列を確定して返す。
 * 各ラウンドで両プレイヤーを並列 spawn し、互いの過去手履歴を stdin で渡す。
 * spawn 失敗は fallbackMove で埋め、ペア対戦が決定的に完了するようにする。
 */
async function playPair(
  a: BattlePlayer,
  b: BattlePlayer,
  rounds: number,
  moveTimeoutMs: number,
  fallback: Janken,
): Promise<{ aMoves: Janken[]; bMoves: Janken[] }> {
  const aMoves: Janken[] = [];
  const bMoves: Janken[] = [];
  for (let round = 0; round < rounds; round++) {
    const aPrompt = buildHistoryPrompt(round, aMoves, bMoves);
    const bPrompt = buildHistoryPrompt(round, bMoves, aMoves);
    const [am, bm] = await Promise.all([
      askMove(a, aPrompt, moveTimeoutMs),
      askMove(b, bPrompt, moveTimeoutMs),
    ]);
    aMoves.push(am ?? fallback);
    bMoves.push(bm ?? fallback);
  }
  return { aMoves, bMoves };
}

/**
 * 戦略プログラム同士の総当たり対戦を実行し、BenchResult.battle 形に集計して返す。
 *
 * 流れ:
 *  1) 全ペア (i<j) を spawn 対戦させ、各選手・各相手・各ラウンドの手を確定（move 収集フェーズ）。
 *  2) 確定した手の表を packBattleResults に渡し、battle.ts の集計式で win_rate / record / opponents を算出。
 * spawn の非決定性は (1) に閉じ込め、(2) は決定的（同じ手の表→同じ集計）。
 *
 * @param players 参加選手（id / run_cmd / cwd）。id 重複は弾く（来歴保護）。
 * @param options rounds / moveTimeoutMs / fallbackMove。
 */
export async function runBattleTournament(
  players: BattlePlayer[],
  options: BattleRunnerOptions = {},
): Promise<BattleTournamentResult> {
  const rounds = Math.max(1, Math.trunc(options.rounds ?? 1));
  const moveTimeoutMs = options.moveTimeoutMs ?? 10_000;
  const fallback: Janken = options.fallbackMove ?? "rock";

  // id 重複の早期失敗（packBattleResults でも弾くが、spawn 前に止める方が安い）。
  const seen = new Set<string>();
  for (const p of players) {
    if (seen.has(p.id)) throw new Error(`runBattleTournament: duplicate player id "${p.id}"`);
    seen.add(p.id);
  }

  // movesById[id][opponentId][round] を構築。
  const movesById = new Map<string, Map<string, Janken[]>>();
  for (const p of players) movesById.set(p.id, new Map<string, Janken[]>());

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      if (a === undefined || b === undefined) continue;
      const { aMoves, bMoves } = await playPair(a, b, rounds, moveTimeoutMs, fallback);
      movesById.get(a.id)!.set(b.id, aMoves);
      movesById.get(b.id)!.set(a.id, bMoves);
    }
  }

  return packBattleResults(players, movesById, rounds);
}
