module.exports = {
  printWidth: 100,
  tabWidth: 2,
  singleQuote: true,
  trailingComma: 'none',
  semi: false,
  overrides: [
    {
      // 1行に収まるオブジェクトはインラインに畳む（行数を減らして一覧性を上げる）。既定の preserve は
      // 書き手の改行を残し、1行に収まるオブジェクトも展開されたまま通ってしまう
      files: ['*.ts', '*.tsx'],
      options: { objectWrap: 'collapse' }
    }
  ]
}
