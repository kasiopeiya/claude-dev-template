# CI/CD パイプライン設計

このリポジトリの CI/CD を変更・レビューする開発者／AI が、**なぜこの構成なのか**を知りたいときに参照する。  
何がどの条件で実行されるかは `.github/` 配下のワークフロー定義が正であり、本書はそこから読み取れない全体像と理由を書く。

## 基本方針：トランクベースで開発を高速に回す

**小さい変更を頻繁に main へ入れられること**を優先し、それが成り立つように CI/CD を設計した。

| 設計ポイント                                                       | 方針                                                                                                                                                                                                                      | なぜ                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 実環境へのデプロイをいつやるか                                     | 最も時間のかかる AWS 環境へのデプロイ工程——deploy と結合テスト——を、main へマージした**後**に回す（[ADR-001](../adr/001-post-merge-dev-deploy.md)）                                                                       | マージまでの経路から最も遅い工程が消え、main に入れるまでのサイクルが大きく縮む。デプロイ失敗が起きても、修正の PR を即座に出せる                                                                                          |
| CI を充実させつつ、実行時間をどう短くするか                        | job の並列実行と、変更種別判定（変更されたファイルの種別に応じた job 実行。例：docs のみの変更）で両立を図る                                                                                                              | AI 駆動開発では静的解析やテストを充実させ、機械的な仕組みで品質を担保することが重要である。一方でこれらの増加は、開発スピードを重視するトランクベース開発の思想と衝突してしまう                                            |
| コーディングエージェント開発のレビューボトルネックにどう対応するか | 2つ打つ。PR の変更行数に上限を定めて超えたらレビューを拒否できるようにし、人間がレビューすべき PR と AI レビューのみで通す PR を AI に仕分けさせる（判定方針は [pr-review-policy](../policy/pr-review-policy.md) に準拠） | AI は大量の変更を高速にできるが、AI 成果物の認知負荷は高く、レビュー者に負担が集中してボトルネックになる。変更行数の多い PR はレビュー精度も落ち、時間もかかる。すべてのコードを人間がレビューするのは、もう現実的ではない |
| 高速開発と安全性をどう両立するか                                   | 人間が手動で操作する工程を可能な限り排除する（PR 作成の自動化でマージ先の指定ミスを防ぎ、status check で CI がエラーのコードをマージできなくする）。マージ可否は1つのゲートに集約する                                     | 安全に高速開発するには、ヒューマンエラーを防止する仕組み作りが要る。人の注意力に頼ると、速く回すほど事故の機会が増え、手戻りが速さを打ち消す                                                                               |

## パイプラインの全体像

### マージまで

AIへの指示：この図を２つに分割してください。cicd-gateまでとAI判定を分ける。図が大きすぎるので。

```mermaid
flowchart TD
    Push([⚡ topic ブランチへ push]) --> PR[📝 PR を自動生成]
    Push --> Detect[🔍 変更種別を判定<br/>docs のみ / アプリ / CDK]
    Push --> Always

    subgraph Checks["🔀 検査（並行実行）"]
        direction TB
        Always["✓ 常時実行の検査<br/>整形・policy hook・リンク切れ・CLAUDE.md 文字数"]
        Common["✓ 全体を舐める検査<br/>lint・未使用検出・依存の脆弱性<br/>docs のみなら skip"]
        App["✓ アプリ検査<br/>app/ 変更時のみ"]
        Cdk["✓ CDK 検査<br/>infra/ 変更時のみ"]
        Always ~~~ Common ~~~ App ~~~ Cdk
    end

    Detect --> Common
    Detect --> App
    Detect --> Cdk
    Detect -->|app/ または infra/ の変更時| Diff["🔍 cdk diff をジョブサマリへ<br/>deploy はしない・ゲートに繋がない<br/>TODO(#31)"]

    Always --> Gate
    Common --> Gate
    App --> Gate
    Cdk --> Gate
    PR --> Gate

    Gate["🛡️ cicd-gate<br/>未実行を成功とみなさない"]
    Gate --> Merge([🎯 マージ可否<br/>★唯一の required check])

    Merge --> PolicyCheck{判断基準<br/>Policy・CLAUDE.md<br/>に変更?}
    PolicyCheck -->|Yes| PolicyLabel["🏷️ policy + needs-human-review を付与<br/>AI より前の決定論ステップ"]
    PolicyCheck -->|No| AiJob
    PolicyLabel --> AiJob

    AiJob["🤖 AI advisory<br/>PR 説明の書き換え・ラベル付与・前提条件チェック"]
    AiJob --> AutoMergeCheck{needs-human-review<br/>が付いている?}
    AutoMergeCheck -->|No| AutoMerge(["🔀 auto-merge<br/>merge 権限を持つ別ジョブ"])
    AutoMergeCheck -->|Yes| HumanReview(["👤 人間レビュー"])

    classDef startEnd fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef process fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef decision fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef gate fill:#87CEEB,stroke:#00008B,stroke-width:4px,color:darkblue
    classDef hollow fill:#FFE4B5,stroke:#DC143C,stroke-width:2px,stroke-dasharray: 5 5,color:black
    classDef advisory fill:#FFF9C4,stroke:#F57F17,stroke-width:2px,color:#7f4f00

    class Push,Merge startEnd
    class PR,Detect,Always,Common,App,Cdk,PolicyLabel process
    class PolicyCheck,AutoMergeCheck decision
    class Diff hollow
    class Gate gate
    class AiJob,AutoMerge,HumanReview advisory
```

### マージ後

```mermaid
flowchart LR
    Merged([🎯 main へマージ]) --> PathCheck{変わったのは?}
    PathCheck -->|app/ または infra/| Deploy
    PathCheck -->|開発フロー解説 HTML| Pages(["🌐 GitHub Pages へ公開"])
    PathCheck -->|それ以外| Skip([⏭️ 何もしない])

    subgraph Serial["🔒 直列化グループ cdk-deploy-dev（dev は1環境）"]
        direction TB
        Deploy["🚀 dev 環境へ deploy<br/>TODO(#31)"]
    end

    Deploy --> IT["🧪 結合テスト<br/>TODO(#31)"]
    IT --> Done([✅ dev = main の姿])
    Deploy -. 失敗 .-> Issue
    IT -. 失敗 .-> Issue["📌 GitHub Issue を自動起票<br/>破損に持ち主を作る"]

    classDef startEnd fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef process fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef decision fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef hollow fill:#FFE4B5,stroke:#DC143C,stroke-width:2px,stroke-dasharray: 5 5,color:black

    class Merged,Skip,Done,Pages startEnd
    class Issue,Destroy process
    class PathCheck decision
    class Deploy,IT hollow
```

## GitHubリポジトリ設定

<table class="markdown-table">
  <tr><th>項目</th><th>設定内容</th><th>壊すとどうなる</th></tr>
  <tr><td>status-check</td><td>cicd-gate を required check として登録 cicd-gateが成功しないと仕組みとしてPRマージできない</td><td>マージ可否をゲート1つに集約した決定が効かなくなり、検査を通っていない PR がマージできる</td></tr>
  <tr><td>ブランチの最新取り込み</td><td>requiredに設定</td><td>検査したコードとマージされるコードがずれる。deploy がマージの後ろにある本設計では、マージ前に main の破損を防ぐのはこの設定だけになっている</td></tr>
  <tr><td>auto-merge</td><td>有効、status-checkが成功していれば自動でマージ可能</td><td>「人間レビュー不要」と判定された PR も自動マージされず、人手待ちで滞留する</td></tr>
  <tr><td>マージ済みブランチの自動削除</td><td>有効、PRをcloseすると自動でブランチ削除</td><td>topic ブランチが溜まり続ける。auto-merge はマージを予約して即返るため、ワークフロー側では消せない</td></tr>
  <tr><td>secret</td><td>AI 実行用の OAuth トークン を設定している</td><td>AI ジョブが失敗する（advisory なのでゲートは赤くならず、AI 機能だけが静かに止まる）</td></tr>
</table>

## CI実施内容一覧

AIへの指示：CIとして実施している静的解析やテストなどをテーブルで一覧化する。コードを見ればわかるが、何をやっているのかを一覧して把握することはできないので、概要のみをまとめておく価値がある。

## 重要なポイント

| ポイント                                                          | なぜ                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| マージ可否は `cicd-gate` 1つだけで決める                          | GitHubのauto-mergeを使用してPRを自動マージする設定にしているが、その条件としてcicd-gate jobの成功を条件としている。 jobを個別に required 登録すると、検査を増やしたときの登録漏れが発生する可能性があるため、cicd-gate jobで他の必要な検査が成功したかどうか確認する。 また、Dependabotを使った自動パッケージ更新をする際も、cicd-gateという同名のjobを作れば、auto-mergeできる。 |
| cicd-gateは上流が落ちても必ず実行し、上流の結果を1つずつ確かめる  | GitHub は「実行しなかった」を「成功」と同じものとして扱う。そのため、cicd-gateで他jobの実行を判定しチェックする設計としている。                                                                                                                                                                                                                                                   |
| 変更対象を「常時実行・全体・アプリ・CDK」に分類し、検査対象を絞る | 静的解析はルールを1箇所で定義しているため、走らせるには全階層の依存が要る。だからスキップできない。条件で絞れるのは、対象の階層に閉じた検査だけ                                                                                                                                                                                                                                   |
| docs だけの変更でも落ちうる検査は、種別判定を通さず常に走らせる   | 全体検査は docs のみの PR でスキップされる。そこに置くと**その検査が最も要る場面でこそ走らない**（下表）。しかも被害は後続の無関係な PR に出る                                                                                                                                                                                                                                    |
| dev へのデプロイ経路を main の1本だけにする                       | デプロイ経路が2つ以上あると「dev にいま何があるか」が一意に決まらない。ローカルやトピックブランチからのデプロイをせずに、経路を統一することで、 異なる開発断面がデプロイされてしまう事態を防ぐ。                                                                                                                                                                                  |
| dev を触るものは、削除も含めて同じ直列化グループに入れる          | dev は1環境しかない。main への連続 push と dev の削除が並行すると CloudFormation スタックが壊れる                                                                                                                                                                                                                                                                                 |
| PR の時点では deploy せず、`cdk diff` だけを確認する              | PRをレビューする時点でdeploy はしないが、cdk diffを実行することで、意図しない置換・削除はレビューで事前確認できる。                                                                                                                                                                                                                                                               |
| main への deploy が失敗したら GitHub Issue を自動起票する         | 失敗が required check の外側で起きるため、デプロイ失敗は誰の担当にもならない。壊れた main はブランチ最新化の要求を通じて全ブランチへ配られるので、Issueを自動起票し対応させる。                                                                                                                                                                                                   |

### マージ可否は `cicd-gate` 1つだけで決める

AIへの指示：図で説明する

### 変更対象を「常時実行・全体・アプリ・CDK」に分類し、検査対象を絞る

AIへの指示：ジョブごとにどの条件（**.mdなど）で実行されるかを表で整理する

## 受け入れた制約

| 不便                           | 内容                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| レビュー時点で deploy が未検証 | CDK は deploy しないと分からないエラーが多い。IAM の制約・リソース名の衝突・サービス上限は、main へ入った後にdevデプロイして初めて分かる。 方針として高速開発を取るため、エラーがあればすぐに修正してPRを再度出せば良いという考え方。 |
| 待機中の実行が押し出される     | dev の直列化は「実行中1つ＋待機中1つ」しか保持しない。main への push が続くと待機中の deploy がキャンセルされる（最新が deploy されるので実害は無い）                                                                                 |
