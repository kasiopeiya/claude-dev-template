# samples — 参照実装

`app/`・`infra/` に実装を、`docs/` に設計書を書き起こすときの**手本**。動く実装と書き上がった設計書がここにあるので、AI は書き始める前にこれを読んで構造・命名・テストの粒度と、設計書の様式を掴む。

> [!IMPORTANT]
> **（AI・必須）ここは書き換えない。** 手本が変わると、以降に生まれる実装・設計書すべての手本が変わる。実装は `app/`・`infra/`、設計書は `docs/` に書く。

## 何があるか

| 置き場                               | 中身                                                                                        | 手本になるもの                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [app/backend](app/backend/README.md) | クリーンアーキテクチャのユーザー登録（domain / usecase / infrastructure / presentation）    | レイヤーの切り方、依存性逆転、値オブジェクト、ビジネス例外と技術例外の分離 |
| `infra`                              | S3 イベント通知の CDK スタック（BaseStack / AppStack / Construct / Lambda）                 | スタック分割、環境差分の出し方、Construct の粒度、cdk-nag の抑制の書き方   |
| `docs`                               | 設計書（`design/cicd-design.md`・`design/infrastructure-design.md`）と ADR（`design/adr/`） | 設計書の構成と図の粒度、ADR のフル版／軽量版の書き分け                     |

テストの手本も同じ場所にある。`app/backend/test/` はアーキテクチャテスト（レイヤー境界・循環依存・凝集度）、`infra/test/` は CDK のスナップショットテストと fine-grained assertions。

## どのポリシー・ガイドの実例か

実装は次の判断基準に沿って書かれている。**なぜそうなっているか**はサンプルではなくこちらが持つ。

- [application-architecture-policy](../docs/policy/application-architecture-policy.md)：詳細を差し替え可能に保つ構造
- [application-design-policy](../docs/policy/application-design-policy.md)：クラス・関数・エラーの設計
- [cdk-design-policy](../docs/policy/cdk-design-policy.md)：スタック分割・環境差分・Construct 設計
- [unit-test-policy](../docs/policy/unit-test-policy.md)：単体テストの粒度とテストダブル
- [clean-architecture-guide](../docs/guide/clean-architecture-guide.md)：レイヤーの考え方
- [ddd-tactical-design-guide](../docs/guide/ddd-tactical-design-guide.md)：値オブジェクト・エンティティの作り方

## 使い方

1. 書こうとしているものに近いサンプルを読む
2. `app/`・`infra/` に**写して**、自分のドメインに置き換える。丸ごとコピーせず、要る層だけ取る
3. ルート設定（`knip.jsonc` の workspace、`eslint.config.mjs` の glob、`package.json` の `check:static`、`.github/workflows/pipeline.yml` の `ci-common`）に、新しく作ったワークスペースを足す

現在 `app/`・`infra/` は空で、CI の `ci-app`・`ci-cdk`・`cdk-deploy` はその間スキップされ続ける。実装を置くと自動で動き出す。

## 検査の扱い

サンプルは腐ると害になる（AI が古い書き方を真似る）ため、実装コードと同じ静的解析を受ける。ESLint・knip・型検査・ポリシー hook はすべて `samples/` を対象にしている。

一方 GitHub Actions の型検査・テストジョブ（`ci-app`・`ci-cdk`）は `app/`・`infra/` を見たまま休眠させてある。サンプルの単体テスト・アーキテクチャテスト・CDK スナップショットテストは、手元で次を実行して確認する。

```bash
npm run check:static                                          # lint・knip・両ワークスペースの型検査
(cd samples/app/backend && npm run test)                      # 単体＋アーキテクチャテスト
(cd samples/infra && npm run test:snap && npm run test:fga)   # CDK スナップショット＋個別プロパティ検査
```
