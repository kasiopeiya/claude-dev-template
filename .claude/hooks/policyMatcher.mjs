// 責務: 編集対象パスにどのポリシーが適用されるかの判定（frontmatter の applies-to パースと glob マッチ）のみを担う。
//
// 設計意図（WHY）:
// - ポリシーの「中身」は一切持たない。どのファイルにどのポリシーが効くかは各ポリシー側の
//   frontmatter `hook.applies-to` が宣言し、ここはそれを走査してマッチを集めるだけ。
// - 入出力（stdin/stdout）を持つ policy-loader.mjs から判定ロジックを分離してある。
//   判定は入出力と別の関心事であり、分離することで hook を起動せずに単体検証できる。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  convertGlobToRegExp,
  extractFrontmatter,
  parseFrontmatterList
} from './frontmatterList.mjs'

/** frontmatter テキストから `applies-to` のグロブ配列を返す。キーが無ければ []。対応書式は parseFrontmatterList に従う。 */
export function parseAppliesTo(frontmatter) {
  return parseFrontmatterList(frontmatter, 'applies-to')
}

/** ポリシーファイルの frontmatter から applies-to のグロブ配列を返す。frontmatter が無ければ []。 */
function readAppliesTo(policyFilePath) {
  const frontmatter = extractFrontmatter(readFileSync(policyFilePath, 'utf8'))
  return frontmatter ? parseAppliesTo(frontmatter) : []
}

/** policyDir 内の *.md を走査し、targetRelativePath にマッチするポリシーのファイル名配列を返す。 */
export function collectMatchingPolicies(targetRelativePath, policyDir) {
  const matchedPolicyNames = []
  for (const name of readdirSync(policyDir)) {
    if (!name.endsWith('.md')) continue
    const globs = readAppliesTo(resolve(policyDir, name))
    if (globs.some((glob) => convertGlobToRegExp(glob).test(targetRelativePath))) {
      matchedPolicyNames.push(name)
    }
  }
  return matchedPolicyNames
}
