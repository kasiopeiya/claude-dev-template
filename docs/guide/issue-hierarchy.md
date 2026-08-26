# Issueの階層ガイド

GitHub Issue を起票する人 / AI が、その Issue をどの親にぶら下げるか決めたいときに読む。

> [!IMPORTANT]
> **TL;DR（このガイドの決定事項）**
>
> - 階層が表すのは分解の関係だけで、種類・状態による仕分けはラベルで行う
> - 最上位は5つのフェーズIssueで、Issue番号ではなく `phase` ラベルで探す
> - 親が機械的に決まらないときは、親を付けずに起票する

## 階層の形

Issue は GitHub のネイティブ sub-issue で階層にする。sub-issue の親は1件しか持てないので、その枠を仕分けに使うと分解の関係を表せなくなる。

```text
フェーズIssue（常設。要件定義 / 開発準備 / 設計・実装 / 結合テスト / その他）
└ 起点Issue（新規開発ガイドが要件定義書から作る）
  └ スライスIssue（/to-issues が Plan から割る縦スライス）
    └ さらに分割した sub-issue
```

## 最上位のフェーズIssue

最上位は開発フローのフェーズを表す常設Issueで、名前は次の5つに固定する。探すときは `phase` ラベルを使い、Issue番号は使わない（番号はプロジェクトごとに変わるため）。

| フェーズ   | ぶら下げるもの                               |
| ---------- | -------------------------------------------- |
| 要件定義   | 要件を確定させる作業。未決事項の解消         |
| 開発準備   | ディレクトリ構成・CI・デプロイ経路などの足場 |
| 設計・実装 | 機能・非機能の設計と実装                     |
| 結合テスト | 結合テストの整備と、失敗したテストの対応     |
| その他     | 上のどれにも当たらないもの                   |

フェーズIssueは close しない。`boy-scout`・`ai-fixable`・`issue:needs-human-decision` は付けない（付けると `/sweep`・`/issue-check` が毎回拾って空回りする）。まだ無いリポジトリでは、起票を始める前に5件とも作る。

```bash
gh label create phase --description "Issue階層の最上位。開発フローのフェーズを表す常設Issue" --color "0E4B99"
gh issue create --title "<フェーズ名>" --label phase --body "<上の表のぶら下げるもの>"
```

## 親の決め方

起点Issueの親は種別で決まる。どの種別がどのフェーズに付くかは [新規開発ガイドの種別表](new-development-guide.md#起票する起点issue)にある。種別は起票時に選び終わっているので、判定の余地はない。

スライスIssue（`/to-issues` 産）は起点Issueの子にする。起点Issueが無いときだけ、各Issueに必ず書く「実装フロー（使用するSkill）」から決める。

| 実装フローの中身                                  | 親         |
| ------------------------------------------------- | ---------- |
| `/design`・`/code-dev`・`/cdk-dev` のどれかを含む | 設計・実装 |
| 含まない（ドキュメント・CI・設定だけ）            | 開発準備   |
| 含まず、`docs/requirements.md` の更新が主な成果物 | 要件定義   |

単発Issue（`/quick-issue` 産）は、**親にする Issue の「タスク一覧」から、いま起票する作業がどの行を割ったものかを1行そのまま引用できる**ときだけ、その子にする。引用できなければ親を付けない。

引用できるかを条件にするのは、それが書けるか書けないかで決まり、重要度の評価を挟まないからである。「関係がありそう」で選ばせると、AIの判定は必ず甘くなる。同じファイルを触るだけでは足りない——`CLAUDE.md` を編集するタスクを持つ Issue は多いが、そのすべての子になってよい Issue はほとんど無い。

フェーズIssueの直下にも付けない——1親あたり100件が上限で、単発Issueの量ではすぐ埋まる。

## 紐づけるコマンド

```bash
# 親のフェーズIssueを node ID つきで取る
gh issue list --label phase --state open --json number,title,id

# 親子を張る（子はURLで指定できるので node ID に変換しなくてよい）
gh api graphql -f query='mutation($parent:ID!,$childUrl:String!){addSubIssue(input:{issueId:$parent,subIssueUrl:$childUrl}){subIssue{number}}}' \
  -F parent="<親のnode ID>" -F childUrl="<子のURL>"
```

紐付けに失敗しても、**起票そのものは成功している**。失敗したら親が付かなかったことを伝えて続行する。GitHub の上限は親1件あたり100件・深さ8階層で、超えるとこのコマンドが失敗する。
