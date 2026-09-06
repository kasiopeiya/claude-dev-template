// 責務: bashコマンド文字列から「gitブランチを新規作成する呼び出し」を検出する純粋関数のみを担う。
//
// 設計意図（WHY）:
// - `git branch` は一覧・削除・改名・作成を1サブコマンドで兼ねるため、フラグの有無だけでは
//   判定できない。「作成でない」と分かっている既知フラグのホワイトリストで判定する
//   （ブラックリスト方式だと未知の作成系フラグ・組み合わせを見逃すため）。
// - 語頭は位置で読むので、読む前に正規化する（ラッパー・環境変数の代入・グローバルオプションを剥がす）。
//   剥がさないと `env git checkout -b x`・`git -C /tmp checkout -b x` で判定を丸ごとすり抜けられる。
// - `&&` `;` `|` `||` で連結されたコマンドも1つずつ判定できるよう、先にサブコマンドへ分割する。
//   分割は shellSplit.mjs に委ね、引用符の内側は区切らない（本文に禁止コマンド名を含むだけの
//   正当な操作を拒否しないため）。
// - シェルの厳密なパース（サブシェル・変数展開等）はしない。「AIが自律的にbranchを作らない」
//   ためのガードレールであり、完全な安全機構ではないため、判定できない入力はブロックせず
//   素通りする（fail-open）。

import {
  normalizeCommandStart,
  splitHeredoc,
  splitPipeStages,
  splitStatements,
  tokenize
} from './shellSplit.mjs'

// `--track`/`-t` は `-b` が無くても、リモート追跡ブランチ名からローカルブランチを作る
const CHECKOUT_CREATE_FLAGS = new Set(['-b', '-B', '--track', '-t'])
const SWITCH_CREATE_FLAGS = new Set(['-c', '-C', '--create', '--force-create', '--track', '-t'])

// `git branch` の「作成ではない」操作を示す先頭フラグ。ここに含まれれば作成とはみなさない
// （一覧・削除・改名・情報表示など）。-c/-C（コピー＝新規ブランチ作成）は意図的に含めない。
const BRANCH_NON_CREATE_FIRST_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--verbose',
  '-l',
  '--list',
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '--show-current',
  '--contains',
  '--no-contains',
  '--points-at',
  '--merged',
  '--no-merged',
  '--sort',
  '--format',
  '--edit-description',
  '--column',
  '--no-column',
  '-u',
  '--set-upstream-to',
  '--unset-upstream'
])

function splitSubcommands(command) {
  // ヒアドキュメントの中身は実行されない入力データなので、判定対象から外す
  const { commandText } = splitHeredoc(command)
  return splitStatements(commandText).flatMap(splitPipeStages)
}

/**
 * bashコマンド文字列を検査し、gitブランチの新規作成に該当するサブコマンドがあれば
 * その説明文字列を返す。該当しなければ null。
 *
 * @param {string} command
 * @returns {string | null}
 */
export function detectGitBranchCreation(command) {
  if (typeof command !== 'string' || command.trim() === '') return null

  for (const stage of splitSubcommands(command)) {
    // `env` や `git -C <path>` を剥がし、`git` とサブコマンドを先頭2つに揃える
    const tokens = normalizeCommandStart(tokenize(stage))
    if (tokens.length < 2 || tokens[0] !== 'git') continue

    const subcommand = tokens[1]
    const rest = tokens.slice(2)

    if (subcommand === 'checkout' && rest.some((t) => CHECKOUT_CREATE_FLAGS.has(t))) {
      return `git checkout（ブランチ作成）: ${stage}`
    }

    if (subcommand === 'switch' && rest.some((t) => SWITCH_CREATE_FLAGS.has(t))) {
      return `git switch（ブランチ作成）: ${stage}`
    }

    if (subcommand === 'branch') {
      if (rest.length === 0) continue // 引数なし = 一覧表示
      // `--sort=-committerdate` のように値が付いた形でも、フラグ名だけを見て照合する
      if (BRANCH_NON_CREATE_FIRST_FLAGS.has(rest[0].split('=')[0])) continue
      return `git branch（ブランチ作成）: ${stage}`
    }
  }

  return null
}
