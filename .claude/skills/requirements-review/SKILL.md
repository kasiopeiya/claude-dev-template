---
name: requirements-review
description: 要件定義書（docs/requirements.md）を requirements-doc-policy.md の判定基準で専用レビューする。/requirements-review コマンドが呼ばれたとき、またはユーザーが要件定義書（PRD）のレビュー・品質チェックを依頼したときに使用する。What/How の切り分け・詳細の決め打ち・エコシステムマップ・業務/機能/非機能要件・SLI/SLO・トレーサビリティ・BABOK 品質を1項目ずつ照合し、凍結してよい品質かを合否で判定する。汎用ドキュメントレビュー（/doc-review）とは責務が異なり、要件定義書に特化する。
argument-hint: '[file-path]（省略時は docs/requirements.md）'
context: fork
agent: requirements-reviewer-agent
---

要件定義書（PRD）をレビューしてください。

**この要件定義書は新人が作成した前提で、徹底的にレビューしてください。** 「概ね書けている」「意図は伝わる」で済ませず、What に紛れ込んだ How・設計で決めるべき詳細の決め打ち・抽象語の翻訳漏れ・トレーサビリティの欠落・非機能要件の抜けなど、後工程で最も高くつく欠陥が必ず1つ以上潜んでいると仮定し、それを能動的に探してください。判断に迷ったら甘くせず厳しい側に倒してください。

引数が空の場合は `docs/requirements.md` を対象とします。引数にファイルパスがある場合はそれを対象とします。

判定基準の唯一の正典は `docs/policy/requirements-doc-policy.md` です。本ファイルへ基準を転記しません。agent は実行時にこのポリシーを Read し、レビューチェックリスト表の全行と BABOK 品質チェックリストの全項目を1行ずつ照合してください。

引数: $ARGUMENTS
