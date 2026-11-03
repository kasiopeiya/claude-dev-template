#!/usr/bin/env node
// 責務: 変更するファイルのパスごとに、変更種別と、回す Skill（直接編集した場合・新規・大幅加筆の場合）を
//   1行ずつ返すことだけを担う。変更種別と Skill の対応の正典はこのファイルの FLOW_SKILL_RULES である。
//
// 設計意図（WHY）:
// - 対応を CLAUDE.md の一覧に置くと、毎セッション全文が読み込まれ、文字数を占め続ける。パスから機械的に
//   決まる判定なので、毎回読む文章ではなくコードに置き、必要なときに打たせる。
// - 一覧を AI が読んで当てはめると、Skill ごとに言い直した写しが一覧と食い違う（Issue #1528）。
//   答えをここ1か所から出せば、言い直しが要らなくなる。
// - どちらの列を使うかは決めず、両方を出す。直接編集か新規・大幅加筆かは変更の規模の判断で、
//   パスだけでは決まらないため。
// - 1つのパスの種別は1つに決まるので、規則を上から当てて最初に当たった1つを採る。
//   順序に意味がある（例: 設計書は `.md` なので、その他の文書より上に置かないと、その他の文書に取られる）。
//   規則を足すときは、より狭い条件を上に置く。
//
// 使い方: npm run --silent select-flow-skills -- <パス>...
//   出力: <パス>\t<種別>\t直接編集：<Skill>\t新規・大幅加筆：<Skill>

import path from 'node:path'

const USAGE_MESSAGE =
  '変更するファイルのパスを渡してください（例: npm run --silent select-flow-skills -- scripts/close-issues.mjs CLAUDE.md）'

// Skill の引数に、判定したパスを埋める箇所の印
const PATH_PLACEHOLDER = '<パス>'

/**
 * @typedef {object} FlowSkillRule 変更種別1つ分の規則
 * @property {string} kind 変更種別の名前
 * @property {(normalizedPath: string) => boolean} isTarget スラッシュ区切りに正規化した、作業ツリーのルート相対パスが当たるか
 * @property {string} directEditSkill 直接編集した場合に回す Skill（PATH_PLACEHOLDER はパスに置き換える）
 * @property {string} majorAdditionSkill 新規・大幅加筆の場合に回す Skill（PATH_PLACEHOLDER はパスに置き換える）
 */

/**
 * パスが、いずれかの接頭辞の配下にあるかを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @param {string[]} prefixes `/` で終わるディレクトリの接頭辞
 * @returns {boolean} 配下にあれば true
 */
function isUnderAny(normalizedPath, prefixes) {
  return prefixes.some((prefix) => normalizedPath.startsWith(prefix))
}

/**
 * パスの拡張子が、いずれかに当たるかを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @param {string[]} extensions `.` から始まる拡張子
 * @returns {boolean} 当たれば true
 */
function hasExtension(normalizedPath, extensions) {
  return extensions.some((extension) => normalizedPath.endsWith(extension))
}

/**
 * CI ワークフロー（`.github/workflows/` 配下の `.yml`・`.yaml`）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isWorkflow(normalizedPath) {
  return (
    normalizedPath.startsWith('.github/workflows/') &&
    hasExtension(normalizedPath, ['.yml', '.yaml'])
  )
}

/**
 * 要件定義書かを判定する。範囲は requirements-doc-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isRequirementsDoc(normalizedPath) {
  if (
    normalizedPath === 'docs/requirements.md' ||
    normalizedPath === 'samples/docs/requirements.md'
  )
    return true
  return normalizedPath.startsWith('docs/requirements-appendix/') && normalizedPath.endsWith('.md')
}

/**
 * ADR（`docs/adr/` 直下の `.md`）かを判定する。範囲は adr-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isAdr(normalizedPath) {
  return /^docs\/adr\/[^/]+\.md$/.test(normalizedPath)
}

/**
 * 設計書かを判定する。範囲は design-doc-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isDesignDoc(normalizedPath) {
  return (
    isUnderAny(normalizedPath, ['docs/design/', 'samples/docs/design/']) &&
    normalizedPath.endsWith('.md')
  )
}

/**
 * アプリ実装（`app/`・`samples/app/` 配下で `.md` 以外）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isAppCode(normalizedPath) {
  return isUnderAny(normalizedPath, ['app/', 'samples/app/']) && !normalizedPath.endsWith('.md')
}

/**
 * CDK（`infra/`・`samples/infra/` 配下で `.md` 以外）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isCdkCode(normalizedPath) {
  return isUnderAny(normalizedPath, ['infra/', 'samples/infra/']) && !normalizedPath.endsWith('.md')
}

/**
 * その他のコードかを判定する。範囲は /quick-code-review の「対象」節に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isOtherCode(normalizedPath) {
  if (normalizedPath.startsWith('scripts/')) return hasExtension(normalizedPath, ['.mjs', '.sh'])
  if (isUnderAny(normalizedPath, ['.claude/hooks/', 'eslint-rules/']))
    return normalizedPath.endsWith('.mjs')
  if (normalizedPath.startsWith('.claude/skills/'))
    return hasExtension(normalizedPath, ['.py', '.sh', '.js'])
  return false
}

/**
 * その他の文書（上の規則に当たらない `.md`）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isOtherDoc(normalizedPath) {
  return normalizedPath.endsWith('.md')
}

/** @type {FlowSkillRule[]} 上から当て、最初に当たった1つを採る */
const FLOW_SKILL_RULES = [
  {
    kind: 'CI ワークフロー',
    isTarget: isWorkflow,
    directEditSkill: '/actions-review',
    majorAdditionSkill: '/actions-review'
  },
  {
    kind: '要件定義書',
    isTarget: isRequirementsDoc,
    directEditSkill: '/quick-doc-review',
    majorAdditionSkill: '/requirements-review'
  },
  {
    kind: 'ADR',
    isTarget: isAdr,
    directEditSkill: '/quick-doc-review',
    majorAdditionSkill: '/create-adr'
  },
  {
    kind: '設計書',
    isTarget: isDesignDoc,
    directEditSkill: '/quick-doc-review',
    majorAdditionSkill: '/design'
  },
  {
    kind: 'アプリ実装',
    isTarget: isAppCode,
    directEditSkill: '/code-review',
    majorAdditionSkill: '/code-dev'
  },
  {
    kind: 'CDK',
    isTarget: isCdkCode,
    directEditSkill: '/cdk-review',
    majorAdditionSkill: '/cdk-dev'
  },
  {
    kind: 'その他のコード',
    isTarget: isOtherCode,
    directEditSkill: `/quick-code-review ${PATH_PLACEHOLDER}`,
    majorAdditionSkill: `/code-review ${PATH_PLACEHOLDER}`
  },
  {
    kind: 'その他の文書',
    isTarget: isOtherDoc,
    directEditSkill: '/quick-doc-review',
    majorAdditionSkill: '/doc-review'
  }
]

/** どの規則にも当たらないときに返す規則 */
const NO_MATCH_RULE = {
  kind: '該当なし',
  directEditSkill: '該当なし（直接編集）',
  majorAdditionSkill: '該当なし（直接編集）'
}

/**
 * 入力のパスを、作業ツリーのルート相対・スラッシュ区切りにそろえる。
 * 絶対パスは process.cwd()（npm script を打った作業ツリーのルート）からの相対パスにする。
 *
 * @param {string} inputPath 引数で渡されたパス
 * @returns {string} 正規化したパス
 */
function normalizePath(inputPath) {
  const relativePath = path.isAbsolute(inputPath)
    ? path.relative(process.cwd(), inputPath)
    : inputPath
  return relativePath.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
}

/**
 * 1つのパスについて、出力する1行を作る。
 *
 * @param {string} inputPath 引数で渡されたパス
 * @returns {string} `<パス>\t<種別>\t直接編集：<Skill>\t新規・大幅加筆：<Skill>`
 */
function buildOutputLine(inputPath) {
  const normalizedPath = normalizePath(inputPath)
  const rule = FLOW_SKILL_RULES.find(({ isTarget }) => isTarget(normalizedPath)) ?? NO_MATCH_RULE
  const fillPath = (skill) => skill.replaceAll(PATH_PLACEHOLDER, normalizedPath)
  return [
    normalizedPath,
    rule.kind,
    `直接編集：${fillPath(rule.directEditSkill)}`,
    `新規・大幅加筆：${fillPath(rule.majorAdditionSkill)}`
  ].join('\t')
}

const inputPaths = process.argv.slice(2)
if (inputPaths.length === 0) {
  console.error(USAGE_MESSAGE)
  process.exitCode = 1
} else {
  console.log(inputPaths.map(buildOutputLine).join('\n'))
}
