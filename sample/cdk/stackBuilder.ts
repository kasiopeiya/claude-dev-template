/**
 * 環境ごとにスタックを構築するためのビルダークラス
 * 開発環境のみ使用するスタックなどがあることを考慮し、環境別にビルダークラスを分離
 */

import { type App, type Stack } from 'aws-cdk-lib'

import { devParameter, stgParameter, prdParameter, type Parameter } from '../parameter'
import { BaseStack } from './stack/baseStack'
import { AppStack } from './stack/appStack'

/**
 * 開発環境のスタック構築
 */
export class DevStackBuilder {
  private readonly param: Parameter = devParameter

  constructor(app: App) {
    this.build(app)
  }

  build(app: App): Stack[] {
    const baseStack = new BaseStack(app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(app, `${this.param.prefix}-app-stack`, { env: this.param.env })
    return [baseStack, appStack]
  }
}

/**
 * 検証環境のスタック構築
 */
export class StgStackBuilder {
  private readonly param: Parameter = stgParameter

  constructor(app: App) {
    this.build(app)
  }

  build(app: App): Stack[] {
    const baseStack = new BaseStack(app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(app, `${this.param.prefix}-app-stack`, { env: this.param.env })
    return [baseStack, appStack]
  }
}

/**
 * 本番環境のスタック構築
 */
export class PrdStackBuilder {
  private readonly param: Parameter = prdParameter

  constructor(app: App) {
    this.build(app)
  }

  build(app: App): Stack[] {
    const baseStack = new BaseStack(app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(app, `${this.param.prefix}-app-stack`, { env: this.param.env })
    // 本番環境のみAlarm通知が必須
    appStack.addAlarms()
    return [baseStack, appStack]
  }
}
