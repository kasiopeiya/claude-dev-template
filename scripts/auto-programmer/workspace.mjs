// 責務: AI 専用 clone をデフォルトブランチ（GitHub のリポジトリ設定）の最新の姿に戻し、そこからトピックブランチを作る。
//   衝突を解かせるときは、既にある PR のブランチの、このツールが最後に CI を待った姿へ切り替える。
//   clone の HEAD の commit も引く（index.mjs と watchCiAndFix.mjs の両方が読むので、どちらにも置かない）。
//
// 設計意図（WHY）:
// - ブランチ作成を決定論的なこちら側で行うことで、AI 側はすでにトピックブランチの上にいる状態で
//   始められる（README.md）。
// - 切る元は設定に持たず、GitHub のデフォルトブランチを毎回引く。PR の作成先は pipeline.yml が
//   デフォルトブランチに決めるので、設定を持つと切る元と PR の作成先が食い違いうる。
// - `origin/HEAD` は使わない。clone した時点の値のまま残り、fetch では更新されないので、clone を
//   使い回すうちにデフォルトブランチを変えると古い値を読み続ける。
// - 前回の実行が途中で落ちていても、ここで毎回デフォルトブランチまで戻すので、やり残しが次の PR へ
//   混ざらない。`git clean` に -x を付けないのは、無視対象である node_modules を残すためである。
// - ただし戻す前に、未コミットの変更（未追跡ファイルを含む）は stash へ退避する。セッションが commit
//   より前に落ちる（レート制限など）と、実装を終えた変更がここで消えるからだ。stash は新しい
//   トピックブランチに載らないので、やり残しが次の PR へ混ざらないことは変わらない。
// - 同名ブランチがリモートに残っていると、AI は実装を終えた後の push で拒否される。1セッション
//   まるごと無駄にしないよう、着手前にその Issue を飛ばす。

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { runOrThrow } from './shell.mjs'
import { showInfo } from './ui.mjs'

/**
 * clone をデフォルトブランチの最新の状態へ戻し、そこから指定のトピックブランチを作って切り替える。
 *
 * ローカルに同じ名前のブランチが残っていた場合は作り直す（中身は毎回デフォルトブランチから始まる）。
 * 前回のセッションが残した未コミットの変更は、消さずに stash へ退避してから戻す。
 *
 * @param {{ workspaceDir: string, branchName: string }} params このプロセスが使う AI 専用 clone と、作るトピックブランチ名
 * @returns {void}
 * @throws {TechnicalError} 同名ブランチがリモートにあるとき・git や gh の操作が失敗したとき
 */
export function prepareTopicBranch({ workspaceDir, branchName }) {
  const baseBranchName = readDefaultBranchName()

  runGitInWorkspace(workspaceDir, ['fetch', 'origin', '--prune'])
  // ls-remote のパターンは ref の末尾で照合されるため、完全な ref 名で渡さないと st2/<branchName> のような別の接頭辞のブランチにも当たる
  if (
    runGitInWorkspace(workspaceDir, [
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branchName}`
    ]).trim() !== ''
  ) {
    throw new TechnicalError(
      `リモートに ${branchName} が残っています。前回の PR を閉じてこのブランチを消せば、次の巡回で拾われます`
    )
  }

  stashUncommittedChanges(workspaceDir)
  runGitInWorkspace(workspaceDir, ['checkout', '--force', baseBranchName])
  runGitInWorkspace(workspaceDir, ['reset', '--hard', `origin/${baseBranchName}`])
  runGitInWorkspace(workspaceDir, ['clean', '-fd'])
  runGitInWorkspace(workspaceDir, ['checkout', '-B', branchName, `origin/${baseBranchName}`])
}

/**
 * clone を、既にある PR のブランチの、指定した commit の状態へ切り替える。衝突を解かせる前に呼ぶ。
 *
 * ブランチは指定した commit から作り直し、リモートのブランチを push 先にする。確かめた後にリモートへ別の push が入っても、
 * その中身は取り込まない（push は先に進んだリモートに拒否される）。前回のセッションが残した未コミットの変更は、消さずに
 * stash へ退避してから切り替える。
 *
 * @param {{ workspaceDir: string, branchName: string, headSha: string }} params このプロセスが使う AI 専用 clone・PR のブランチ名・切り替える先の commit の SHA
 * @returns {void}
 * @throws {TechnicalError} git の操作が失敗したとき（リモートにブランチや commit が無いときを含む）
 */
export function switchToPullRequestBranch({ workspaceDir, branchName, headSha }) {
  runGitInWorkspace(workspaceDir, ['fetch', 'origin', '--prune'])
  stashUncommittedChanges(workspaceDir)
  runGitInWorkspace(workspaceDir, ['checkout', '--force', '-B', branchName, headSha])
  runGitInWorkspace(workspaceDir, ['branch', '--set-upstream-to', `origin/${branchName}`])
  runGitInWorkspace(workspaceDir, ['clean', '-fd'])
}

/**
 * AI 専用 clone の HEAD が指している commit の SHA を引く。
 *
 * @param {string} workspaceDir HEAD を引く AI 専用 clone
 * @returns {string} commit の SHA
 * @throws {TechnicalError} clone が渡されなかったとき・git が失敗したとき
 */
export function readLocalHeadSha(workspaceDir) {
  return runGitInWorkspace(workspaceDir, ['rev-parse', 'HEAD']).trim()
}

/**
 * AI 専用 clone の中で git を実行する。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @param {string[]} args git の引数
 * @returns {string} 標準出力
 * @throws {TechnicalError} clone が渡されなかったとき・git が失敗したとき
 */
function runGitInWorkspace(workspaceDir, args) {
  // cwd を省くと、起動した人間の作業ツリーで reset --hard・clean が走る。渡し忘れはここで止める
  if (!workspaceDir) throw new TechnicalError('AI 専用 clone のパスが渡されていません')
  return runOrThrow('git', args, { cwd: workspaceDir })
}

/**
 * 作業ツリーに未コミットの変更（未追跡ファイルを含む）があれば、stash へ退避して作業ツリーを空にする。
 *
 * stash のメッセージには退避元のブランチ名と日時を入れ、`git stash list` で見つけられるようにする。
 * 無視対象のファイル（node_modules など）は退避しない。未解決の衝突は、衝突マーカーを含んだ内容で退避する。
 *
 * @param {string} workspaceDir 退避する AI 専用 clone
 * @returns {void}
 * @throws {TechnicalError} clone が渡されなかったとき・git の操作が失敗したとき
 */
function stashUncommittedChanges(workspaceDir) {
  const runGit = (args) => runGitInWorkspace(workspaceDir, args)
  if (runGit(['status', '--porcelain']).trim() === '') return

  const sourceBranchName = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const stashMessage = `auto-programmer: ${sourceBranchName} の未コミット変更（${new Date().toISOString()}）`
  // 衝突を解決する前に落ちると、stash は "needs merge" で失敗し、以後 clone をデフォルトブランチへ戻せなく
  // なる。衝突マーカーごと index に載せてから退避する
  if (runGit(['diff', '--name-only', '--diff-filter=U']).trim() !== '') runGit(['add', '--all'])
  runGit(['stash', 'push', '--include-untracked', '--message', stashMessage])
  showInfo(`未コミットの変更を stash へ退避しました: ${stashMessage}`)
}

/**
 * config.repository について、GitHub に設定されたデフォルトブランチ名を引く。
 *
 * @returns {string} デフォルトブランチ名
 * @throws {TechnicalError} gh が失敗したとき・デフォルトブランチを引けなかったとき
 */
function readDefaultBranchName() {
  const defaultBranchName = runOrThrow('gh', [
    'repo',
    'view',
    config.repository,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name'
  ]).trim()
  // コミットの無い空のリポジトリでは defaultBranchRef が null になり、gh は空文字を返す
  if (defaultBranchName === '') {
    throw new TechnicalError(
      `${config.repository} のデフォルトブランチを引けませんでした（コミットの無い空のリポジトリではありませんか）`
    )
  }
  return defaultBranchName
}
