#!/usr/bin/env node
// Stop hook: ターンを終える直前に、変更内容に対応する既存ゲートを実行し、落ちたら AI へ差し戻す。
//
// 設計意図（WHY）:
// - 正式フロー（/code-dev・/cdk-dev）は CI を自動実行するが、Plan/Issue を経ないアドホックな
//   直接編集には自動ゲートが無く、push 後に Actions で初めて落ちる。ターン末に1度だけ走らせて
//   その穴を埋める。
// - hook は検査ごとに増やさず、この1本に集約する（policy-driven-development-policy
//   「ターン末ゲートは1本に統合する」）。ゲートの中身は npm script が持ち、hook が持つのは
//   「いつ走らせるか」だけ。判定を hook 側に写すと二重管理になる。
// - 促さず自分で実行する。走らせたかを AI の自己申告に委ねると、決定論的な関門にならない。
// - 1回だけ: stop_hook_active（＝この停止自体が本フックの継続）なら素通りし、無限ループを防ぐ。
// - 判定できない・実行できない場合はブロックしない（fail-open）。

import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { selectTurnEndGates } from './turnEndGateMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')

// lint は全違反を吐きうる。差し戻しで文脈を溢れさせないよう、末尾だけを渡す。
const MAX_OUTPUT_CHARS = 3000
// ゲートが固まってもターンを永久に止めない。
const GATE_TIMEOUT_MS = 180_000

/**
 * 作業ツリーの未コミット変更パス一覧を返す（追跡外・ステージ済み・未ステージを含む）。
 * リネームは新パス側を採る。git が無い等で失敗したら例外を投げる（呼び出し元で fail-open）。
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

/**
 * ゲートを1つ実行し、落ちたときだけ差し戻し用の出力を返す。
 * 実行できなかった場合（npm が無い・タイムアウト）は通過扱いにする（fail-open）。
 *
 * @param {string} npmScript 実行する npm script 名
 * @returns {string | null} 落ちたときの出力。通過・実行不能なら null
 */
function collectGateFailure(npmScript) {
  const result = spawnSync('npm', ['run', '--silent', npmScript], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: GATE_TIMEOUT_MS
  })
  if (result.error || result.status === 0) return null

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output
}

function main() {
  // Claude Code の hook 契約（外部仕様）：Stop フックはイベント情報を JSON として
  // 子プロセスの標準入力（fd 0）経由で渡す。stop_hook_active は本フック起点の継続かを示す。
  const input = JSON.parse(readFileSync(0, 'utf8'))

  // この停止自体が本フックの再開由来なら、もう走らせない（1回だけ・無限ループ防止）。
  if (input?.stop_hook_active) return

  const failures = selectTurnEndGates(collectChangedPaths())
    .map((npmScript) => ({ npmScript, output: collectGateFailure(npmScript) }))
    .filter(({ output }) => output !== null)
  if (failures.length === 0) return

  const reason = [
    'ターン末ゲートが落ちました。ローカルで修正してから終了してください（push 後に GitHub Actions で落とさないため）。',
    ...failures.map(({ npmScript, output }) => `\n### npm run ${npmScript}\n\n${output}`)
  ].join('\n')

  // Stop フックの契約：decision: "block" にすると reason がモデルに渡り、ターンを継続する。
  process.stdout.write(JSON.stringify({ decision: 'block', reason }))
}

try {
  main()
} catch {
  // 判定できないときは作業をブロックしない（fail-open）。
  process.exit(0)
}
