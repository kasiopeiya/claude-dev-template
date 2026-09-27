// 責務: 編集対象の絶対パスを、ポリシー・Rule の照合に使うプロジェクト基準の相対パスへ直すことのみを担う。
//
// 設計意図（WHY）:
// - 基準は hook の置き場所そのものではなく、対象ファイルが属する作業ツリーの中の同じ位置にする。
//   別フォルダの git worktree を編集すると、hook の置き場所からは `..` で始まるパスになり、
//   ポリシーが1件も届かなくなるため。
// - 作業ツリーを基準にするのは、hook と同じリポジトリ（worktree 間で共有する `.git` が同じ）の
//   ときだけに限る。親フォルダなど無関係なリポジトリに、このプロジェクトのポリシーを出さないため。
// - 入出力を持つ policy-loader.mjs から分離してある。git への問い合わせと代替経路の判断は、
//   入出力と別の関心事であるため。検証は ruleMatcher.mjs と同じく policy-loader.test.mjs の
//   end-to-end で覆う（unit-test-policy の例外一覧に無いため）。

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

// hook は Edit・Write のたびに同期で走り、1回で2度問い合わせる。git が応答しないときに編集を止めないための上限
const GIT_QUERY_TIMEOUT_MS = 1000
// git を起動する作業ディレクトリ。Windows は実行ファイルを PATH より先に作業ディレクトリから探すため、
// 編集対象の近く（信頼できない場所でありうる）ではなく hook 自身の置き場所に固定する
const trustedWorkingDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * 対象ファイルの、hook の置き場所（projectRoot）に当たる位置からの相対パス（`/` 区切り）を返す。
 *
 * 対象が hook と同じリポジトリの作業ツリー（別フォルダの worktree を含む）にあれば、その作業ツリーの
 * 中で projectRoot と同じ位置を基準にする。それ以外（git 外・別リポジトリ・`.git` の中・問い合わせの
 * 失敗）は projectRoot そのものを基準にする。対象ファイル・その親ディレクトリが未作成でもよい。
 *
 * @param {string} targetAbsolutePath 対象ファイルの絶対パス
 * @param {string} projectRoot hook を置いたプロジェクトのルート（絶対パス）
 * @returns {string | undefined} 相対パス。基準の外なら undefined
 */
export function toProjectRelativePath(targetAbsolutePath, projectRoot) {
  const { existingAncestor, missingSegments } = findNearestExistingAncestor(targetAbsolutePath)
  const targetGitLocation = readGitLocation(existingAncestor)
  const projectGitLocation = readGitLocation(projectRoot)
  const isSameRepository =
    targetGitLocation !== undefined && targetGitLocation.commonDir === projectGitLocation?.commonDir
  if (!isSameRepository) return toRelativePathFromProjectRoot(targetAbsolutePath, projectRoot)

  // 絶対パス同士を比べず git の prefix を使うのは、macOS の /tmp → /private/tmp のような
  // シンボリックリンクで比較がずれるため
  const pathFromWorktreeRoot =
    targetGitLocation.prefix + [...missingSegments, basename(targetAbsolutePath)].join('/')
  // projectRoot が作業ツリーのルートでない（リポジトリの子ディレクトリ）なら、その分を剥がす
  if (!pathFromWorktreeRoot.startsWith(projectGitLocation.prefix)) return undefined
  return pathFromWorktreeRoot.slice(projectGitLocation.prefix.length)
}

/**
 * 対象ファイルの親から上へ辿り、実在する最も近い祖先ディレクトリを返す。
 * 新規作成するファイルはディレクトリごと未作成のことがあり、git には実在する場所でしか問い合わせられないため。
 *
 * @param {string} targetAbsolutePath 対象ファイルの絶対パス
 * @returns {{ existingAncestor: string, missingSegments: string[] }} missingSegments は
 *   existingAncestor から対象ファイルの親までの、未作成のディレクトリ名（上から順）
 */
function findNearestExistingAncestor(targetAbsolutePath) {
  const missingSegments = []
  let existingAncestor = dirname(targetAbsolutePath)
  while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = dirname(existingAncestor)
  }
  return { existingAncestor, missingSegments }
}

/**
 * ディレクトリが属する git リポジトリの本体（worktree 間で共有する `.git`）と、
 * 作業ツリーのルートからそのディレクトリまでの相対パスを返す。
 *
 * @param {string} directoryPath 実在するディレクトリの絶対パス
 * @returns {{ commonDir: string, prefix: string } | undefined} commonDir はシンボリックリンクを
 *   解決した絶対パスで、別の呼び出しの結果と === で比べられる。prefix は末尾が `/` の相対パスで、
 *   ルート直下なら空文字。作業ツリーの外（git 外・`.git` の中）・問い合わせの失敗・タイムアウト時は undefined
 */
function readGitLocation(directoryPath) {
  try {
    const [isInsideWorkTree, commonDir, prefix = ''] = execFileSync(
      'git',
      [
        '-C',
        directoryPath,
        'rev-parse',
        '--path-format=absolute',
        '--is-inside-work-tree',
        '--git-common-dir',
        '--show-prefix'
      ],
      {
        cwd: trustedWorkingDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_QUERY_TIMEOUT_MS
      }
    ).split('\n')
    // `.git` の中では prefix が空になり、ルート直下と区別できない
    if (isInsideWorkTree !== 'true') return undefined
    return { commonDir: realpathSync(commonDir), prefix }
  } catch {
    return undefined
  }
}

/**
 * 対象ファイルの、projectRoot からの相対パス（`/` 区切り）を返す。
 *
 * @param {string} targetAbsolutePath 対象ファイルの絶対パス
 * @param {string} projectRoot hook を置いたプロジェクトのルート（絶対パス）
 * @returns {string | undefined} 相対パス。projectRoot の外なら undefined
 */
function toRelativePathFromProjectRoot(targetAbsolutePath, projectRoot) {
  const nativeRelativePath = relative(projectRoot, targetAbsolutePath)
  // 別ドライブ（Windows）だと relative は相対パスにならず、絶対パスをそのまま返す
  const isOutsideProject = nativeRelativePath.startsWith('..') || isAbsolute(nativeRelativePath)
  if (isOutsideProject) return undefined
  // applies-to・paths の glob は `/` 区切りで書かれている。Windows の `\` 区切りのままだと1件も当たらない
  return nativeRelativePath.split(sep).join('/')
}
