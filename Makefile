# Taikai-killer — フェーズ実行のエントリ（縦串MVP）
# 詳細: docs/mvp-vertical-slice.md / Issue #3

RUN_DIR ?= outputs/dev-run

.PHONY: install typecheck test run doctor clean

install:
	npm install

typecheck:
	npm run typecheck

test:
	npm test

# 縦串MVP: S1→S3→S5→S6→result.json（1周だけ）
run:
	npm run taikai -- run --run-dir $(RUN_DIR)

# 起動前バリデータ（TOURNAMENT_INFO/SCORING_RUBRIC のロード可能性）
doctor:
	npm run taikai -- doctor --run-dir $(RUN_DIR)

clean:
	rm -rf dist
