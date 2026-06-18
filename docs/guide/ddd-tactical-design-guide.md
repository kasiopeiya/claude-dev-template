# DDD 戦術的設計ガイド

> [!NOTE]
> 本ガイドは骨子のみ。中身は今後整備する。

## 対象読者

ドメインモデルを設計／実装したい人 / AIエージェントが、DDD の戦術的設計パターンを具体的にどう書くか知りたいとき。

## 目的

DDD の戦術的設計（エンティティ・値オブジェクト・集約・リポジトリなど）のノウハウをまとめ、ドメインモデルを実装する際の手引きとする。判断基準（良い設計とは何か）は [application-design-policy](../policy/application-design-policy.md) に従い、本ガイドは「具体的にどう実装するか」の手順・例に集中する。

> [!IMPORTANT]
> DDD の教科書的解説の書き写しはしない（限界費用が高く負債になる）。理論は書籍に委ね、本ガイドは「このプロジェクトでどう実装・レビューするか」の手引きに絞る。

## 記載予定の内容

- 戦術的設計の構成要素（エンティティ / 値オブジェクト / 集約 / リポジトリ / ドメインサービス）
- 各要素の実装パターンと判断基準（どれをいつ使うか）
- アンチパターン（貧血ドメインモデル など）

## 関連

- [application-design-policy](../policy/application-design-policy.md)：判断基準（良い設計とは何か）
- [application-architecture-policy](../policy/application-architecture-policy.md)：マクロ構造の判断基準
