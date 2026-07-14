// 責務: sample/ 配下の静的解析(ESLint)ルールを typescript.md / cdk.md に沿って一元定義する

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'
import importPlugin from 'eslint-plugin-import'
import sonarjs from 'eslint-plugin-sonarjs'
import globals from 'globals'

import awsCdkLibBarrelImport from './eslint-rules/awsCdkLibBarrelImport.mjs'

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
      import: importPlugin,
      sonarjs,
      local: { rules: { 'aws-cdk-lib-barrel-import': awsCdkLibBarrelImport } }
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

      // ③ import 順序（typescript.md）: 標準ライブラリ → サードパーティ → 自作、各グループ間に空行
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', ['internal', 'parent', 'sibling', 'index']],
          'newlines-between': 'always'
        }
      ],
      'import/first': 'error',

      // ④ aws-cdk-lib のサービスモジュールは barrel 形式へ統一（cdk.md）。名前空間 import は自動修正される
      'local/aws-cdk-lib-barrel-import': 'error',

      // ⑤ 型安全: any を禁止し型システムを使わせる（typescript.md「any を避ける」）
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

  // アプリロジック(src)限定: マジックナンバーを定数へ切り出させる（typescript.md「定数は目的が伝わる名前に」）。
  // CDK はメモリ量・タイムアウト・しきい値など設定値としての数値リテラルが正当なため対象外にする（過剰ゲート化の回避）
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-magic-numbers': [
        'error',
        { ignore: [0, 1, -1], ignoreArrayIndexes: true, ignoreDefaultValues: true, enforceConst: true }
      ]
    }
  },

  // テストコードは期待値としての数値リテラルを直書きするのが読みやすいため、マジックナンバー検査から外す
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { 'no-magic-numbers': 'off' }
  },

  // 型情報が必要なルール(型対応 lint)。src と cdk のソースを対象にし、型サービスを有効化する。
  // cdk/test は cdk/tsconfig の対象外のため、ここでは含めない
  {
    files: ['src/**/*.ts', 'cdk/bin/**/*.ts', 'cdk/lib/**/*.ts', 'cdk/stackBuilder.ts', 'cdk/parameter.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // ⑩ 非同期: await 忘れ(浮いた Promise)と Promise の誤用は実バグにつながるため error
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // require-await は「async ポートを満たすための await なし async 実装」を誤検知するため warn 止め（ratchet）
      '@typescript-eslint/require-await': 'warn'
    }
  }
)
