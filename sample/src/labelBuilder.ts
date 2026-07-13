// 責務: ラベル文字列の生成のみを担う

export function buildLabel(name: string): string {
  return `user:${name}`
}
