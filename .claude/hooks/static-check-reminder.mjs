#!/usr/bin/env node
// Stop hook: ターン終了時に、app/・infra/ の TypeScript に未コミットの変更があれば
// 「終える前に npm run check:static を実行せよ」と1回だけ促す。
//
// 設計意図（WHY）:
// - 正式フロー（/code-dev・/cdk-dev）は CI を自動実行するが、Plan/Issue を経ない
//   アドホックな直接編集には自動ゲートが無く、push 後に Actions で初めて落ちる。
//   「編集ごと」ではなく「ターンを終える直前」に1回だけ促してその穴を埋める。
// - 1回だけ: stop_hook_active（＝この停止自体が本フックの継続）なら素通りし、無限ループを防ぐ。
// - 対象変更が無い／判定できない場合はブロックしない（fail-open）。判定は staticCheckMatcher.mjs に委ねる。

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { shouldRemindStaticCheck } from './staticCheckMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')

/**
 * 作業ツリーの未コミット変更パス一覧を返す（追跡外・ステージ済み・未ステージを含む）。
 * リネームは新パス側を採る。git が無い等で失敗したら空配列（＝促さない）。
 *
 * @returns {string[]} プロジェクトルート相対の変更パス
 */
function collectChangedPaths() {
  const porcelain = execFileSync('git', ['-C', projectRoot, 'status', '--porcelain'], {
    encoding: 'utf8'
  })
  return porcelain
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => {
      // 各行は「XY <path>」。slice(3) で状態2文字＋空白を落とす。
      const pathField = line.slice(3)
      const renameArrow = pathField.indexOf(' -> ')
      return renameArrow === -1 ? pathField : pathField.slice(renameArrow + 4)
    })
}

function main() {
  // Claude Code の hook 契約（外部仕様）：Stop フックはイベント情報を JSON として
  // 子プロセスの標準入力（fd 0）経由で渡す。stop_hook_active は本フック起点の継続かを示す。
  const input = JSON.parse(readFileSync(0, 'utf8'))

  // この停止自体が本フックの再開由来なら、もう促さない（1回だけ・無限ループ防止）。
  if (input?.stop_hook_active) return

  const hasStaticChange = collectChangedPaths().some((path) => shouldRemindStaticCheck(path))
  if (!hasStaticChange) return

  const reason =
    'app/・infra/ の TypeScript に未コミットの変更があります。終了する前に `npm run check:static`（lint / knip / typecheck）を実行し、違反があればローカルで修正してから終了してください（push 後に GitHub Actions で落とさないため）。既に実行して緑を確認済みなら、そのまま終了して構いません。'

  // Stop フックの契約：decision: "block" にすると reason がモデルに渡り、ターンを継続する。
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

try {
  main()
} catch {
  // 判定できないときは作業をブロックしない（fail-open）。
  process.exit(0)
}
