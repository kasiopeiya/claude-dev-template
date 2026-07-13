// 責務: sample/ 配下の静的解析(ESLint)ルールを typescript.md / cdk.md に沿って一元定義する

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'

import awsCdkLibBarrelImport from './eslint-rules/awsCdkLibBarrelImport.mjs'

export default tseslint.config(
  // 既存の別プロジェクト(cdk/)は独自の eslint.config を持つため対象外にする
  { ignores: ['**/node_modules/**', 'cdk/**', 'dist/**', '**/*.d.ts'] },

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

      // ② 未使用の引数を検出（args:'all' で optional 引数を含む全引数を対象。_ 始まりは意図的な未使用として許容）
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
      'local/aws-cdk-lib-barrel-import': 'error'
    }
  }
)
