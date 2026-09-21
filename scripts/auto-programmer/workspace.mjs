// 責務: AI 専用 clone を「origin/main の姿」に戻し、そこからトピックブランチを作る。
//
// 設計意図（WHY）:
// - ブランチ作成を決定論的なこちら側で行うことで、AI 側はすでにトピックブランチの上にいる状態で
//   始められる。`.claude/hooks/` のブランチ作成ガードに例外を作らずに済む（ADR-001）。
// - 前回の実行が途中で落ちていても、ここで毎回 origin/main まで戻すので、やり残しが次の PR へ
//   混ざらない。`git clean` に -x を付けないのは、無視対象である node_modules を残すためである。
// - 同名ブランチがリモートに残っていると、AI は実装を終えた後の push で拒否される。1セッション
//   まるごと無駄にしないよう、着手前にその Issue を飛ばす。

import { config } from './config.mjs'
import { runOrThrow } from './shell.mjs'

/**
 * AI 専用 clone の中で git を実行する。
 *
 * @param {string[]} args git の引数
 * @returns {string} 標準出力
 * @throws {Error} git が失敗したとき
 */
function runGitInWorkspace(args) {
  return runOrThrow('git', args, { cwd: config.workspaceDir })
}

/**
 * clone を origin/main の状態へ戻し、そこから指定のトピックブランチを作って切り替える。
 *
 * ローカルに同じ名前のブランチが残っていた場合は作り直す（中身は毎回 origin/main から始まる）。
 *
 * @param {string} branchName 作るトピックブランチ名
 * @returns {void}
 * @throws {Error} 同名ブランチがリモートにあるとき・git の操作が失敗したとき
 */
export function prepareTopicBranch(branchName) {
  const { baseBranch } = config

  runGitInWorkspace(['fetch', 'origin', '--prune'])
  if (runGitInWorkspace(['ls-remote', '--heads', 'origin', branchName]).trim() !== '') {
    throw new Error(
      `リモートに ${branchName} が残っています。前回の PR を閉じてこのブランチを消せば、次の巡回で拾われます`
    )
  }

  runGitInWorkspace(['checkout', '--force', baseBranch])
  runGitInWorkspace(['reset', '--hard', `origin/${baseBranch}`])
  runGitInWorkspace(['clean', '-fd'])
  runGitInWorkspace(['checkout', '-B', branchName, `origin/${baseBranch}`])
}
