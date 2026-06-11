/**
 * 言語レジストリ（S5 を言語非依存にする純ロジック）。
 * 正本: docs/mvp-vertical-slice.md（language/entrypoint/run_cmd/test_cmd）／orchestrator/types.ts TargetLanguage。
 *
 * 方針（譲れない条件）:
 * - **LLM を一切呼ばない純関数**。TargetLanguage("python"|"node"|"ts") を受け、言語ごとの
 *   entrypoint / 既定 run・test コマンド / コードフェンス言語名を返すだけ。副作用・I/O なし。
 * - runner.ts は現状 entrypoint を三項（`ti.language === "python" ? "src/main.py" : "src/main.js"`）で
 *   ハードコードしている。本モジュールの langProfile(language).entrypoint で置換できる形にする
 *   （配線そのものは別途。ここは置換可能な純レジストリの提供まで）。
 * - run_cmd / test_cmd は TOURNAMENT_INFO で上書きされる前提なので、ここで返すのは **既定値・ヒント**。
 *   未指定時のフォールバックと、プロンプトに見せる最小例（test 実行の最小コマンド）に使う。
 */

import type { TargetLanguage } from "./types.ts";

/**
 * 1 言語ぶんのプロファイル（純データ）。runner / S5 プロンプトがここから言語差分を引く。
 */
export interface LangProfile {
  /** 対象言語（TargetLanguage と一致）。 */
  language: TargetLanguage;
  /**
   * 生成コードの保存先（projects/{id}/ からの相対パス）。
   * python="src/main.py" / node="src/main.js" / ts="src/main.ts"。
   * runner.ts の entrypoint 三項ハードコードの置換先。
   */
  entrypoint: string;
  /**
   * 既定の実行コマンド（TOURNAMENT_INFO.run_cmd 未指定時のフォールバック）。
   * entrypoint を起点にした最小の起動コマンド。
   */
  defaultRunCmd: string;
  /**
   * 既定のテスト実行コマンドのヒント（TOURNAMENT_INFO.test_cmd 未指定時の手掛かり・プロンプト掲示用）。
   * 各言語のテスト実行の最小例: node="node tests/test.js" / ts="npx tsx tests/test.ts" / python="python tests/test.py"。
   */
  defaultTestCmdHint: string;
  /** コードフェンスの言語名（```python / ```js / ```ts）。プロンプトに正しい fence を出すため。 */
  fenceHint: string;
}

/**
 * 言語ごとの確定プロファイル表（唯一の真実源）。
 * Record で全 TargetLanguage を網羅（漏れは型エラーで弾く）。
 */
const PROFILES: Record<TargetLanguage, LangProfile> = {
  python: {
    language: "python",
    entrypoint: "src/main.py",
    defaultRunCmd: "python src/main.py",
    defaultTestCmdHint: "python tests/test.py",
    fenceHint: "python",
  },
  node: {
    language: "node",
    entrypoint: "src/main.js",
    defaultRunCmd: "node src/main.js",
    defaultTestCmdHint: "node tests/test.js",
    fenceHint: "js",
  },
  ts: {
    language: "ts",
    entrypoint: "src/main.ts",
    defaultRunCmd: "npx tsx src/main.ts",
    defaultTestCmdHint: "npx tsx tests/test.ts",
    fenceHint: "ts",
  },
};

/**
 * TargetLanguage から言語プロファイルを返す純関数。
 * 返すオブジェクトは内部表のコピー（呼び出し側が破壊しても表は不変）。
 *
 * @param language "python" | "node" | "ts"。
 */
export function langProfile(language: TargetLanguage): LangProfile {
  const p = PROFILES[language];
  // 型上は全 TargetLanguage を網羅しているが、実行時に未知値が来た場合は決定的に失敗させる
  // （黙って既定で進めない／CLAUDE.md「no hardcoded defaults」）。
  if (p === undefined) {
    throw new Error(`langProfile: unsupported language "${String(language)}"`);
  }
  return { ...p };
}

/** サポートする全 TargetLanguage（テスト・列挙用）。PROFILES のキーから導出。 */
export const SUPPORTED_LANGUAGES: readonly TargetLanguage[] = Object.keys(
  PROFILES,
) as TargetLanguage[];
