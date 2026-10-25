// 責務: GitHub のリポジトリに設定されたデフォルトブランチ名を、gh で引くことのみを担う。
//   origin/HEAD は使わない。clone 後に GitHub 側で変えても追従せず、`git remote add` だけのリポジトリには無いため

import { runCommand } from './runCommand.mjs'

/**
 * 指定したリポジトリについて、GitHub に設定されたデフォルトブランチ名を引く。
 *
 * @param {string} repository リポジトリの URL または `OWNER/REPO`
 * @returns {string} デフォルトブランチ名
 * @throws {Error} gh が失敗したとき・デフォルトブランチを引けなかったとき
 */
export function readDefaultBranchName(repository) {
  const defaultBranchName = runCommand('gh', [
    'repo',
    'view',
    repository,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name'
  ])
  // コミットの無い空のリポジトリでは defaultBranchRef が null になり、gh は空文字を返す
  if (defaultBranchName === '') {
    throw new Error(
      'デフォルトブランチを引けませんでした（コミットの無い空のリポジトリではありませんか）'
    )
  }
  return defaultBranchName
}
