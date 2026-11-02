// 責務: Git が無視しないファイルのうち、いま作業ツリーにあるものを列挙する。
//   作業ツリーを検査する check-*.mjs が、新規・削除・日本語名の
//   ファイルで検査を取りこぼしたり、スタックトレースで落ちたりしないよう、列挙のしかたをここ1か所に集める。

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * 追跡中のファイルと、まだ追跡していない新規ファイル（.gitignore で無視されるものは除く）のうち、
 * 作業ツリーに実在するものを返す。
 *
 * @param {string} repositoryRoot リポジトリ直下の絶対パス
 * @param {string[]} pathspecs 絞り込む git の pathspec（例: `*.md`）。空配列なら絞り込まず、全ファイルを返す
 * @returns {string[]} リポジトリ直下からの相対パス（各パス1回）
 */
export function listWorkingTreeFiles(repositoryRoot, pathspecs) {
  // -z（NUL区切り）でないと、日本語などASCII外のパスが core.quotePath でクォートされ、実在しないパスに見える。
  // --cached だけだと新規ファイルを見逃し、ステージしていない削除は一覧に残るので、実在で絞る
  const nulSeparatedPaths = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  // マージ競合中の未マージのパスは、index の段（stage 1〜3）ごとに1回ずつ出るため、同じパスが重複する
  return [...new Set(nulSeparatedPaths.split('\0'))].filter(
    (relativePath) => relativePath !== '' && existsSync(join(repositoryRoot, relativePath))
  )
}
