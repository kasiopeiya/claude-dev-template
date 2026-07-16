/**
 * 環境ごとにスタックを構築するためのビルダークラス
 * 開発環境のみ使用するスタックなどがあることを考慮し、環境別にビルダークラスを分離
 */

import { type App, type Stack } from 'aws-cdk-lib'

import { devParameter, stgParameter, prdParameter, type Parameter } from './parameter'
import { BaseStack } from './lib/stack/baseStack'
import { AppStack } from './lib/stack/appStack'

/**
 * 開発環境のスタック構築
 */
export class DevStackBuilder {
  private readonly param: Parameter = devParameter

  constructor(
    private readonly app: App,
    // snapshot test では env を undefined にするため、デフォルト値を devParameter.env に設定
    private readonly env: Parameter['env'] = devParameter.env
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.env,
      topic: baseStack.topic
    })
    return [baseStack, appStack]
  }
}

/**
 * 検証環境のスタック構築
 */
export class StgStackBuilder {
  private readonly param: Parameter = stgParameter

  constructor(
    private readonly app: App,
    private readonly env: Parameter['env'] = stgParameter.env
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.env,
      topic: baseStack.topic
    })
    return [baseStack, appStack]
  }
}

/**
 * 本番環境のスタック構築
 */
export class PrdStackBuilder {
  private readonly param: Parameter = prdParameter

  constructor(
    private readonly app: App,
    private readonly env: Parameter['env'] = prdParameter.env
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.env,
      topic: baseStack.topic
    })
    // 本番環境のみAlarm通知が必須
    appStack.addAlarms()
    return [baseStack, appStack]
  }
}
