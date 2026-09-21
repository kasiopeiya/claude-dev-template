// 責務: AI 専用 clone の中で `claude` を起動し、Issue 1件ぶんの `/auto-dev` を走らせる。
//
// 設計意図（WHY）:
// - Issue ごとにプロセスを作り直す。1つのセッションで何件も処理すると文脈が積もり、品質が落ちる。
// - 手順そのものは `.claude/skills/auto-dev/SKILL.md` が持つ。ここが渡すのは Issue 番号だけで、
//   プロンプト文字列に手順を書かない（書くとドキュメントレビューの対象外になる）。
// - 時間で打ち切る。無人のセッションが固まると、止める手段は起動側にしか無い。

import { config } from './config.mjs'
import { runStreaming } from './shell.mjs'

const MILLISECONDS_PER_MINUTE = 60 * 1000

/**
 * `/auto-dev <Issue番号>` を無人セッションとして実行する。
 *
 * @param {number} issueNumber 実装させる Issue の番号
 * @returns {{ exitCode: number, signal: string | null }} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runAutoDevSession(issueNumber) {
  // 権限確認を飛ばして起動する。無人セッションには権限プロンプトへ答える人間がおらず、
  // `--allowedTools` での列挙は漏れたところで空転するため（ADR-001「トレードオフ・影響」）。
  // この形は .claude/hooks/forbiddenCommandMatcher.mjs が「ゲートの迂回」として禁じているが、
  // それは Bash ツールへ渡すコマンドへの禁止であり、影響範囲は AI 専用 clone の中に閉じる。
  // clone の中でも .claude/hooks/ のガードは効き続け、このツール自体の起動も AI には禁じている。
  return runStreaming(
    'claude',
    ['-p', `/auto-dev ${issueNumber}`, '--dangerously-skip-permissions'],
    {
      cwd: config.workspaceDir,
      timeoutMs: config.sessionTimeoutMinutes * MILLISECONDS_PER_MINUTE
    }
  )
}
