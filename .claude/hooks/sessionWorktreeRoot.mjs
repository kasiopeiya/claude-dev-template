// 責務: hook の入力の cwd から、いまセッションが作業している作業ツリーのルートを決めることのみを担う。
//
// 設計意図（WHY）:
// - hook の置き場所（CLAUDE_PROJECT_DIR）はセッションを起動した元のフォルダのままで、
//   EnterWorktree で worktree に入っても変わらない。置き場所を基準にする hook は、worktree の
//   作業を「元のフォルダの作業」として扱ってしまうため、基準は stdin の cwd から決める。
// - cwd の作業ツリーを基準にするのは、hook と同じリポジトリ（worktree 間で共有する `.git` が同じ）の
//   ときだけに限る。無関係なリポジトリの中で動くセッションに、このプロジェクトの基準を当てないため。
// - 決められないときは undefined を返し、代わりの基準は呼び出し側が選ぶ。hook ごとに、置き場所以外の
//   既定（ターン末ゲートは hook の置き場所、禁止コマンドは CLAUDE_PROJECT_DIR など）が違うため。
// - turn-end-gate.mjs と block-forbidden-commands.mjs が同じ判定を使うので、書き写さずここに置く。

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 禁止コマンドの hook は Bash の実行のたびに同期で走り、1回で複数回問い合わせる。
// git が応答しないときにコマンドの実行を止めないための上限
const GIT_QUERY_TIMEOUT_MS = 1000
// git を起動する作業ディレクトリ。Windows は実行ファイルを PATH より先に作業ディレクトリから探すため、
// セッションの cwd（信頼できない場所でありうる）ではなく hook 自身の置き場所に固定する
const trustedWorkingDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * `git rev-parse` の出力を返す。git が無い・git の外などで失敗したら例外を投げる。
 *
 * @param {string} directory 実行するディレクトリ
 * @param {string[]} options `git rev-parse` に渡すオプション
 * @returns {string} 前後の空白を除いた出力
 */
function readGitRevParse(directory, options) {
  return execFileSync('git', ['-C', directory, 'rev-parse', ...options], {
    cwd: trustedWorkingDirectory,
    encoding: 'utf8',
    // 失敗は呼び出し元が代わりの基準へ戻る通常の経路なので、git の標準エラーを出さない
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_QUERY_TIMEOUT_MS
  }).trim()
}

/**
 * セッションの作業ツリーのルートを返す。
 * セッションの cwd が、この hook と同じリポジトリの作業ツリー（別の worktree を含む）にあれば
 * そのルート。cwd が無い・git の外・別のリポジトリ・問い合わせの失敗なら undefined。
 *
 * @param {unknown} sessionWorkingDirectory hook の入力の cwd
 * @param {string} hookProjectRoot hook を置いたプロジェクトのルート（同じリポジトリかの比較に使う）
 * @returns {string | undefined} 作業ツリーのルート。決められなければ undefined
 */
export function findSessionWorktreeRoot(sessionWorkingDirectory, hookProjectRoot) {
  if (typeof sessionWorkingDirectory !== 'string' || sessionWorkingDirectory === '') {
    return undefined
  }
  try {
    const commonDirOptions = ['--path-format=absolute', '--git-common-dir']
    const isSameRepository =
      readGitRevParse(sessionWorkingDirectory, commonDirOptions) ===
      readGitRevParse(hookProjectRoot, commonDirOptions)
    return isSameRepository
      ? readGitRevParse(sessionWorkingDirectory, ['--show-toplevel'])
      : undefined
  } catch {
    return undefined
  }
}
