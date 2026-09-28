// 責務: AI 専用 clone を「origin/main の姿」に戻し、そこからトピックブランチを作る。
//
// 設計意図（WHY）:
// - ブランチ作成を決定論的なこちら側で行うことで、AI 側はすでにトピックブランチの上にいる状態で
//   始められる（README.md）。
// - 前回の実行が途中で落ちていても、ここで毎回 origin/main まで戻すので、やり残しが次の PR へ
//   混ざらない。`git clean` に -x を付けないのは、無視対象である node_modules を残すためである。
// - ただし戻す前に、未コミットの変更（未追跡ファイルを含む）は stash へ退避する。セッションが commit
//   より前に落ちる（レート制限など）と、実装を終えた変更がここで消えるからだ。stash は新しい
//   トピックブランチに載らないので、やり残しが次の PR へ混ざらないことは変わらない。
// - 同名ブランチがリモートに残っていると、AI は実装を終えた後の push で拒否される。1セッション
//   まるごと無駄にしないよう、着手前にその Issue を飛ばす。

import { config } from './config.mjs'
import { runOrThrow } from './shell.mjs'
import { showInfo } from './ui.mjs'

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
 * 作業ツリーに未コミットの変更（未追跡ファイルを含む）があれば、stash へ退避して作業ツリーを空にする。
 *
 * stash のメッセージには退避元のブランチ名と日時を入れ、`git stash list` で見つけられるようにする。
 * 無視対象のファイル（node_modules など）は退避しない。未解決の衝突は、衝突マーカーを含んだ内容で退避する。
 *
 * @param {string} workingDir 退避する git リポジトリのディレクトリ
 * @returns {void}
 * @throws {Error} git の操作が失敗したとき
 */
function stashUncommittedChanges(workingDir) {
  const runGit = (args) => runOrThrow('git', args, { cwd: workingDir })
  if (runGit(['status', '--porcelain']).trim() === '') return

  const sourceBranchName = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const message = `auto-programmer: ${sourceBranchName} の未コミット変更（${new Date().toISOString()}）`
  // 衝突を解決する前に落ちると、stash は "needs merge" で失敗し、以後 clone を origin/main へ戻せなく
  // なる。衝突マーカーごと index に載せてから退避する
  if (runGit(['diff', '--name-only', '--diff-filter=U']).trim() !== '') runGit(['add', '--all'])
  runGit(['stash', 'push', '--include-untracked', '--message', message])
  showInfo(`未コミットの変更を stash へ退避しました: ${message}`)
}

/**
 * clone を origin/main の状態へ戻し、そこから指定のトピックブランチを作って切り替える。
 *
 * ローカルに同じ名前のブランチが残っていた場合は作り直す（中身は毎回 origin/main から始まる）。
 * 前回のセッションが残した未コミットの変更は、消さずに stash へ退避してから戻す。
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

  stashUncommittedChanges(config.workspaceDir)
  runGitInWorkspace(['checkout', '--force', baseBranch])
  runGitInWorkspace(['reset', '--hard', `origin/${baseBranch}`])
  runGitInWorkspace(['clean', '-fd'])
  runGitInWorkspace(['checkout', '-B', branchName, `origin/${baseBranch}`])
}
