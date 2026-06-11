# toy-rpsls — S6 対戦モード（②battle）デモ / RPSLS（5 手）版

`SCORING_RUBRIC.eval_mode = "battle"` の最小デモ。`toy-janken` を踏襲しつつ、手の集合を
**rock-paper-scissors-lizard-spock（RPSLS, 5 手）** に拡張したトイ。戦略プログラム同士を
`runBattleTournament` 系で**実プロセス対戦**させ、`BenchResult.battle`（opponents / record /
format=round_robin）＋ `win_rate` を集計する想定。

> 注: 共有 `orchestrator/battleRunner.ts` の `MOVES` は 3 手（rock/paper/scissors）固定の
> ため、この 5 手トイはプロトコル・プレイヤー実装のフィクスチャとして提供する（5 手対応の
> matchFn を足す場合の参照実装）。プレイヤー側の stdin/stdout 契約は janken と完全に同形で、
> 手の語彙だけが 5 種に増える。

## RPSLS 優劣表（A が B に勝つ）

| 手 | 勝つ相手 | 負ける相手 |
| --- | --- | --- |
| `rock`     | scissors, lizard | paper, spock |
| `paper`    | rock, spock      | scissors, lizard |
| `scissors` | paper, lizard    | rock, spock |
| `lizard`   | spock, paper     | rock, scissors |
| `spock`    | scissors, rock   | paper, lizard |

各手はちょうど 2 手に勝ち、2 手に負ける（対称）。

## プレイヤープロトコル（janken と同形 / 手だけ 5 種）

各プレイヤーは `run_cmd`（ここでは `python player.py`）で1手ごとに spawn される。

- **stdin**: 1 行 JSON
  ```json
  {"round":0,"you":["rock"],"opponent":["spock"],"history":[{"you":"rock","opponent":"spock"}]}
  ```
  - `round`: 0 始まりのラウンド番号
  - `you` / `opponent`: 自分・相手のこれまでの手（古い順）
  - `history`: `{you,opponent}` ペアの履歴（古い順、冗長コピー）
- **stdout**: 1 行で次の手 `rock` | `paper` | `scissors` | `lizard` | `spock`（前後空白・大小文字は許容）

worker は状態を持たず、毎起動 stdin だけで手を決める（fresh context 前提）。

## 同梱プレイヤー（すべて決定的・標準ライブラリのみ）

| id | 戦略 | 期待挙動 |
| --- | --- | --- |
| `always-rock`     | 常に rock | paper/spock を出す相手に負け越す |
| `beat-last-rpsls` | 相手の直前手に勝つ手（候補 2 つは正準順で先頭、初手 rock） | always-rock を 2 手目以降 paper で食う |
| `random-det`      | round を seed にした決定的擬似ランダムで 5 手を散らす | 読まれにくいベースライン（同 round→同手で再現的） |

## 手動確認（フィクスチャなのでユニットテストは無し）

```sh
# always-rock: 何を渡しても rock
echo '{"round":3,"you":[],"opponent":["paper"],"history":[]}' | python players/always-rock/player.py
# → rock

# beat-last-rpsls: 相手の直前が rock なら rock を倒す paper
echo '{"round":1,"you":["rock"],"opponent":["rock"],"history":[{"you":"rock","opponent":"rock"}]}' | python players/beat-last-rpsls/player.py
# → paper

# random-det: round=0 の手（決定的）
echo '{"round":0,"you":[],"opponent":[],"history":[]}' | python players/random-det/player.py
```

spawn は実プロセスのため対戦本体はユニットテスト対象外（純ロジックのみテスト、本トイは
テスト不要のフィクスチャ）。
