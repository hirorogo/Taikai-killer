# toy-janken — S6 対戦モード（②battle）デモ

`SCORING_RUBRIC.eval_mode = "battle"` の最小デモ。戦略プログラム同士を
`orchestrator/battleRunner.ts` の `runBattleTournament` で**実プロセス対戦**させ、
`BenchResult.battle`（opponents / record / format=round_robin）＋ `win_rate` を集計する。

## プレイヤープロトコル（battleRunner.ts と一致）

各プレイヤーは `run_cmd`（ここでは `python player.py`）で1手ごとに spawn される。

- **stdin**: 1 行 JSON
  ```json
  {"round":0,"you":["rock"],"opponent":["scissors"],"history":[{"you":"rock","opponent":"scissors"}]}
  ```
  - `round`: 0 始まりのラウンド番号
  - `you` / `opponent`: 自分・相手のこれまでの手（古い順）
  - `history`: `{you,opponent}` ペアの履歴（古い順、冗長コピー）
- **stdout**: 1 行で次の手 `rock` | `paper` | `scissors`（前後空白・大小文字は許容）

worker は状態を持たず、毎起動 stdin だけで手を決める（fresh context 前提）。

## 同梱プレイヤー（すべて決定的・標準ライブラリのみ）

| id | 戦略 | 期待挙動 |
| --- | --- | --- |
| `always-rock` | 常に rock | beat-last に負け越す |
| `beat-last`   | 相手の直前手に勝つ手（初手 rock） | always-rock を 2 手目以降 paper で食う |
| `cycle`       | round%3 で rock→paper→scissors 循環 | 読まれやすいベースライン |

## 使い方（プログラムから）

```ts
import { runBattleTournament } from "../../orchestrator/battleRunner.ts";

const base = "examples/toy-janken/players";
const res = await runBattleTournament(
  [
    { id: "always-rock", run_cmd: "python player.py", cwd: `${base}/always-rock` },
    { id: "beat-last",   run_cmd: "python player.py", cwd: `${base}/beat-last` },
    { id: "cycle",       run_cmd: "python player.py", cwd: `${base}/cycle` },
  ],
  { rounds: 10 },
);
// res.entries[i] = { id, battle: {opponents,record,format}, win_rate }
```

`win_rate` を `BenchResult.score`（②対戦型の一次指標）に、`battle` を `BenchResult.battle` に詰める。
spawn は実プロセスのためユニットテストは純ロジック（prompt 構築 / parseMove / 集計詰め）に限定。
