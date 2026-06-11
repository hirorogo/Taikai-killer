# projects/_skeleton/

戦略ワークスペースの雛形（欠落1）。`projects/{strategy_id}/` を生成する元。

縦串MVP（toy-fizzbuzz, language=python）の雛形構成:
```
{strategy_id}/
├── manifest.json   # ProjectManifest（language/run_cmd/test_cmd/timeout_ms）
├── src/main.py     # S5 が生成（最初は空）
├── tests/          # provided テスト。S5開始時に sha256 凍結、改変は E_TEST_TAMPER
└── bench/          # この戦略のベンチ結果
```

> 言語別テンプレは縦串が通ってから増やす。MVP は python 1種。
