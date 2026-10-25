// 責務: audit-dependencies.mjs が「検査できなかった」を合格にせず、落とす理由を取り違えて報告しないことを守る。
//   npm audit は偽の npm コマンドで差し替える。許容リストはスクリプト自身が持つ実物を使うので、
//   許容エントリの根拠が失効して消えたあとも、このテストは通る（その分、検出力は下がる）。

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  createFakeCommand,
  createRepositoryWithCiScripts,
  removeTemporaryDirectories,
  runCiScript
} from './ciScriptHarness.mjs'

const IS_WINDOWS = process.platform === 'win32'

after(removeTemporaryDirectories)

// 偽の npm: --prefix で渡されたディレクトリごとに、決まった JSON を返す（'*' は既定）
function createFakeNpm(reportByDirectory) {
  return createFakeCommand(
    'npm',
    `const reports = ${JSON.stringify(reportByDirectory)}
const directory = process.argv[process.argv.indexOf('--prefix') + 1]
const report = reports[directory] ?? reports['*']
process.stdout.write(JSON.stringify(report))
process.exit(report.error || Object.keys(report.vulnerabilities ?? {}).length > 0 ? 1 : 0)
`
  )
}

function runAuditDependencies(fakeNpmDirectory) {
  const repositoryRoot = createRepositoryWithCiScripts()
  return runCiScript({
    scriptPath: join(repositoryRoot, 'scripts/ci/audit-dependencies.mjs'),
    workingDirectory: repositoryRoot,
    fakeCommandDirectory: fakeNpmDirectory
  })
}

describe('依存の脆弱性監査（audit-dependencies）', { skip: IS_WINDOWS }, () => {
  const sut = runAuditDependencies

  test('npm audit が監査結果を返せなかったとき、脆弱性なしとは報告せず落とす', () => {
    const fakeNpmDirectory = createFakeNpm({
      '*': { error: { code: 'E503', summary: 'registry down' } }
    })

    const result = sut(fakeNpmDirectory)

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout, /脆弱性なし/)
    assert.match(result.stderr, /E503/)
  })

  test('npm audit の出力に脆弱性の一覧が無いとき、脆弱性なしとは報告せず落とす', () => {
    const fakeNpmDirectory = createFakeNpm({ '*': {} })

    const result = sut(fakeNpmDirectory)

    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stdout, /脆弱性なし/)
    assert.match(result.stderr, /脆弱性の一覧が無い/)
  })

  test('許容した経路に別の経路が加わったとき、許容エントリが失効したとは報告せず、増えた経路を落とす', () => {
    const advisoryUrls = [
      'https://github.com/advisories/GHSA-q2hr-2g5m-vwhr',
      'https://github.com/advisories/GHSA-qhr7-859c-m2p7',
      'https://github.com/advisories/GHSA-6j4f-fj2g-mc7p'
    ]
    const braceExpansion = {
      name: 'brace-expansion',
      severity: 'high',
      range: '<5.0.12',
      via: advisoryUrls.map((url) => ({ url })),
      nodes: [
        'node_modules/aws-cdk-lib/node_modules/brace-expansion',
        'node_modules/brace-expansion'
      ]
    }
    const fakeNpmDirectory = createFakeNpm({
      'samples/infra': { vulnerabilities: { 'brace-expansion': braceExpansion } },
      '*': { vulnerabilities: {} }
    })

    const result = sut(fakeNpmDirectory)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /経路: node_modules\/brace-expansion\n/)
    assert.doesNotMatch(result.stderr, /もう当たらない/)
  })
})
