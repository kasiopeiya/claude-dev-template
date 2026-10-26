#!/usr/bin/env node
// 責務: 3階層の npm 依存を監査し、high 以上の脆弱性で CI を落とす。
//   ただし「上流に修正版が無く、手元で直しようがない」ものだけは、根拠と失効条件を添えて許容する。
//   許容は腐る（上流が直したのに例外だけ残る）ので、使われなくなった例外は逆にエラーにする。

import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { TechnicalError } from '../lib/errors.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

// 脆弱性は「どこを変更したか」ではなく「このリポジトリが危ういか」の事実なので、階層を分けず全部舐める
const AUDIT_DIRECTORIES = ['.', 'samples/app/backend', 'samples/infra']

// どこから落とすか。high 未満を落とさないのは、受容するかが人間の判断だから
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const FAILING_SEVERITY = 'high'

// npm audit --json の標準出力の上限（1回の監査は1階層分）。脆弱性の詳細が多いと、既定の 1MiB を超えうる
const AUDIT_OUTPUT_MAX_BYTES = 32 * 1024 * 1024

/**
 * 許容する脆弱性。**上流に修正版が存在せず、手元の設定では直せないものに限る。**
 * バージョンを上げれば直るものは許容せず、上げて直す。
 *
 * `nodePathPrefix` で混入経路を1つに縛るのが要点。同じパッケージの同じ脆弱性でも、
 * 別経路（自分たちが直接足した依存など）で入ってきたものは許容せず落とす。
 */
const ALLOWED_VULNERABILITIES = [
  // samples/infra の brace-expansion は aws-cdk-lib が同梱していて、lockfile からは上げられない。
  // 根拠: aws-cdk-lib の最新版 2.272.0 も、brace-expansion 5.0.9 を同梱している（2026-10-03 確認）。
  // 失効条件: 同梱版が 5.0.12 以上の aws-cdk-lib が出たら、上げてこの3エントリを削除する。
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-q2hr-2g5m-vwhr',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  },
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-qhr7-859c-m2p7',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  },
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-6j4f-fj2g-mc7p',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  }
]

function main() {
  const audits = []
  for (const directory of AUDIT_DIRECTORIES) {
    const audit = auditDirectory(directory)
    reportDirectory(audit.directory, audit.blocking)
    audits.push(audit)
  }

  const failedDirectories = audits
    .filter(({ blocking }) => blocking.length > 0)
    .map(({ directory }) => directory)
  const matchedAllowlistKeys = new Set(audits.flatMap((audit) => [...audit.matchedAllowlistKeys]))
  const staleEntries = findStaleEntries(matchedAllowlistKeys)

  if (staleEntries.length > 0) reportStaleEntries(staleEntries)
  if (failedDirectories.length > 0) reportFailedDirectories(failedDirectories)
  if (staleEntries.length > 0 || failedDirectories.length > 0) process.exit(1)

  console.log('\nhigh 以上の脆弱性はありません。')
}

/**
 * 1階層を監査し、許容されていない high 以上の脆弱性と、効いた許容エントリを返す。
 *
 * @param {string} directory リポジトリ相対のディレクトリ
 * @returns {{ directory: string, blocking: object[], matchedAllowlistKeys: Set<string> }} 監査の結果
 */
function auditDirectory(directory) {
  return {
    directory,
    ...selectBlockingVulnerabilities(runAudit(directory), directory, ALLOWED_VULNERABILITIES)
  }
}

/**
 * npm audit を JSON で実行する。脆弱性があると npm は非ゼロ終了するため、その場合も標準出力を読む。
 *
 * npm は監査自体に失敗したとき（ロックファイルが無い・レジストリが落ちているなど）も、非ゼロ終了で
 * `{"error": ...}` だけを標準出力に出す。これを脆弱性なしと読むと、検査していないのに合格になる。
 *
 * @param {string} directory リポジトリ相対のディレクトリ
 * @returns {{ vulnerabilities: Record<string, object> }} 監査レポート
 * @throws {TechnicalError} npm audit が脆弱性の一覧を返さなかったとき
 */
function runAudit(directory) {
  const report = parseAuditOutput(directory, readAuditOutput(directory))
  if (!isObject(report) || report.error !== undefined || !isObject(report.vulnerabilities)) {
    const reason = report?.error
      ? `${report.error.code}: ${report.error.summary}`
      : '脆弱性の一覧が無い'
    throw new TechnicalError(`${directory}: npm audit が監査結果を返しませんでした（${reason}）`)
  }
  return report
}

/**
 * npm audit --json の標準出力を返す。非ゼロ終了でも、標準出力があれば返す
 * （脆弱性があるときと、監査に失敗して `{"error": ...}` を出したときの両方）。
 * 標準出力が空なら、実行時の例外をそのまま投げる。
 *
 * @param {string} directory リポジトリ相対のディレクトリ
 * @returns {string} 標準出力
 */
function readAuditOutput(directory) {
  try {
    return execFileSync('npm', ['audit', '--json', '--prefix', directory], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: AUDIT_OUTPUT_MAX_BYTES
    })
  } catch (error) {
    if (!error.stdout) throw error
    return error.stdout
  }
}

/**
 * npm audit --json の標準出力を JSON として読む。
 *
 * @param {string} directory リポジトリ相対のディレクトリ（失敗の報告に使う）
 * @param {string} auditOutput 標準出力
 * @returns {{ error?: { code: string, summary: string }, vulnerabilities?: Record<string, object> }} 読んだ JSON
 * @throws {TechnicalError} JSON として読めないとき（途中で切れた出力や、npm の警告が混じった出力）
 */
function parseAuditOutput(directory, auditOutput) {
  try {
    return JSON.parse(auditOutput)
  } catch (error) {
    throw new TechnicalError(
      `${directory}: npm audit の出力を JSON として読めませんでした（${error.message}）`,
      {
        cause: error
      }
    )
  }
}

/**
 * 値が null でないオブジェクトかを返す。
 *
 * @param {unknown} candidate 判定する値
 * @returns {boolean} null でないオブジェクトなら true
 */
function isObject(candidate) {
  return typeof candidate === 'object' && candidate !== null
}

/**
 * 監査レポートから、許容されていない high 以上の脆弱性を抜き出す。
 *
 * @param {{ vulnerabilities: Record<string, object> }} report npm audit --json の出力
 * @param {string} directory 監査対象ディレクトリ
 * @param {typeof ALLOWED_VULNERABILITIES} allowlist 許容リスト
 * @returns {{ blocking: object[], matchedAllowlistKeys: Set<string> }} 落とすべき脆弱性と、効いた許容エントリ
 */
function selectBlockingVulnerabilities(report, directory, allowlist) {
  const threshold = SEVERITY_ORDER.indexOf(FAILING_SEVERITY)
  const context = { directory, allowlist, vulnerabilityByName: report.vulnerabilities }

  const matches = Object.values(report.vulnerabilities)
    .filter((vulnerability) => SEVERITY_ORDER.indexOf(vulnerability.severity) >= threshold)
    .map((vulnerability) => ({ vulnerability, ...matchAllowlist(vulnerability, context) }))

  return {
    blocking: matches
      .filter(({ isCovered }) => !isCovered)
      .map(({ vulnerability }) => vulnerability),
    matchedAllowlistKeys: new Set(matches.flatMap(({ entries }) => entries).map(buildAllowlistKey))
  }
}

/**
 * 許容エントリのうち、どの階層のどの脆弱性にも効かなかったものを返す。
 *
 * @param {Set<string>} matchedAllowlistKeys 効いた許容エントリのキー
 * @returns {typeof ALLOWED_VULNERABILITIES} 効かなかった許容エントリ
 */
function findStaleEntries(matchedAllowlistKeys) {
  return ALLOWED_VULNERABILITIES.filter(
    (entry) => !matchedAllowlistKeys.has(buildAllowlistKey(entry))
  )
}

/**
 * 脆弱性に効く許容エントリを集め、許容リストで丸ごと覆われているかを判定する。
 *
 * 開示情報を持つ脆弱性は、開示情報も混入経路もすべて許容済みのときだけ覆われる。1つでも未許容が混じれば覆われていない。
 * 開示情報を持たず、原因パッケージの名前だけを指す傍系（via が文字列だけ）は、指している原因がすべて覆われているときだけ覆われる。
 * 原因が1つでも未許容なら傍系も落ちる。傍系が通るのは、原因が根拠付きで許容リストに載っているときだけなので、原因は隠れない。
 *
 * 覆われていなくても、効いた許容エントリは返す。許容した経路が残ったまま別の経路が増えたとき、
 * 許容エントリは失効しておらず、増えた経路だけが落とす理由だと報告するため。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {{ directory: string, allowlist: typeof ALLOWED_VULNERABILITIES, vulnerabilityByName: Record<string, object> }} context 監査対象ディレクトリ・許容リスト・監査レポートの脆弱性
 * @param {Set<string>} [pathNames] 原因をたどってきた経路の脆弱性名（循環を止める）
 * @returns {{ entries: object[], isCovered: boolean }} 効いた許容エントリと、丸ごと覆われているか
 */
function matchAllowlist(vulnerability, context, pathNames = new Set()) {
  const advisories = vulnerability.via.filter((via) => typeof via === 'object')
  if (advisories.length > 0) return matchAdvisories(vulnerability, advisories, context)

  const causeNames = vulnerability.via
  if (causeNames.length === 0 || pathNames.has(vulnerability.name)) {
    return { entries: [], isCovered: false }
  }

  const causePathNames = new Set([...pathNames, vulnerability.name])
  const causeMatches = causeNames.map((causeName) => {
    const cause = context.vulnerabilityByName[causeName]
    return cause
      ? matchAllowlist(cause, context, causePathNames)
      : { entries: [], isCovered: false }
  })
  return {
    entries: causeMatches.flatMap(({ entries }) => entries),
    isCovered: causeMatches.every(({ isCovered }) => isCovered)
  }
}

/**
 * 開示情報を持つ脆弱性について、開示情報と混入経路の組ごとに、許容しているエントリを探す。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {object[]} advisories その脆弱性の開示情報（via のうちオブジェクトのもの）
 * @param {{ directory: string, allowlist: typeof ALLOWED_VULNERABILITIES }} context 監査対象ディレクトリと許容リスト
 * @returns {{ entries: object[], isCovered: boolean }} 効いた許容エントリと、すべての組が許容済みか
 */
function matchAdvisories(vulnerability, advisories, { directory, allowlist }) {
  const findAllowlistEntry = (advisoryUrl, nodePath) =>
    allowlist.find(
      (entry) =>
        entry.directory === directory &&
        entry.packageName === vulnerability.name &&
        entry.advisoryUrl === advisoryUrl &&
        nodePath.startsWith(entry.nodePathPrefix)
    )

  const entriesByPair = advisories.flatMap((advisory) =>
    vulnerability.nodes.map((nodePath) => findAllowlistEntry(advisory.url, nodePath))
  )
  return {
    entries: entriesByPair.filter((entry) => entry !== undefined),
    isCovered: !entriesByPair.includes(undefined)
  }
}

/**
 * 許容エントリの同一性キー。どのエントリが実際に効いたかを数えるために使う。
 *
 * @param {(typeof ALLOWED_VULNERABILITIES)[number]} entry 許容エントリ
 * @returns {string} キー
 */
function buildAllowlistKey(entry) {
  return [entry.directory, entry.packageName, entry.advisoryUrl, entry.nodePathPrefix].join(' | ')
}

/**
 * 1ディレクトリ分の結果を人が読める形で出す。
 *
 * @param {string} directory 監査対象ディレクトリ
 * @param {object[]} blocking 落とすべき脆弱性
 */
function reportDirectory(directory, blocking) {
  if (blocking.length === 0) {
    console.log(`  ${directory}: high 以上の脆弱性なし`)
    return
  }

  console.error(`  ${directory}: high 以上の脆弱性 ${blocking.length} 件`)
  for (const vulnerability of blocking) {
    console.error(`    ${vulnerability.name} (${vulnerability.severity}) ${vulnerability.range}`)
    for (const nodePath of vulnerability.nodes) console.error(`      経路: ${nodePath}`)
  }
}

/**
 * どの脆弱性にも効かなかった許容エントリを報告する。
 *
 * @param {typeof ALLOWED_VULNERABILITIES} staleEntries 効かなかった許容エントリ
 */
function reportStaleEntries(staleEntries) {
  console.error(
    '\nもう当たらない許容エントリがあります。上流が直った可能性が高いので削除してください。'
  )
  for (const entry of staleEntries) {
    console.error(`  ${entry.directory}: ${entry.packageName} ${entry.advisoryUrl}`)
  }
}

/**
 * 落とすべき脆弱性があった階層と、直し方を報告する。
 *
 * @param {string[]} failedDirectories 落とすべき脆弱性があった階層
 */
function reportFailedDirectories(failedDirectories) {
  console.error(`\nhigh 以上の脆弱性があります: ${failedDirectories.join(' ')}`)
  console.error('直し方: 依存を修正版へ上げてください。上流に修正版が無い場合だけ、')
  console.error(
    '根拠と失効条件を添えて scripts/ci/audit-dependencies.mjs の許容リストに追加します。'
  )
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
