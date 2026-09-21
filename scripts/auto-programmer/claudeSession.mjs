// 責務: AI 専用 clone の中で `claude` を起動し、Issue 1件ぶんの `/issue-check` と `/auto-dev` を走らせる。
//
// 設計意図（WHY）:
// - Issue ごと・Skill ごとにプロセスを作り直す。1つのセッションで何件も処理すると文脈が積もり、品質が
//   落ちる。監査と実装を分けるのは、実装セッションが差し替わった本文をクリーンな文脈で読むため。
// - 手順そのものは各 Skill の SKILL.md が持つ。ここが渡すのは Issue 番号だけで、
//   プロンプト文字列に手順を書かない（書くとドキュメントレビューの対象外になる）。
// - 時間で打ち切る。無人のセッションが固まると、止める手段は起動側にしか無い。

import { config } from './config.mjs'
import { runStreaming } from './shell.mjs'

const MILLISECONDS_PER_MINUTE = 60 * 1000

/**
 * スラッシュコマンド1つを無人セッションとして実行する。
 *
 * @param {string} slashCommand 実行するスラッシュコマンド（引数を含む）
 * @returns {{ exitCode: number, signal: string | null }} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
function runUnattendedSession(slashCommand) {
  // 権限確認を飛ばして起動する。無人セッションには権限プロンプトへ答える人間がおらず、
  // `--allowedTools` での列挙は漏れたところで空転するため（ADR-001「トレードオフ・影響」）。
  // この形は .claude/hooks/forbiddenCommandMatcher.mjs が「ゲートの迂回」として禁じているが、
  // それは Bash ツールへ渡すコマンドへの禁止であり、ローカルのファイルへの影響は AI 専用 clone の中に閉じる。
  // clone の中でも .claude/hooks/ のガードは効き続け、このツール自体の起動も AI には禁じている。
  return runStreaming('claude', ['-p', slashCommand, '--dangerously-skip-permissions'], {
    cwd: config.workspaceDir,
    timeoutMs: config.sessionTimeoutMinutes * MILLISECONDS_PER_MINUTE
  })
}

/**
 * `/issue-check #<Issue番号>` を無人セッションとして実行する。判定を Issue へ書き戻す手順は Skill が持ち、
 * 終了コード 0 は書き戻しが済んだことを保証しない。
 *
 * @param {number} issueNumber 監査させる Issue の番号
 * @returns {{ exitCode: number, signal: string | null }} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runIssueCheckSession(issueNumber) {
  // `#` を付ける。素の数字は /issue-check が件数として読む
  return runUnattendedSession(`/issue-check #${issueNumber}`)
}

/**
 * `/auto-dev <Issue番号>` を無人セッションとして実行する。
 *
 * @param {number} issueNumber 実装させる Issue の番号
 * @returns {{ exitCode: number, signal: string | null }} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runAutoDevSession(issueNumber) {
  return runUnattendedSession(`/auto-dev ${issueNumber}`)
}
