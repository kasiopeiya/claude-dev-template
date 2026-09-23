// 責務: 編集対象パスにどの Rule（`.claude/rules/*.md`）が適用されるかの判定のみを担う。
//
// 設計意図（WHY）:
// - Rule は対象ファイルを Read した時点で標準ロードされる。新規ファイルは Read が発生せず
//   標準ロードが効かないため、policy-loader.mjs が対象ファイル不在時だけこのマッチャーで
//   肩代わりする（policy-driven-development-policy「Rule は既定で paths による標準ロードで届ける」）。
// - Rule の中身は一切持たない。どのファイルにどの Rule が効くかは各 Rule 側の frontmatter
//   `paths` が宣言し、ここはそれを走査してマッチを集めるだけ。policyMatcher.mjs と同じ形。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  convertGlobToRegExp,
  extractFrontmatter,
  parseFrontmatterList
} from './frontmatterList.mjs'

/** Rule ファイルの frontmatter から paths のグロブ配列を返す。frontmatter が無ければ []。 */
function readRulePaths(ruleFilePath) {
  const frontmatter = extractFrontmatter(readFileSync(ruleFilePath, 'utf8'))
  return frontmatter ? parseFrontmatterList(frontmatter, 'paths') : []
}

/** rulesDir 配下（サブディレクトリを含む）の *.md を走査し、targetRelativePath にマッチする Rule のファイル名配列を返す。 */
export function collectMatchingRules(targetRelativePath, rulesDir) {
  const matchedRuleNames = []
  for (const name of readdirSync(rulesDir, { recursive: true })) {
    if (!name.endsWith('.md')) continue
    const globs = readRulePaths(resolve(rulesDir, name))
    if (globs.some((glob) => convertGlobToRegExp(glob).test(targetRelativePath))) {
      matchedRuleNames.push(name)
    }
  }
  return matchedRuleNames
}
