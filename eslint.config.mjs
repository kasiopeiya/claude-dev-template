// 責務: 静的解析(ESLint)ルールを一元定義する。数値上限の正は typescript.md、テストの書き方の正は unit-test-policy、それ以外の書式ルールの正はこのファイル

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'
import importPlugin from 'eslint-plugin-import-x'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'

import awsCdkLibBarrelImport from './eslint-rules/awsCdkLibBarrelImport.mjs'
import codeCommentNotation from './eslint-rules/codeCommentNotation.mjs'

// テスト名検査が拾うべき呼び出し形（unit-test-policy「テストケース名は日本語で書く」の対象）。
// it(...) 直呼び／it.skip(...) 等の修飾子付き／test.concurrent.only(...) 等の二段修飾子付き／
// it.each(...)(...)／test.concurrent.each(...)(...) 等の二段修飾子＋each／it.each`...`(...) のタグ付きテンプレートまで拾う。
// 形を1つでも落とすと、その形で書かれたテスト名だけ検査が素通りする
const TEST_NAME_CALLEE_PATHS = [
  'callee.name',
  'callee.object.name',
  'callee.object.object.name',
  'callee.callee.object.name',
  'callee.callee.object.object.name',
  'callee.tag.object.name'
]
const buildTestFunctionCallSelector = (functionNamePattern) =>
  `CallExpression:matches(${TEST_NAME_CALLEE_PATHS.map((path) => `[${path}=${functionNamePattern}]`).join(', ')})`

const JAPANESE_CHARACTER_PATTERN = '/[ぁ-んァ-ヶ一-龥]/'
const TEST_SUITE_OR_CASE_FUNCTION_NAMES = '/^(it|test|describe)$/'
const TEST_CASE_FUNCTION_NAMES = '/^(it|test)$/'

const nonJapaneseTestNameSelectors = [
  {
    // raw が引用符始まりのものだけに絞り、it.runIf(true) の真偽値引数などを誤検知しない
    selector: `${buildTestFunctionCallSelector(TEST_SUITE_OR_CASE_FUNCTION_NAMES)} > Literal.arguments:first-child[raw=/^['"]/]:not([value=${JAPANESE_CHARACTER_PATTERN}])`,
    message: 'テストケース名は日本語で書く（unit-test-policy）'
  },
  {
    selector: `${buildTestFunctionCallSelector(TEST_SUITE_OR_CASE_FUNCTION_NAMES)} > TemplateLiteral.arguments:first-child:not(:has(TemplateElement[value.raw=${JAPANESE_CHARACTER_PATTERN}]))`,
    message: 'テストケース名は日本語で書く（unit-test-policy）'
  }
]

// unit-test-policy「テストケース内にif文がある場合」はテストケース（it/test）単位の規定なので、
// describe のセットアップ処理やファイル内ヘルパー関数の if 文は対象にしない
const ifStatementInTestCaseSelector = {
  selector: `${buildTestFunctionCallSelector(TEST_CASE_FUNCTION_NAMES)} > :function.arguments IfStatement`,
  message: 'テスト内で if 文は使わない（unit-test-policy）。ケースを分けて書く'
}

export default tseslint.config(
  // 静的解析の対象外。cdk.out は CDK 合成物、*.d.ts は生成物なので除外する
  { ignores: ['**/node_modules/**', '**/cdk.out/**', 'dist/**', '**/*.d.ts'] },

  // 全ファイル共通: Node 実行環境のグローバルを有効化
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } }
  },
  // CommonJS の設定ファイル(.prettierrc.js など)
  { files: ['**/*.{js,cjs}'], languageOptions: { sourceType: 'commonjs' } },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    plugins: {
      '@stylistic': stylistic,
      'import-x': importPlugin,
      sonarjs,
      local: {
        rules: {
          'aws-cdk-lib-barrel-import': awsCdkLibBarrelImport,
          'code-comment-notation': codeCommentNotation
        }
      }
    },
    rules: {
      // ① クラス・関数の前後に空行を入れる（可読性方針）
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: ['function', 'class'] },
        { blankLine: 'always', prev: ['function', 'class'], next: '*' }
      ],
      '@stylistic/lines-between-class-members': ['error', 'always'],

      // ② 未使用の変数・引数を検出（args:'all' で optional 引数を含む全引数を対象。_ 始まりは意図的な未使用として許容）
      //    tsconfig の noUnusedLocals/noUnusedParameters と二重化し、CI ゲートで確実に落とす
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'all', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],

      // ③ import 順序: 標準ライブラリ → サードパーティ → 自作、各グループ間に空行。import はすべてファイル冒頭に集約する
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index']],
          'newlines-between': 'always'
        }
      ],
      'import-x/first': 'error',

      // ④ aws-cdk-lib のサービスモジュールは barrel 形式へ統一。名前空間 import は自動修正される
      'local/aws-cdk-lib-barrel-import': 'error',

      // コードコメントの記法(code-comment.md)をガードレール化
      'local/code-comment-notation': 'error',

      // ⑤ 型安全: any を禁止し型システムを使わせる
      '@typescript-eslint/no-explicit-any': 'error',

      // ⑥ 複雑度: Cyclomatic Complexity と Cognitive Complexity を併用する。
      //    CC は分岐数、Cognitive はネスト深度を織り込むため読みにくさをより反映する。
      //    cognitive 併用を前提に CC のしきい値は 15 へ緩めている（Issue #18 較正）
      complexity: ['error', 15],
      'sonarjs/cognitive-complexity': ['error', 15],

      // ⑦ 関数長: 50 行超で error（typescript.md の SSOT 値。コメント・空行は数えない）
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],

      // ⑧ 引数数: 4 個以上で error（typescript.md の SSOT 値。多すぎる引数はオブジェクト化を促す）
      'max-params': ['error', 3],

      // ⑨ ネスト深さ: 3 重以上で error（typescript.md「ネストは2重まで」の SSOT 値）
      'max-depth': ['error', 2]
    }
  },

  // コードコメントの記法(code-comment.md)を .tsx・.mjs にもガードレール化。
  // .ts は上の '**/*.ts' ブロックで同じ local プラグインに登録済み（プラグイン名の重複登録はエラーになるため分離）。
  // 対象は hook.applies-to と同じ3パターン（.github/workflows/*.yml はESLintの対象外のためRule本文に残す）
  {
    files: ['**/*.tsx', '**/*.mjs'],
    plugins: { local: { rules: { 'code-comment-notation': codeCommentNotation } } },
    rules: { 'local/code-comment-notation': 'error' }
  },

  // アプリロジック(src)限定: マジックナンバーを定数へ切り出させる（typescript.md「定数は目的が伝わる名前に」）。
  // CDK はメモリ量・タイムアウト・しきい値など設定値としての数値リテラルが正当なため対象外にする（過剰ゲート化の回避）
  {
    files: ['app/**/*.ts', 'samples/app/**/*.ts'],
    rules: {
      'no-magic-numbers': [
        'error',
        {
          ignore: [0, 1, -1],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          enforceConst: true
        }
      ]
    }
  },

  // テストコードは期待値としての数値リテラルを直書きするのが読みやすいため、マジックナンバー検査から外す
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { 'no-magic-numbers': 'off' }
  },

  // テストコード限定：if 文と、日本語を含まないテストケース名を機械検知する（unit-test-policy の How をガードレール化）。
  // 対象は unit-test-policy の `applies-to` と同じ3パターン（test/ 配下のヘルパーは対象外。正当な if 文まで落とさないため）
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.test.mjs'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ifStatementInTestCaseSelector,
        ...nonJapaneseTestNameSelectors
      ]
    }
  },

  // 型情報が必要なルール(型対応 lint)。app と infra のソースを対象にし、型サービスを有効化する。
  // infra/test は infra/tsconfig の対象外のため、ここでは含めない。
  // samples/ 配下は参照実装の置き場で、同じ規約で検査し続けるため同じ glob を併記する。
  // app/・infra/ 側は現在ファイルが無いが、実装を置いた瞬間に効くよう残す
  {
    files: [
      'app/**/*.ts',
      'infra/bin/**/*.ts',
      'infra/lib/**/*.ts',
      'infra/stackBuilder.ts',
      'infra/parameter.ts',
      'samples/app/**/*.ts',
      'samples/infra/bin/**/*.ts',
      'samples/infra/lib/**/*.ts',
      'samples/infra/stackBuilder.ts',
      'samples/infra/parameter.ts'
    ],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // ⑩ 非同期: await 忘れ(浮いた Promise)と Promise の誤用は実バグにつながるため error
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // await を伴わない async は非同期処理の書き忘れを疑うため error。
      // 非同期ポートを同期処理で満たす実装は async を外して Promise を直接返す
      '@typescript-eslint/require-await': 'error'
    }
  }
)
