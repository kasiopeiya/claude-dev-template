# [System Name] - System Design Document

**Author:** [Name]
**Date:** [YYYY-MM-DD]
**Status:** Draft | In Review | Approved
**Version:** 1.0

---

## 1. Executive Summary

**System Purpose:** [One sentence describing what the system does]

**Scale:**

- Users: [Number of users]
- Requests/Day: [Volume]
- Data Volume: [Size]

**Key Challenges:**

1. [Challenge 1]
2. [Challenge 2]
3. [Challenge 3]

---

## 2. Requirements

### 2.1 Functional Requirements

1. **[Requirement Category]**
   - FR-1: [Specific requirement]
   - FR-2: [Specific requirement]

### 2.2 Non-Functional Requirements

| Category     | Requirement      | Target            | Priority |
| ------------ | ---------------- | ----------------- | -------- |
| Availability | Uptime           | 99.99%            | Critical |
| Performance  | Response time    | < 100ms           | High     |
| Scalability  | Concurrent users | 100k              | High     |
| Consistency  | Data consistency | Eventual          | Medium   |
| Security     | Data encryption  | At rest & transit | Critical |

---

## 3. System Context

### 3.1 High-Level Overview

```mermaid
C4Context
    title System Context Diagram

    Person(user, "User", "End user of the system")
    Person(admin, "Admin", "System administrator")

    System(mainSystem, "[System Name]", "Core system providing [functionality]")

    System_Ext(authSystem, "Auth System", "Authentication provider")
    System_Ext(paymentSystem, "Payment Gateway", "Payment processing")
    System_Ext(emailSystem, "Email Service", "Email notifications")
    SystemDb_Ext(analytics, "Analytics Platform", "Usage analytics")

    Rel(user, mainSystem, "Uses", "HTTPS")
    Rel(admin, mainSystem, "Manages", "HTTPS")
    Rel(mainSystem, authSystem, "Authenticates with", "OAuth 2.0")
    Rel(mainSystem, paymentSystem, "Processes payments", "REST API")
    Rel(mainSystem, emailSystem, "Sends emails", "SMTP")
    Rel(mainSystem, analytics, "Sends events", "Streaming")
```

---

## 4. High-Level Architecture

### 4.1 Architecture Overview

`graph` を選んだ理由：層が4つあり、`architecture-beta` の適用条件を超える規模のため。この規模ではグループ枠が重なって層の区別が消える。

```mermaid
graph TB
    subgraph "Client Layer"
        Web[Web App]
        Mobile[Mobile App]
        API_Client[API Clients]
    end

    subgraph "Edge Layer"
        CDN[CDN]
        WAF[Web Application Firewall]
        LB[Load Balancer]
    end

    subgraph "API Gateway Layer"
        Gateway[API Gateway]
        RateLimit[Rate Limiter]
    end

    subgraph "Application Layer"
        Auth[Auth Service]
        User[User Service]
        Order[Order Service]
        Payment[Payment Service]
        Notification[Notification Service]
    end

    subgraph "Data Layer"
        PrimaryDB[(Primary DB)]
        ReplicaDB[(Read Replica)]
        Cache[(Redis Cache)]
        Queue[Message Queue]
    end

    subgraph "Storage Layer"
        ObjectStore[Object Storage]
        SearchIndex[Search Index]
    end

    Web --> CDN
    Mobile --> CDN
    API_Client --> CDN
    CDN --> WAF
    WAF --> LB
    LB --> Gateway
    Gateway --> RateLimit
    RateLimit --> Auth
    RateLimit --> User
    RateLimit --> Order
    RateLimit --> Payment
    RateLimit --> Notification

    Auth --> PrimaryDB
    User --> ReplicaDB
    Order --> PrimaryDB
    Payment --> PrimaryDB
    Notification --> Queue

    Auth --> Cache
    User --> Cache
    Order --> Cache

    User --> ObjectStore
    Order --> SearchIndex

    classDef client fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef edge fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef service fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class Web,Mobile,API_Client client
    class CDN,WAF,LB,Gateway,RateLimit edge
    class Auth,User,Order,Payment,Notification service
    class PrimaryDB,ReplicaDB,Cache,Queue,ObjectStore,SearchIndex store
```

---

## 5. Component Design

### 5.1 Service Architecture

`graph` を選んだ理由：描いているのはインフラ構成ではなくサービス内部のモジュール構成であり、`architecture-beta` の対象外。

```mermaid
graph TB
    subgraph "User Service"
        US_API[REST API]
        US_Logic[Business Logic]
        US_Data[Data Layer]
        US_Cache[Cache Layer]
    end

    subgraph "Order Service"
        OS_API[REST API]
        OS_Logic[Business Logic]
        OS_Data[Data Layer]
        OS_Queue[Queue Publisher]
    end

    subgraph "Payment Service"
        PS_API[REST API]
        PS_Logic[Business Logic]
        PS_Data[Data Layer]
        PS_External[External Gateway]
    end

    Client --> US_API
    Client --> OS_API
    Client --> PS_API

    US_API --> US_Logic
    US_Logic --> US_Data
    US_Logic --> US_Cache

    OS_API --> OS_Logic
    OS_Logic --> OS_Data
    OS_Logic --> OS_Queue

    PS_API --> PS_Logic
    PS_Logic --> PS_Data
    PS_Logic --> PS_External

    classDef client fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef api fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef logic fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class Client client
    class US_API,OS_API,PS_API api
    class US_Logic,OS_Logic,PS_Logic logic
    class US_Data,US_Cache,OS_Data,OS_Queue,PS_Data,PS_External store
```

---

## 6. Data Flow

### 6.1 Write Path

```mermaid
sequenceDiagram
    participant User
    participant LB as Load Balancer
    participant API as API Gateway
    participant Service as Application Service
    participant DB as Primary Database
    participant Cache as Cache
    participant Queue as Message Queue

    User->>LB: Write Request
    LB->>API: Forward Request
    API->>API: Authenticate & Authorize
    API->>Service: Process Request
    Service->>DB: Write to Database
    DB-->>Service: Write Confirmed
    Service->>Cache: Invalidate Cache
    Service->>Queue: Publish Event
    Service-->>API: Return Response
    API-->>LB: Return Response
    LB-->>User: Success Response
```

### 6.2 Read Path

```mermaid
sequenceDiagram
    participant User
    participant CDN
    participant LB as Load Balancer
    participant API as API Gateway
    participant Cache as Redis Cache
    participant Service as Application Service
    participant DB as Read Replica

    User->>CDN: Read Request
    alt Static Content
        CDN-->>User: Return Cached Content
    else Dynamic Content
        CDN->>LB: Forward Request
        LB->>API: Forward Request
        API->>Cache: Check Cache
        alt Cache Hit
            Cache-->>API: Return Cached Data
        else Cache Miss
            API->>Service: Process Request
            Service->>DB: Query Database
            DB-->>Service: Return Data
            Service->>Cache: Update Cache
            Service-->>API: Return Data
        end
        API-->>LB: Return Response
        LB-->>CDN: Return Response
        CDN-->>User: Return Response
    end
```

---

## 7. Database Design

### 7.1 Data Model

```mermaid
erDiagram
    USER ||--o{ SESSION : has
    USER ||--o{ ORDER : places
    USER {
        uuid id PK
        string email UK
        string name
        enum role
        timestamp created_at
    }

    SESSION {
        uuid id PK
        uuid user_id FK
        string token UK
        timestamp expires_at
        timestamp created_at
    }

    ORDER ||--|{ ORDER_ITEM : contains
    ORDER ||--|| PAYMENT : has
    ORDER {
        uuid id PK
        uuid user_id FK
        decimal total
        enum status
        timestamp created_at
    }

    PRODUCT ||--o{ ORDER_ITEM : "ordered in"
    PRODUCT {
        uuid id PK
        string sku UK
        string name
        decimal price
        int stock
    }

    ORDER_ITEM {
        uuid id PK
        uuid order_id FK
        uuid product_id FK
        int quantity
        decimal price
    }

    PAYMENT {
        uuid id PK
        uuid order_id FK
        decimal amount
        enum status
        string transaction_id
    }
```

### 7.2 Sharding Strategy

`graph` を選んだ理由：どのキー範囲がどのシャードへ振り分けられるかをエッジラベルで示すため。

```mermaid
graph TB
    App[Application]
    Router[Shard Router]
    Shard1[(Shard 1<br/>Users A-M)]
    Shard2[(Shard 2<br/>Users N-Z)]

    App --> Router
    Router -->|user_id hash % 2 == 0| Shard1
    Router -->|user_id hash % 2 == 1| Shard2

    classDef app fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef router fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class App app
    class Router router
    class Shard1,Shard2 store
```

**Sharding Key:** `user_id`

**Rationale:**

- Even distribution of data
- Enables user-centric queries
- Allows independent scaling

---

## 8. API Design

### 8.1 API Architecture

```mermaid
sequenceDiagram
    participant Client
    participant Gateway
    participant Auth
    participant Service
    participant DB

    Client->>Gateway: POST /api/v1/resource
    Gateway->>Auth: Validate Token
    Auth-->>Gateway: Valid + Claims
    Gateway->>Service: Forward Request + User Context
    Service->>Service: Business Logic
    Service->>DB: Persist Data
    DB-->>Service: Success
    Service-->>Gateway: 201 Created
    Gateway-->>Client: 201 Created + Resource
```

### 8.2 Key Endpoints

| Endpoint             | Method | Purpose      | Rate Limit |
| -------------------- | ------ | ------------ | ---------- |
| `/api/v1/users`      | GET    | List users   | 100/min    |
| `/api/v1/users/:id`  | GET    | Get user     | 300/min    |
| `/api/v1/orders`     | POST   | Create order | 30/min     |
| `/api/v1/orders/:id` | GET    | Get order    | 300/min    |

---

## 9. Scaling Strategy

### 9.1 Horizontal Scaling

`graph` を選んだ理由：振り分けの方式とスケール条件をエッジラベルで示すため。

```mermaid
graph TB
    subgraph "Auto Scaling Group"
        App1[App Instance 1]
        App2[App Instance 2]
        App3[App Instance 3]
        AppN[App Instance N]
    end

    LB[Load Balancer]
    Metrics[CloudWatch Metrics]

    LB --> App1
    LB --> App2
    LB --> App3
    LB --> AppN

    App1 --> Metrics
    App2 --> Metrics
    App3 --> Metrics
    AppN --> Metrics

    Metrics -->|CPU > 70%| AutoScale[Auto Scaling Policy]
    AutoScale -->|Add Instances| App1

    classDef app fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef edge fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef control fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue

    class App1,App2,App3,AppN app
    class LB edge
    class Metrics,AutoScale control
```

### 9.2 Database Scaling

`graph` を選んだ理由：読み書きの振り分けと複製をエッジラベルで区別するため。

```mermaid
graph TB
    subgraph "Database Cluster"
        Primary[(Primary<br/>Read + Write)]
        Replica1[(Replica 1<br/>Read Only)]
        Replica2[(Replica 2<br/>Read Only)]
        Replica3[(Replica 3<br/>Read Only)]
    end

    AppWrite[Write Operations]
    AppRead[Read Operations]

    AppWrite --> Primary
    AppRead --> Replica1
    AppRead --> Replica2
    AppRead --> Replica3

    Primary -.Replication.-> Replica1
    Primary -.Replication.-> Replica2
    Primary -.Replication.-> Replica3

    classDef op fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class AppWrite,AppRead op
    class Primary,Replica1,Replica2,Replica3 store
```

---

## 10. Caching Strategy

### 10.1 Multi-Layer Cache

`graph` を選んだ理由：各層のヒット・ミス時にどこへ問い合わせるかをエッジラベルで示すため。

```mermaid
graph TB
    User[User Request]
    CDN[CDN Cache<br/>Static Assets]
    AppCache[Application Cache<br/>Redis]
    DB[(Database)]

    User --> CDN
    CDN -->|Miss| AppCache
    AppCache -->|Miss| DB
    DB -->|Data| AppCache
    AppCache -->|Update| CDN
    AppCache -->|Response| User

    classDef client fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef cache fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class User client
    class CDN,AppCache cache
    class DB store
```

### 10.2 Cache Invalidation

**Strategy:** Write-through with TTL

| Data Type       | TTL        | Invalidation Trigger |
| --------------- | ---------- | -------------------- |
| User Profile    | 1 hour     | On user update       |
| Product Catalog | 15 minutes | On product change    |
| Order Status    | 5 minutes  | On order update      |
| Static Assets   | 30 days    | On deployment        |

---

## 11. Message Queue Architecture

### 11.1 Event-Driven Architecture

`graph` を選んだ理由：発行するイベント名（`OrderCreated` など）と購読関係をエッジラベルで示すため。

```mermaid
graph LR
    OrderService[Order Service]
    Queue[Message Queue]
    PaymentService[Payment Service]
    NotificationService[Notification Service]
    InventoryService[Inventory Service]

    OrderService -->|OrderCreated| Queue
    Queue -->|Consume| PaymentService
    Queue -->|Consume| NotificationService
    Queue -->|Consume| InventoryService

    PaymentService -->|PaymentProcessed| Queue
    Queue -->|Consume| OrderService
    Queue -->|Consume| NotificationService

    classDef service fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef broker fill:#FFD700,stroke:#333,stroke-width:2px,color:black

    class OrderService,PaymentService,NotificationService,InventoryService service
    class Queue broker
```

### 11.2 Message Flow

```mermaid
sequenceDiagram
    participant OrderService
    participant Queue
    participant PaymentService
    participant EmailService

    OrderService->>Queue: Publish: OrderCreated
    Queue->>PaymentService: Deliver: OrderCreated
    PaymentService->>PaymentService: Process Payment
    PaymentService->>Queue: Publish: PaymentCompleted
    Queue->>OrderService: Deliver: PaymentCompleted
    Queue->>EmailService: Deliver: PaymentCompleted
    EmailService->>EmailService: Send Confirmation Email
```

---

## 12. Security Architecture

### 12.1 Security Layers

A request from the internet passes these layers:

| Order | Layer                 | Rejects / records                             |
| ----- | --------------------- | --------------------------------------------- |
| 1     | WAF + DDoS protection | Known attack patterns, volumetric floods      |
| 2     | TLS termination       | Plaintext transport                           |
| 3     | Authentication        | Callers without a valid identity              |
| 4     | Authorization         | Identities without rights on the resource     |
| 5     | Input validation      | Malformed or out-of-range payloads            |
| 6     | Data encryption       | Readable data at rest and in transit          |
| 7     | Audit logging         | Records who did what, for later investigation |

### 12.2 Authentication Flow

```mermaid
sequenceDiagram
    participant User
    participant Client
    participant AuthServer
    participant ResourceServer

    User->>Client: Login
    Client->>AuthServer: POST /oauth/token
    AuthServer->>AuthServer: Validate Credentials
    AuthServer-->>Client: Access Token + Refresh Token
    Client->>ResourceServer: GET /resource<br/>Authorization: Bearer {token}
    ResourceServer->>AuthServer: Validate Token
    AuthServer-->>ResourceServer: Token Valid + Claims
    ResourceServer-->>Client: Protected Resource
```

---

## 13. Monitoring & Observability

### 13.1 Monitoring Architecture

`graph` を選んだ理由：グループが3つあり、`architecture-beta` の適用条件を超える規模のため。この規模ではラベルが重なって判読できない。

```mermaid
graph TB
    subgraph "Application"
        App[Application]
        Metrics[Metrics Exporter]
        Logs[Log Shipper]
        Traces[Trace Collector]
    end

    subgraph "Monitoring Stack"
        Prometheus[Prometheus]
        Loki[Loki]
        Jaeger[Jaeger]
        Grafana[Grafana]
    end

    subgraph "Alerting"
        AlertManager[Alert Manager]
        PagerDuty[PagerDuty]
        Slack[Slack]
    end

    App --> Metrics
    App --> Logs
    App --> Traces

    Metrics --> Prometheus
    Logs --> Loki
    Traces --> Jaeger

    Prometheus --> Grafana
    Loki --> Grafana
    Jaeger --> Grafana

    Prometheus --> AlertManager
    AlertManager --> PagerDuty
    AlertManager --> Slack

    classDef app fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef stack fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef alert fill:#FFB6C1,stroke:#DC143C,stroke-width:2px,color:black

    class App,Metrics,Logs,Traces app
    class Prometheus,Loki,Jaeger,Grafana stack
    class AlertManager,PagerDuty,Slack alert
```

### 13.2 Key Metrics

| Metric               | Type      | Threshold  | Alert Level |
| -------------------- | --------- | ---------- | ----------- |
| Request Rate         | Gauge     | -          | Info        |
| Error Rate           | Gauge     | > 1%       | Warning     |
| Response Time (p99)  | Histogram | > 500ms    | Warning     |
| CPU Usage            | Gauge     | > 80%      | Critical    |
| Memory Usage         | Gauge     | > 85%      | Warning     |
| Database Connections | Gauge     | > 80% pool | Warning     |

---

## 14. Disaster Recovery

### 14.1 Backup Strategy

`graph` を選んだ理由：バックアップの頻度と保存先をエッジラベルで示すため。

```mermaid
graph TB
    Production[(Production DB)]
    Snapshot[Daily Snapshots]
    Backup[(Backup Storage)]
    DR[(DR Site)]

    Production -->|Daily| Snapshot
    Snapshot --> Backup
    Production -.Replication.-> DR

    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue
    classDef job fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen

    class Production,Backup,DR store
    class Snapshot job
```

### 14.2 Recovery Procedures

| Scenario         | RTO       | RPO        | Procedure                          |
| ---------------- | --------- | ---------- | ---------------------------------- |
| Service Outage   | 5 minutes | 0          | Auto-failover to healthy instances |
| Database Failure | 1 hour    | 15 minutes | Promote read replica               |
| Region Failure   | 4 hours   | 1 hour     | Failover to DR region              |
| Data Corruption  | 24 hours  | 24 hours   | Restore from backup                |

---

## 15. Deployment Architecture

### 15.1 Infrastructure

`graph` を選んだ理由：構成要素間のプロトコルをエッジラベルで示すため。`architecture-beta` には書く構文が無い。

```mermaid
graph TB
    subgraph "Production - Region 1"
        subgraph "AZ1"
            LB1[Load Balancer]
            App1[App Server]
            DB1[(Database Primary)]
        end

        subgraph "AZ2"
            App2[App Server]
            DB2[(Database Standby)]
        end
    end

    subgraph "Production - Region 2 (DR)"
        subgraph "AZ3"
            LB2[Load Balancer]
            App3[App Server]
            DB3[(Database Replica)]
        end
    end

    DNS[Route 53]
    DNS --> LB1
    DNS -.Failover.-> LB2

    LB1 --> App1
    LB1 --> App2
    App1 --> DB1
    App2 --> DB1
    DB1 -.Sync Replication.-> DB2
    DB1 -.Async Replication.-> DB3

    classDef edge fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef app fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class DNS,LB1,LB2 edge
    class App1,App2,App3 app
    class DB1,DB2,DB3 store
```

---

## 16. Cost Optimization

### 16.1 Cost Breakdown

| Component     | Monthly Cost | Optimization Opportunity           |
| ------------- | ------------ | ---------------------------------- |
| Compute       | $10,000      | Reserved instances, spot instances |
| Database      | $5,000       | Right-sizing, read replicas        |
| Data Transfer | $2,000       | CDN, compression                   |
| Storage       | $1,000       | Lifecycle policies, compression    |

---

## 17. Trade-offs & Alternatives

### 17.1 Key Decisions

**Decision 1: Eventual Consistency vs Strong Consistency**

- **Chosen:** Eventual consistency
- **Rationale:** Better availability and performance
- **Trade-off:** Temporary inconsistency acceptable for this use case
- **Alternative:** Strong consistency - rejected due to performance impact

**Decision 2: Monolith vs Microservices**

- **Chosen:** Microservices
- **Rationale:** Independent scaling, fault isolation
- **Trade-off:** Increased operational complexity
- **Alternative:** Modular monolith - might revisit for smaller features

---

## 18. Future Enhancements

### 18.1 Roadmap

```mermaid
gantt
    title System Evolution Roadmap
    dateFormat YYYY-MM-DD
    section Phase 1
    Multi-region deployment    :2025-01-01, 90d
    Advanced caching          :2025-02-01, 60d
    section Phase 2
    ML-based recommendations  :2025-04-01, 120d
    Real-time analytics      :2025-05-01, 90d
    section Phase 3
    Global CDN expansion     :2025-07-01, 60d
    Edge computing          :2025-08-01, 90d
```

---

## 19. Appendices

### A. Glossary

| Term | Definition               |
| ---- | ------------------------ |
| CDN  | Content Delivery Network |
| WAF  | Web Application Firewall |
| TTL  | Time To Live             |

### B. References

1. [System Design Primer](https://github.com/donnemartin/system-design-primer)
2. [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
