# Issueの階層ガイド

GitHub Issue を起票する人 / AI が、その Issue をどの親にぶら下げるか決めたいときに読む。

> [!IMPORTANT]
> **TL;DR（このガイドの決定事項）**
>
> - 最上位はフェーズIssueで、Issue番号ではなく `phase` ラベルで探す
> - 分解元の Issue が無いときは、**主に触るもの**でフェーズを決める
> - どのフェーズにも当たらないものは、親を付けずに起票する

## 階層の形

Issue は GitHub のネイティブ sub-issue で階層にする。sub-issue の親は1件しか持てないので、階層は分解の関係を表すことに使う。例外は最上位のフェーズIssueだけで、ここだけは分類である。

```text
フェーズIssue（常設。名前は下の表で固定）
└ 起点Issue（新規開発ガイドが要件定義書から作る）
  └ スライスIssue（/to-issues が Plan から割る縦スライス）
    └ さらに分割した sub-issue
```

## 最上位のフェーズIssue

最上位は開発フローのフェーズを表す常設Issueで、名前は次の4つに固定する。探すときは `phase` ラベルを使い、Issue番号は使わない（番号はプロジェクトごとに変わるため）。

| フェーズ   | ぶら下げるもの                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| 要件定義   | 要件定義書に関するタスク。未決事項の解消                                                                   |
| 開発準備   | 環境構築・技術スタック選定・全体構造設計（アプリアーキテクチャ・ディレクトリ構成）・CI／デプロイ経路の整備 |
| 設計・実装 | 開発系のタスク全般。単体テストも含む                                                                       |
| 結合テスト | 結合テスト・E2Eテスト。テストケース作成とテスト用の環境整備も含む                                          |

フェーズIssueは close しない。`boy-scout`・`ai-fixable`・`issue:needs-human-decision` は付けない（付けると `/sweep`・`/issue-check` が毎回拾って空回りする）。まだ無いリポジトリでは、起票を始める前に上の表のフェーズをすべて作る。

```bash
gh label create phase --description "Issue階層の最上位。開発フローのフェーズを表す常設Issue" --color "0E4B99"
gh issue create --title "<フェーズ名>" --label phase --body "<上の表のぶら下げるもの>"
```

## 親の決め方

分解元の Issue があるなら、それが親である。起点Issueの親は種別で決まり（[新規開発ガイドの種別表](new-development-guide.md#起票する起点issue)）、スライスIssue（`/to-issues` 産）は起点Issueの子にする。

分解元が無い Issue——起点Issueが無いスライスIssueと、単発Issue（`/quick-issue` 産）——は、**主に触るもの**でフェーズを決める。

| 主に触るもの                                                                         | 親           |
| ------------------------------------------------------------------------------------ | ------------ |
| `docs/requirements.md`                                                               | 要件定義     |
| 開発環境・技術スタック・アプリアーキテクチャ・ディレクトリ構成・`.github/workflows/` | 開発準備     |
| `app/`・`infra/` のコードと、その単体テスト                                          | 設計・実装   |
| 結合テスト・E2Eテストのコードと、その実行環境                                        | 結合テスト   |
| `.claude/` 配下・`docs/policy/`・`docs/design/`・`docs/guide/`                       | 親を付けない |

判定を**触るパス**で書くのは、書いてあるか書いていないかで決まり、重要度の評価を挟まないからである。「関係がありそう」で選ばせると、AIの判定は必ず甘くなる。

いちばん多いのは最終行である。ハーネス・ポリシー・設計書の手直しは開発フローのどのフェーズの作業でもないので、親を付けずに起票し、`boy-scout` ラベルで一覧する。

## 紐づけるコマンド

```bash
# 親のフェーズIssueを node ID つきで取る
gh issue list --label phase --state open --json number,title,id

# 親子を張る（子はURLで指定できるので node ID に変換しなくてよい）
gh api graphql -f query='mutation($parent:ID!,$childUrl:String!){addSubIssue(input:{issueId:$parent,subIssueUrl:$childUrl}){subIssue{number}}}' \
  -F parent="<親のnode ID>" -F childUrl="<子のURL>"
```

紐付けに失敗しても、**起票そのものは成功している**。失敗したら親が付かなかったことを伝えて続行する。

## 上限に達したらフェーズIssueを世代交代させる

GitHub の sub-issue は親1件あたり100件・深さ8階層が上限で、超えると `addSubIssue` が失敗する。close した子は枠を空けない（GitHub が上限到達時に案内するのは「sub-issue の紐付けを外す」か「新しい親を作る」のどちらかで、close は含まれない）。

上限に当たったら、**同名に連番を付けた後継Issueを作り、以後の紐付け先をそちらに切り替える。**

```bash
gh issue create --title "<フェーズ名> (2)" --label phase \
  --body "<フェーズ表の「ぶら下げるもの」>。#<前のフェーズIssue番号> の後継。"
```

旧フェーズIssueは close せず履歴として残す。`phase` ラベルで探すのは変わらないので、**同じフェーズ名のIssueが複数見つかったら、いちばん番号が大きいものに付ける。**
