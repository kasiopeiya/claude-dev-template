module.exports = {
  printWidth: 100,
  tabWidth: 2,
  singleQuote: true,
  trailingComma: 'none',
  semi: false,
  overrides: [
    {
      // typescript.md「改行スタイル」を機械で守らせる。既定の preserve は書き手の改行を残し、
      // 1行に収まるオブジェクトも展開されたまま通ってしまう
      files: ['*.ts', '*.tsx'],
      options: { objectWrap: 'collapse' }
    }
  ]
}
