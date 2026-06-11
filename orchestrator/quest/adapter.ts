/**
 * questFramework: 全クエスト共通の抽象アダプタ（「標準化 AI フレームワーク」の中核）。
 * 正本: docs/decisions.md「進化（D18）①数値最適化＝LLM不要」/
 *       docs/architecture.md S6「②対戦型（battle / win_rate）」。
 *
 * 目的:
 * - 大会（クエスト）ごとに変わるのは「候補の作り方・評価・提出物の組み立て」だけ。
 *   その3点を QuestAdapter<Candidate> として抽象化し、進化ループ本体（runQuest）は
 *   どのクエストでも共通にする（じゃんけん勝率・分類精度・回帰誤差…を同じループで回す）。
 * - 数値候補（{key:number} の Record）のときは既存 numericOptimizer（createRng/optimize）を
 *   そのまま使う。runQuest がアダプタを受けて橋渡しする（adapter は最適化器を知らない）。
 *
 * 譲れない条件（CLAUDE.md / numericOptimizer.ts を継承）:
 * - **LLM を一切呼ばない純ロジック**。evaluate も buildSubmission も普通のコードで完結させる。
 * - **決定的**: evaluate が決定的なら runQuest も seed 固定で完全再現する。
 *   Date.now / Math.random に依存しない（乱数は numericOptimizer.createRng のみ）。
 * - **fitness は大きいほど良い**（max 方向）。勝率・精度はそのまま、誤差は符号反転して返す
 *   のが adapter（評価器）の責務（最適化器は中立）。
 */

/**
 * 数値パラメータ候補。キー＝チューニング対象の名前、値＝数値。
 * Candidate がこの形のとき runQuest は numericOptimizer をそのまま使う。
 * numericOptimizer.Params と構造的に同一（import せず再宣言＝共有 .ts を読むだけに留める）。
 */
export type NumericCandidate = Record<string, number>;

/**
 * 全クエスト共通の抽象アダプタ。
 *
 * Candidate はクエストが進化させる候補の型（数値パラメータ・戦略 JSON・重みベクタ等）。
 * フレームワーク本体（runQuest）はこのインタフェースだけに依存し、クエスト固有の
 * 知識（評価方法・提出物の形）を一切持たない。
 *
 * @typeParam Candidate 進化対象の候補型。数値 Record のときは numericOptimizer を直結できる。
 */
export interface QuestAdapter<Candidate> {
  /** クエスト識別子（来歴・提出物のラベルに使う）。 */
  questId: string;

  /**
   * 数値候補のキー集合（探索するパラメータ名）。Candidate が NumericCandidate の
   * ときに runQuest が初期点のキーとして使う。非数値クエストでは省略可。
   * exactOptionalPropertyTypes: 値があるときだけ載せる（undefined を載せない）。
   */
  paramKeys?: string[];

  /** 進化の出発点となる初期候補を返す（破壊されない前提で都度生成する）。 */
  initialCandidate(): Candidate;

  /**
   * 候補を採点する（= S6 評価関数）。**高いほど良い = fitness**（例: 勝率 0..1 / 精度）。
   * 非同期（プログラム実行・対戦シミュレーションを伴うため）。決定的であること。
   */
  evaluate(c: Candidate): Promise<number>;

  /**
   * 候補が数値 Record（{k:number}）として最適化可能か。true のとき runQuest は
   * numericOptimizer をそのまま使う。未指定/false なら汎用ループ（後述）で回す。
   * exactOptionalPropertyTypes: 値があるときだけ載せる。
   */
  mutateNumeric?: boolean;

  /**
   * 最良候補から提出物を組み立てて dir に書く（不可逆な外部送信はしない＝ファイル生成のみ）。
   * 大会提出の自動実行は禁止（CLAUDE.md レビューゲート）。ここは「提出物を作る」までで、
   * publish/submit はしない。
   */
  buildSubmission(best: Candidate, dir: string): void;
}
