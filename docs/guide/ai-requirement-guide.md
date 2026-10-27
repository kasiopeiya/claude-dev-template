# AI要件定義ガイド

AI と要件定義を進める人が、AI に何を任せ、事前に何を整えておくかを掴むために読む。

## AI要件定義の特徴

従来のAIを使わない要件定義と比べて以下の特徴がある

### 要件定義書はAIへのインプットである

- これまでユーザーとベンダー間で認識を合わせるために要件定義書を作っていた
- つまり、対象読者は人間だけであった
- しかしAI駆動開発においてはAIも重要な読者である
- 読者が変われば記載する内容も変わってくる

### より曖昧さを排除する必要がある

- AIは行間を正しく推測することができない
- 人間が要件定義書を作る場合、人間には当然に思える常識は、明示的に書かれないことが多い
- しかし、AIが正確に開発するためには、これまで以上に曖昧さを排除していく必要がある。

```mermaid
flowchart TD
    subgraph CONV["従来の要件定義：読者は人間だけ"]
        direction LR
        C_DOC["📄 要件定義書<br/>人間同士の合意文書"]
        C_HUM["👤 人間<br/>行間を常識で補える"]
        C_OUT["⚙️ 設計・実装・テスト<br/>人間が作る"]
        C_DOC --> C_HUM --> C_OUT
    end

    subgraph AIDD["AI駆動開発の要件定義：AIも読者"]
        direction LR
        A_DOC["📄 要件定義書<br/>合意文書 ＋<br/>AIへのインプット"]
        A_HUM["👤 人間<br/>行間を常識で補える"]
        A_AI["🤖 AI<br/>行間は推測しかできない"]
        A_OUT["⚙️ 設計・実装・テスト<br/>AIが自律・高速に作る"]
        A_DOC --> A_HUM
        A_DOC --> A_AI
        A_HUM --> A_OUT
        A_AI --> A_OUT
    end

    CONV ~~~ AIDD

    classDef doc fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef human fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef ai fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef out fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen

    class C_DOC,A_DOC doc
    class C_HUM,A_HUM human
    class A_AI ai
    class C_OUT,A_OUT out
```

### 要件定義書の質がその後の開発効率を決める

- AI駆動開発では設計・実装・テストをAIが自律的に高速に開発する
- 従来は設計しながら決まっていたことも、要件定義の段階で明確に決めておく必要がある
- そのため、従来の要件定義よりも手間がかかる、というよりも「手間をかけるべき」と思った方が良い
- 要件定義書の質がその後の開発効率を決める

```mermaid
flowchart TD
    REQ["📄 要件定義書を書く"] --> CHECK{"曖昧さを<br/>ここで潰したか"}
    CHECK -->|"潰した"| GEN["🤖 AIが設計・実装・テストを<br/>高速に生成"]
    CHECK -->|"残したまま進んだ"| GUESS["🤖 AIが行間を推測で埋める"]
    GUESS --> MASS["⚙️ 推測に基づく成果物が<br/>大量に出来上がる"]
    MASS --> DETECT["🔍 レビュー・テストで<br/>認識のズレが発覚"]
    DETECT -->|"要件定義まで戻る＝手戻り"| REQ
    GEN --> DONE(["✅ 手戻りなしで進む"])

    classDef doc fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef decision fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef ai fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef bad fill:#FFB6C1,stroke:#DC143C,stroke-width:2px,color:black
    classDef good fill:#90EE90,stroke:#2E7D2E,stroke-width:2px,color:darkgreen

    class REQ doc
    class CHECK decision
    class GUESS,GEN ai
    class MASS,DETECT bad
    class DONE good
```

## 事前に準備しておくこと

### コンテキスト整備

#### ・プロジェクトの背景情報や社内用語集を事前に整備しておく

- AIにプロジェクトの情報や社内用語をコンテキストとして与えるために、Markdownで情報を整理しておく
- これを元にAIが要件定義書のドラフトを作る

#### ・AIが議事録を参照できるようにしておく

- 要件はAIが書いたドラフトを見ながらのディスカッションで決まっていく
- そのため議事録の取得とそれをAIが読める位置に配置し参照させることが重要

### AIに要件管理させる

- ユーザーへの確認事項などを要件管理ツールで管理するが、AIが起票し、読み取れる環境を整備しておく

### AIレビュー用のAgent Skillsを用意する

- 要件（特に非機能）の過不足などをチェックさせる
- あいまいな記述を明確化する必要性を記載し、徹底させる

## 要件定義書作成時のポイント

### 推論と事実を分離する

- AIは文脈から理由・背景・出所などを推測で書くことが多い
- 推測した部分を明示させるように指示しておくことが重要

### 要件定義書は段階的に作る

- 一括で書かず、記載段階に区切り、1段階ずつ Issue にして書く
- 最初に前提・制約、作らないものを明確にすることで、AIが余計な可能性を思考する必要がなくなり効率的
- 後の段階が前の段階の出力を入力にできるように、次の順に書く
  - **段階1 スコープと台帳**：作る範囲を縛る項目と、入力資料の全数仕分け
  - **段階2 業務要件**
  - **段階3 機能要件**
  - **段階4 非機能要件**
  - **段階5 前段階から導く項目**：優先順位・受入基準・リスクなど
  - **段階6 凍結判定**：書く項目は無い。文書全体を凍結してよいかを判定する
- 範囲を縛る項目を先に固めるのは、入力資料だけから書けて、判定まで済むからである
- 入力資料の全記述をどこへ振るかは、仕分け台帳に残す。セッションが切れても、台帳から続きを書ける。入力資料の記述が要件定義書のどこに入ったかも、後から照合できる
- 段階の区切りと台帳の列の正典は [要件定義書 Rule](../../.claude/rules/requirements-doc.md)。立場は [requirements-doc-policy](../policy/requirements-doc-policy.md) にある

### 仮決めは別紙に分けて残す

- 画面イメージの仮案や顧客のワイヤーフレームを要件定義書の本体に書くと、凍結されて設計で差し替えられなくなる
- 書かずにおくと、対話の中で消えて設計へ渡らない
- そこで、凍結しない別ファイル「別紙」（`docs/requirements-appendix/`）に置き、本体からは1行で指す
- 別紙を消しても本体の要件が変わらないように書く

### 積極的に図解する

- 人間がUML図などを作ろうとすると時間がかかるが、AIはmermaid記法などで瞬時に図解することができる
- 図解は人間同士の認識を合わせる上で重要であり、今まで以上に積極的に図解することが重要である

### 要件の決定事項には一意のIDを付与する

- 業務一覧・機能一覧・ビジネスルール一覧などに一意のIDを付与する
- そうすることで、AIピンポイントで確実に参照（特定）できるようになる
- 例えばissueに「F-01を実装する」「BR-01を使用して実装する」など、短く確実に対象を記載できるようになる

## AI要件定義の流れ

```mermaid
sequenceDiagram
    actor U as 👤 ユーザー・有識者
    actor D as 👥 開発者
    participant AI as 🤖 AI
    participant B as 📗 背景情報・用語集（Markdown）
    participant K as 📚 議事録・要件管理ツール
    participant R as 📄 要件定義書・仕分け台帳

    D->>B: プロジェクトの背景・社内用語を事前に整備する
    D->>AI: 入力資料を渡し、記載段階ごとの Issue を起票させる

    loop 記載段階1〜5（Issue を1つずつ）
        D->>AI: 記載段階の Issue 番号を渡す
        AI->>B: 背景・用語をコンテキストとして読む
        loop その段階の曖昧さが尽きるまで
            AI->>D: 項目ごとに一問ずつ聞く
            D->>U: 有識者に確認する
            D->>K: 議事録をAIが読める位置に置く
            AI->>K: ユーザーへの確認事項を起票する
            U->>K: 回答する
            AI->>K: 議事録・回答を読む
        end
        AI->>R: その段階の節を書く（推測部分を明示・図解・IDを付与）
        AI->>R: 段階までの項目をレビューして直す
        AI->>R: 台帳とあわせてコミットし、PR にする
    end

    D->>AI: 記載段階6の Issue 番号を渡す
    AI->>R: 文書全体の凍結判定を行い、合格すれば凍結する
    R-->>AI: 設計・実装のインプットになる（「F-01を実装する」とIDで指せる）
```
