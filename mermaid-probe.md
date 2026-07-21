# Mermaid 描画プローブ

GitHub がどの Mermaid 図種を描画するかを観測するための一時ファイル。確認後に削除する。

## 01 flowchart

```mermaid
flowchart TD
    A[Start] --> B{Check}
    B -->|Yes| C[Done]
    B -->|No| A
```

## 02 sequenceDiagram

```mermaid
sequenceDiagram
    Client->>API: request
    API-->>Client: response
```

## 03 classDiagram

```mermaid
classDiagram
    Animal <|-- Dog
    Animal : +String name
```

## 04 stateDiagram-v2

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Shipped: dispatch
    Shipped --> [*]
```

## 05 erDiagram

```mermaid
erDiagram
    CUSTOMER ||--o{ ORDER : places
```

## 06 journey

```mermaid
journey
    title Shopping
    section Browse
      Search: 5: User
      Compare: 3: User
```

## 07 gantt

```mermaid
gantt
    title Plan
    dateFormat YYYY-MM-DD
    section Phase1
    Design :a1, 2026-01-01, 14d
    Build  :after a1, 20d
```

## 08 pie

```mermaid
pie title Share
    "A" : 40
    "B" : 60
```

## 09 quadrantChart

```mermaid
quadrantChart
    title Priority
    x-axis Low Cost --> High Cost
    y-axis Low Value --> High Value
    quadrant-1 Do now
    quadrant-2 Plan
    quadrant-3 Drop
    quadrant-4 Quick win
    Feature A: [0.3, 0.8]
    Feature B: [0.7, 0.4]
```

## 10 requirementDiagram

```mermaid
requirementDiagram
    requirement req1 {
        id: 1
        text: must authenticate
        risk: high
        verifymethod: test
    }
    element testEntity {
        type: simulation
    }
    testEntity - verifies -> req1
```

## 11 gitGraph

```mermaid
gitGraph
    commit
    branch feature
    commit
    checkout main
    merge feature
```

## 12 C4Context

```mermaid
C4Context
    title System Context
    Person(user, "User")
    System(sys, "App")
    Rel(user, sys, "uses")
```

## 13 mindmap

```mermaid
mindmap
  root((Design))
    Structure
      Layers
    Quality
      Tests
```

## 14 timeline

```mermaid
timeline
    title Release History
    2024 : v1.0
    2025 : v2.0 : v2.1
```

## 15 sankey-beta

```mermaid
sankey-beta
Requests,Cache,60
Requests,Origin,40
```

## 16 xychart

```mermaid
xychart
    line [1.3, 0.6, 2.4, 3.1]
```

## 17 block-beta

```mermaid
block-beta
    columns 3
    a b c
```

## 18 packet-beta

```mermaid
packet-beta
0-15: "Source Port"
16-31: "Destination Port"
```

## 19 kanban

```mermaid
kanban
  todo[Todo]
    task1[Write docs]
  done[Done]
    task2[Review code]
```

## 20 architecture-beta

```mermaid
architecture-beta
    group api(cloud)[API]
    service db(database)[DB] in api
    service server(server)[Server] in api
    server:R --> L:db
```

## 21 radar-beta

```mermaid
radar-beta
axis A, B, C, D, E
curve c1{1,2,3,4,5}
curve c2{5,4,3,2,1}
```

## 22 treemap-beta

```mermaid
treemap-beta
"Section 1"
    "Leaf 1.1": 12
    "Section 1.2"
      "Leaf 1.2.1": 12
"Section 2"
    "Leaf 2.1": 20
    "Leaf 2.2": 25
```

## 23 venn-beta

```mermaid
venn-beta
  set A
  set B
  union A,B
```

## 24 treeView-beta

```mermaid
treeView-beta
    my-project/
        src/
            index.js
        package.json
        README.md
```

## 25 ishikawa

```mermaid
ishikawa
  Deploy failed
    Config drift
    Missing secret
```

## 26 zenuml

```mermaid
zenuml
    Client->API: request
```
