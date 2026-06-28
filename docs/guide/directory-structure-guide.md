# ディレクトリ構成ガイド

## 対象読者

新規開発の初期に、プロジェクトのディレクトリ／パッケージ構成の方針を決めたい人 / AIエージェント。

## 目的

ディレクトリ構成の代表的アプローチのトレードオフと選定基準を示し、**プロジェクトの成長を見越して最適な構成を絞り込む判断を助ける**こと。「先を見越して意図的に決める」立場は [new-development-policy](../policy/new-development-policy.md)、方向性の判断基準（ドメインを語らせる＝Screaming・凝集結合）は [application-architecture-policy](../policy/application-architecture-policy.md) に従う。

決定そのもの（このプロジェクトが何を選び、なぜそうしたか）は **ADR（`docs/adr/`）＋プロジェクト設計書** に記録する。本ガイドは決定を助ける道具に徹する。

> [!IMPORTANT]
> **（AI・必須）** 各アプローチの教科書的解説の書き写しはしない（限界費用が高く負債になる）。本ガイドは「絞り込みの判断補助」に絞る。

## 代表的アプローチとトレードオフ

| アプローチ | 何で切るか | 向く状況 | 弱み |
|---|---|---|---|
| レイヤー型（package by layer） | 技術レイヤー（`controllers/` `services/` `models/` …） | ごく小規模・短命・FW 規定にそのまま乗る | 1機能の変更が全フォルダに散る／ドメインを語らない／成長で破綻 |
| 機能・ドメイン型（package by feature） | ドメイン／機能（`billing/` `user/` …、各内に層を持つ） | 機能が増える・将来分割したい・チーム並行開発 | 横断の共有物の置き場に規律が要る |
| 混成（bounded context ＋ 内部レイヤー） | 上位は境界づけられたコンテキスト、内側に層 | モジュラモノリス・中〜大規模 | 境界を引く設計の前提が要る |
| ポート&アダプタ型 | `domain/ application/ adapters(in/out)/` | 差し替え可能性を構造で強制したい | 小規模には過剰になりうる（[原則4](../policy/refined-engineer-judgment-principles.md)） |

## 選定基準——「先を見越す」とは何を見るか

- **成長の方向**：増えるのは機能か、技術的関心か。機能が増えるなら機能・ドメイン型が高凝集を保つ（1変更を1フォルダに閉じる）。
- **将来の分割**：後でサービス／モジュールへ割る見込みがあるなら、機能・ドメイン型／混成が抽出を安くする。
- **チーム分担**：機能単位で並行開発するなら機能・ドメイン型がコンフリクトを減らす。
- **既定の方向**：[application-architecture-policy §5](../policy/application-architecture-policy.md) に従いドメインを語らせる。FW 既定の scaffold（レイヤー型）から始めても、成長を見越すなら機能・ドメイン型へ寄せる。

> [!TIP]
> 判定テスト：**「将来"同時に変わる"ものが同じフォルダに集まり、"別々に変わる／別々に切り出す"ものが分かれているか」**（高凝集・低結合の構成版）。Yes に近づくアプローチを選ぶ。

## 関連

- [new-development-policy](../policy/new-development-policy.md)：先を見越して意図的に決めるという立場
- [application-architecture-policy](../policy/application-architecture-policy.md)：方向性の判断基準（Screaming・凝集結合）
- [architecture-selection-guide](architecture-selection-guide.md)：アーキテクチャスタイル選定（構成はスタイルに従う面がある）
