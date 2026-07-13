import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import simple_import_sort from 'eslint-plugin-simple-import-sort'

export default [
  { files: ['**/*.{js,mjs,cjs,ts}'] },
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2021,
        ...globals.node
      }
    },
    plugins: {
      'simple-import-sort': simple_import_sort
    },
    rules: {
      'no-new': 'off',
      'no-tabs': 'off',
      '@typescript-eslint/space-before-function-paren': 'off',
      '@typescript-eslint/indent': 'off'
    }
  },
  {
    ignores: ['**/tmp/**', '**/node_modules/**', '**/cdk.out/**', '*.d.ts', '*.js']
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended
]
