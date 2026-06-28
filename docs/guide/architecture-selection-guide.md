# アーキテクチャ選定ガイド

## 対象読者

プロジェクト初期に、システム全体の構造（トポロジー・アーキテクチャスタイル）を決めたい人 / AIエージェント。

## 目的

各選択肢のトレードオフと選定基準を示し、**このシステムのアーキテクチャ特性の優先順位から、最適な構造を絞り込む判断を助ける**こと。判断基準（特性の優先順位付け）は [application-architecture-policy](../policy/application-architecture-policy.md) に従う。

決定そのもの（このプロジェクトが何を選び、なぜそうしたか）は、本ガイドではなく **ADR（`docs/adr/`）＋プロジェクト設計書** に記録する。本ガイドは決定を助ける道具に徹する。

> [!IMPORTANT]
> **（AI・必須）** 各スタイルの教科書的解説の書き写しはしない（限界費用が高く負債になる）。理論は書籍に委ね、本ガイドは「絞り込みの判断補助」に絞る。

## 関連

- [application-architecture-policy](../policy/application-architecture-policy.md)：判断基準（特性の優先順位付け）
- [clean-architecture-guide](clean-architecture-guide.md)：レイヤード系を選んだ後のレビュー観点
- [directory-structure-guide](directory-structure-guide.md)：選んだスタイルをディレクトリ／パッケージにどう落とすか
