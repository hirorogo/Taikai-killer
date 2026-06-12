# robo-control — Robo Quest（2輪到達タスク）自己完結シミュ評価器

Robo Quest（ロボット制御）の数値最適化トラック（D18 ①: LLM 不要）用クエスト。
**標準ハーネスの汎用性証明 2**: X Quest（7並べ・対戦ゲーム）と全く違う毛色の
ロボ制御を、同じ `QuestAdapter<NumericCandidate>` 契約で実装できることを示す
（docs/quests.md §2.1・表の Robo 行）。最適化器・runQuest・provenance は無改変で共有し、
差分は本ディレクトリの Python サイドカー＋ `orchestrator/quest/roboControlAdapter.ts`
だけに閉じる。

外部物理エンジンに依存しない**自己完結シミュ**（物理は自前・標準ライブラリ math のみ）で、
2 輪差動駆動ロボットを平面上の目標点へ PD 制御で走らせ、制御ゲイン（params）で決まる方策を
N エピソード回して**平均報酬を `{"score":x}` で stdout に返す**（seed 固定・決定的）。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `sim.py` | 自己完結シミュレータ。2 輪差動駆動の運動学（前進オイラー積分）＋ PD 制御則（`run_episode`）と、N エピソードを回し平均報酬を返す `evaluate`。物理スケール定数（DT/V_MAX/GOAL_RADIUS 等）は固定、探索対象は 5 個のゲイン。 |
| `evaluate.py` | stdin で `{params,episodes,seed}` を受け、`sim.evaluate(params)` を `episodes` 回走らせ `{"score":x,"reach_rate":y,"episodes":N}` を stdout に返すサイドカー。`score` は平均報酬 fitness（TS 側が読む値）、`reach_rate` は到達率（診断）。 |
| `test_sim.py` | 決定性（同 seed で bit 一致）・単調性（ゲイン 0 < 既定）・報酬境界・CLI 契約（空/不正/部分 params）の pytest。`python test_sim.py` 単体でも走る。 |
| `best_params.json` | 最良候補の提出先（TS 側 `buildSubmission` が書く）。 |

TS 側ブリッジは `orchestrator/quest/roboControlAdapter.ts`（読むだけ）。`paramKeys` /
`initialCandidate` / 入出力 JSON 契約は本ディレクトリの実装と 1:1 で一致させている。

## タスク（2輪到達）

- 状態 = `(x, y, theta)`（位置と機体の向き）。原点近傍からランダムな向きでスタートし、
  最低 1.5m 離れた目標点 `(gx, gy)` へ向かう。
- 制御則（PD・params のゲインで決まる）:
  - 角速度 `omega = kp_ang * ang_err - kd_ang * d(ang_err)/dt`
    （目標方向と機体向きの角度差 `ang_err` を [-π,π] 正規化。微分項で旋回の振動を抑える）。
  - 前進速度 `v = kp_lin * dist * align`。`align` は `|ang_err|` が `align_thresh` を
    超える間 0 に近づき前進を絞る（**向きを合わせてから進む**保守度の閾値）。
  - `v` は `v_max * v_cruise` で飽和（攻め/守りのトレードオフ）。
- `dist < goal_radius`（0.25m）で**到達**＝その step で成功。`max_steps`（200）で時間切れ。

## 報酬（= fitness、大きいほど良い）

1 エピソードの報酬を「速く到達 > 遅く到達 > 近づいたが未到達 > 全く近づかない」の順に単調化:

- **到達**: `base_success - time_penalty * (steps / max_steps)`（速い到達ほど高報酬。常に >= 0.5）。
- **未到達**: `progress * (base_success * 0.5)`（初期距離に対し詰めた割合。常に < 0.5）。

→ 到達群（>=0.5）と未到達群（<0.5）が境界 0.5 で分離し、二値の成功/失敗より勾配が増える
（最適化器が「もう少しで届く」候補を識別できる）。`score` = 全エピソードの報酬平均（[0,1] 付近）。

## パラメータ（5 個・制御ゲイン）

`roboControlAdapter.ts paramKeys` と同名・同順。`sim.make`/`evaluate.py` は未指定キーを
`default_params()` で補完する。

| key | 既定 | 意味 |
|---|---|---|
| `kp_lin` | 0.8 | 距離 → 前進速度の比例ゲイン（大きいほど積極的に前進） |
| `kp_ang` | 2.0 | 角度差 → 角速度の比例ゲイン（大きいほど速く向きを合わせる） |
| `kd_ang` | 0.3 | 角度差の微分ゲイン（旋回の振動・オーバーシュート抑制） |
| `align_thresh` | 0.6 | この角度差（rad）を超える間は前進を絞り旋回優先（向き合わせの保守度） |
| `v_cruise` | 0.7 | 前進速度の上限スケール（0..1・v_max への割合。攻め/守り） |

既定ゲインは手調整の出発点で**最適とは限らない**。`numericOptimizer`（ヒルクライム＋
ランダムリスタート）がこの局所点を脱出してゲイン・閾値を直す前提。

## 決定性（CLAUDE.md「Python は決定的を重視」）

- `seed` 固定で `score` は **bit 一致**（プロセス間でも一致）。各エピソードの初期姿勢・目標は
  `random.Random((seed, ep))` から決定的に派生（`set` 反復順・`hash()` 非依存）。
- 浮動小数の集計は固定順（ep 昇順）で安定。

## 実行例

入力は stdin に 1 行 JSON。`score` は平均報酬 fitness（最適化器が読む値）、`reach_rate` は到達率。

```console
$ echo '{"params":{},"episodes":300,"seed":0}' | python evaluate.py
{"score": 0.8115083333333333, "reach_rate": 0.9333333333333333, "episodes": 300}
```

決定性の確認（同一入力を 3 回 → 同一 score）:

```console
$ for i in 1 2 3; do echo '{"params":{},"episodes":150,"seed":7}' | python evaluate.py; done
{"score": 0.80155, "reach_rate": 0.92, "episodes": 150}
{"score": 0.80155, "reach_rate": 0.92, "episodes": 150}
{"score": 0.80155, "reach_rate": 0.92, "episodes": 150}
```

params 次第で score は明確に動く（同一 seed・同一 300 エピソードでの実測比較）:

```text
default      (既定ゲイン)               score: 0.8115   (reach_rate 0.933)
zero-gains   (kp_lin/kp_ang/kd_ang=0)   score: 0.0000   (reach_rate 0.000)  ← 一切前進せず未到達・progress 0
over-cautious(align_thresh=0.03,kp_ang=0.5) score: 0.6562 (reach_rate 0.930) ← 到達するが旋回過多で遅い
tuned        (高ゲイン・広 align・全速) score: 0.8455   (reach_rate 0.930)  ← より速く到達
```

ゲインを壊すと報酬が 0 に落ち、調整すると既定を上回る。到達率が同じでも所要時間で score に
差が出るため、最適化器はヒルクライムの勾配を得られる（`over-cautious` は到達率 0.93 でも
score は 0.656 と低い ＝ 速度で識別される）。

```console
$ echo '{"params":{"kp_lin":1.2,"kp_ang":3.0,"kd_ang":0.5,"align_thresh":1.0,"v_cruise":1.0},"episodes":300,"seed":0}' | python evaluate.py
{"score": 0.84555, "reach_rate": 0.93, "episodes": 300}
```

## テスト

```console
$ python -m pytest test_sim.py -q
.........
9 passed
```

TS 側純ロジック（payload 構築・結果パース・提出整形）は `tests/roboControlAdapter.test.ts`
（vitest 26 件）で固める。spawn 自体は実プロセスなのでテスト対象外。

## 依存

標準ライブラリのみ（`math` / `random` / `json`）。numpy 不要（X Quest と違い盤面行列を持たない）。
`evaluate.py` → `sim.py` の自己完結で、外部物理エンジン・データセットに依存しない。
