#!/usr/bin/env node
// 責務: 追跡下の Markdown に書かれた相対リンクの参照先が実在するかを検査する。
//   リンク切れはレビューで拾う欠陥ではなく機械が判定できる事実であり、放置すると静かに溜まる（Issue #107）。

import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// [text](path) と ![alt](path) の両方。タイトル付き（"..."）も許す。
const LINK_PATTERN = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

// 参照先がリポジトリ内に無いのが正常なリンク。実在検査の対象から外す。
const EXTERNAL_PATTERN = /^(https?:|mailto:|tel:|#|<)/

/**
 * 1行から検査対象のリンク先を取り出す。
 *
 * 例示（実在しないファイルをリンク記法で書いたもの）はバッククォートで囲む約束にしており、
 * インラインコードを落とすことが偽陽性対策そのものになっている。
 *
 * @param {string} line 1行分の本文（コードフェンス内でないこと）
 * @returns {string[]} リンク先のパス
 */
function extractLinkTargets(line) {
  const withoutInlineCode = line.replace(/`+[^`]*`+/g, '')
  return [...withoutInlineCode.matchAll(LINK_PATTERN)].map((match) => match[1])
}

/**
 * リンク先を実ファイルのパスへ解決する。検査対象外なら null を返す。
 *
 * @param {string} target リンク先の文字列
 * @param {string} markdownPath リンク元 Markdown のリポジトリ相対パス
 * @returns {string | null} 解決した絶対パス
 */
function resolveTarget(target, markdownPath) {
  if (EXTERNAL_PATTERN.test(target)) return null

  // 同一文書内アンカーは実在検査の対象外。ファイル部分だけを見る。
  const [path] = target.split('#')
  if (!path) return null

  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // 不正なパーセントエンコードは、そのままのパスとして扱えば実在しないものとして落ちる
  }

  const base = decoded.startsWith('/') ? repoRoot : join(repoRoot, dirname(markdownPath))
  return resolve(base, decoded.replace(/^\//, ''))
}

/**
 * Markdown 1本を検査する。
 *
 * @param {string} markdownPath リポジトリ相対パス
 * @param {string} source ファイル全文
 * @returns {{ file: string, line: number, target: string }[]} 壊れたリンク
 */
function findBrokenLinks(markdownPath, source) {
  const broken = []
  let insideFence = false

  source.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      return
    }
    if (insideFence) return

    for (const target of extractLinkTargets(line)) {
      const resolved = resolveTarget(target, markdownPath)
      if (resolved && !existsSync(resolved)) {
        broken.push({ file: markdownPath, line: index + 1, target })
      }
    }
  })

  return broken
}

function main() {
  // 検査対象は Git の追跡下にあるものだけ。node_modules や生成物を除外する設定を持たずに済む。
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

  const broken = files.flatMap((file) =>
    findBrokenLinks(file, readFileSync(join(repoRoot, file), 'utf8'))
  )

  if (broken.length === 0) {
    console.log(`Markdown ${files.length} 本の相対リンクはすべて実在します。`)
    return
  }

  console.error('参照先が存在しない相対リンクがあります。')
  for (const { file, line, target } of broken) {
    console.error(`  ${file}:${line} -> ${target}`)
  }
  console.error(
    '\n直し方: 参照先が正しいパスかを確認してください。実在しないファイルを指す「例示」であれば、' +
      'それはリンクではありません。`[原則](x.md)` のようにバッククォートで囲んでください。'
  )
  process.exit(1)
}

main()
