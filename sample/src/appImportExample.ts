// 責務: アプリコードにおける import 順序・空行・未使用引数ルールの正しい記述例を示す

import * as crypto from 'crypto'

import { z } from 'zod'

import { buildLabel } from './labelBuilder'

export function createRequestId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function describeUser(name: string): string {
  return buildLabel(z.string().parse(name))
}
