// 責務: ローカルの `origin/HEAD` から、デフォルトブランチ名を引くことのみを担う。
//
// 設計意図（WHY）:
// - `gh repo view` は使わない。約0.5秒かかり、オフラインでは失敗して守りが黙って外れるため。
//   Bash の実行のたびに走りうる hook では、ローカルの参照を読む git だけにする。
// - `origin/HEAD` は clone が張る。`git remote add` だけで作ったリポジトリには無く、そのときは
//   引けない。引けないときは undefined を返し、代わりに守る名前は呼び出し側が持つ。
// - 完全な参照名（`refs/remotes/origin/develop`）で受ける。`--short` は、同じ名前のローカルブランチ
//   （`origin/develop` など）があると `remotes/origin/develop` を返し、接頭辞の取り外しが効かなくなる。
// - 名前はリモートが決めるので、許す文字の一覧に当たらない名前は引けなかったものとして扱う。呼び出し側は名前を
//   git の引数や AI に打たせるコマンドへ埋め込む。`-` で始まる名前はオプションとして、`;`・`$` を含む名前は
//   シェルのコマンドとして読まれうる。`git check-ref-format` はこれらの記号を通すので、検証に使えない。

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ORIGIN_REF_PREFIX = 'refs/remotes/origin/'
const SAFE_BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
// 禁止コマンドの hook は Bash の実行のたびに同期で走る。git が応答しないときにコマンドの実行を止めないための上限
const GIT_QUERY_TIMEOUT_MS = 1000
// git を起動する作業ディレクトリ。Windows は実行ファイルを PATH より先に作業ディレクトリから探すため、
// セッションの cwd（信頼できない場所でありうる）ではなく hook 自身の置き場所に固定する
const trustedWorkingDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * `origin/HEAD` が指すデフォルトブランチ名を返す（`refs/remotes/origin/develop` → `develop`）。
 *
 * @param {string} projectDir 作業ツリーのルート
 * @returns {string | undefined} デフォルトブランチ名。`origin/HEAD` が無い・git が失敗・タイムアウト・許さない文字を含むなら undefined
 */
export function readOriginDefaultBranchName(projectDir) {
  try {
    const ref = execFileSync(
      'git',
      ['-C', projectDir, 'symbolic-ref', `${ORIGIN_REF_PREFIX}HEAD`],
      {
        cwd: trustedWorkingDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_QUERY_TIMEOUT_MS
      }
    ).trim()
    const branchName = ref.startsWith(ORIGIN_REF_PREFIX) ? ref.slice(ORIGIN_REF_PREFIX.length) : ''
    return SAFE_BRANCH_NAME_PATTERN.test(branchName) ? branchName : undefined
  } catch {
    return undefined
  }
}
