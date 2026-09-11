# インフラ設計

AWS/IaC で構築したインフラを変更・レビューする開発者／AI が、現在のインフラ構成概要と、なぜこの構成なのかを知りたいときに参照する。  
リソースの個別設定・具体値は `infra/` 配下の CDK コードが正であり、本書はそこから読み取れない全体像と理由を書く。  
そのリソースを CDK でどう作り・変えるか（IaC 管理方針・スタック設計・命名規約）は [iac-design](iac-design.md) が持つ。

## 目次

- [基本方針](#基本方針)
- [アーキテクチャ概要](#アーキテクチャ概要)
  - [全体インフラ構成図](#全体インフラ構成図)
  - [アカウントと環境構成](#アカウントと環境構成)
  - [ネットワーク構成図](#ネットワーク構成図)
- [前提と制約](#前提と制約)
  - [技術的制約](#技術的制約)
  - [組織の制約](#組織の制約)
- [運用監視](#運用監視)

## 基本方針

**運用に人手をかけないこと**を最優先し、常時稼働のサーバを持たないサーバレス構成で組む。

- CloudFrontやLambdaを中心とした構成でVPCを持たない
- DBはS3を使用し1レコード1 JSONで代用

## アーキテクチャ概要

### 全体インフラ構成図

![](./img/infra-architecture.png)

<details>
<summary>設計意図</summary>

- ゲートウェイに API Gateway ではなく Lambda Function URLs を使うのは、API Gateway 特有の変換処理・APIキー管理・使用量プランがいずれも不要で、機能過剰と判断したためである。

- フロントエンドの配信に S3 と CloudFront を選んだのは、SPA構成であり、静的ファイルなら配信にサーバが要らないためである。  
  API も同じ CloudFront から返すので、画面と API が同一オリジンになり CORS の設定も要らない。

- SaaSのスタブをデプロイすることで自チーム内での内部結合テストを可能にする

</details>

### アカウントと環境構成

1つのアカウントには1つの環境だけを置く。

| アカウント名   | 環境名 | 主な用途                                 |
| -------------- | ------ | ---------------------------------------- |
| 開発アカウント | dev    | CDKデプロイ確認・チーム内部結合テスト    |
| 検証アカウント | stg    | 外部システムとの結合テスト・リリース判定 |
| 本番アカウント | prd    | プロダクション                           |

### ネットワーク構成図

VPC は作らない。エンドユーザーはすべてCloudFront経由でアクセスさせる。

```mermaid
graph LR
    User([👤 エンドユーザー])
    SaaS[☁️ 外部 SaaS]

    subgraph AWS["AWS アカウント"]
        subgraph Open["🌐 インターネットに公開する唯一の入口"]
            CF[📡 CloudFront]
        end
        subgraph Closed["🔐 CloudFront からのみ到達可能"]
            S3[(📦 S3<br/>フロントエンド配信)]
            FURL[🚪 Lambda Function URL]
        end
        Lambda[⚙️ Lambda<br/>バックエンド処理]
        Stub[⚙️ SaaS スタブ Lambda<br/>dev のみ]
    end

    User -->|HTTPS| CF
    CF -->|静的ファイル| S3
    CF -->|API リクエスト| FURL
    FURL --> Lambda
    Lambda -->|stg / prd| SaaS
    Lambda -->|dev| Stub
    User -. ❌ 直接アクセス不可 .-> S3
    User -. ❌ 直接アクセス不可 .-> FURL

    classDef actor fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef open fill:#87CEEB,stroke:#00008B,stroke-width:4px,color:darkblue
    classDef closed fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef external fill:#FFE4B5,stroke:#333,stroke-width:2px,color:black

    class User actor
    class CF open
    class S3,FURL,Lambda,Stub closed
    class SaaS external
```

<details>
<summary>設計意図</summary>

- 外部に公開するのは CloudFront だけにして、S3 と Function URL には CloudFront からのみ到達させる。入口が1つなら、アクセス制御・ログ・WAF をそこに集約できる。

</details>

## 前提と制約

### 技術的制約

| 前提・制約                   | 内容                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| スタブと本物の SaaS がずれる | dev を通った変更が stg 以降で落ちうる。SaaS 側の仕様変更にスタブを追従させる責任はこちら側にある |
| dev でアラームが鳴らない     | 通知先を prd にしか置かないため、dev の異常はデプロイした本人が気づくしかない                    |

### 組織の制約

組織が課す制約は [iac-design](iac-design.md) が持つ。

## 運用監視

何を監視項目にし、どこにしきい値を置くかの考え方は [monitoring-policy](../../../docs/policy/monitoring-policy.md) が持つ。本書は全体像だけを示す。

```mermaid
graph LR
    subgraph Src["監視対象"]
        CF[📡 CloudFront]
        Lambda[⚙️ Lambda]
    end
    subgraph Collect["収集"]
        AccessLog[(📦 S3<br/>アクセスログ)]
        Logs[📝 CloudWatch Logs<br/>アプリケーションログ]
        Metrics[📊 CloudWatch メトリクス]
        Trace[🔍 X-Ray トレース]
    end
    Alarm[🚨 CloudWatch アラーム<br/>prd のみ]
    Topic[📨 SNS Topic<br/>BaseStack]
    Ops([👤 運用担当])

    CF --> AccessLog
    CF --> Metrics
    Lambda --> Logs
    Lambda --> Metrics
    Lambda --> Trace
    Metrics --> Alarm
    Alarm -->|しきい値超過| Topic
    Topic -->|通知| Ops

    classDef target fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef alert fill:#FFB6C1,stroke:#DC143C,stroke-width:2px,color:black
    classDef actor fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen

    class CF,Lambda target
    class AccessLog,Logs,Metrics,Trace store
    class Alarm,Topic alert
    class Ops actor
```

<details>
<summary>設計意図</summary>

アラーム通知を prd だけで有効にするのは、行動につながらない通知を増やさないためである。

</details>
