# [System Name] - Architecture Design Document

**Author:** [Name]
**Date:** [YYYY-MM-DD]
**Status:** Draft | In Review | Approved
**Version:** 1.0

---

## 1. Executive Summary

[Brief overview of the system and key architectural decisions]

**Business Context:**

- Problem being solved
- Target users
- Key business requirements

**Key Decisions:**

- Major architectural choice 1
- Major architectural choice 2
- Major architectural choice 3

---

## 2. System Context

### 2.1 System Overview

[High-level description of what the system does]

```mermaid
C4Context
    title System Context Diagram for [System Name]

    Person(user, "User", "A user of the system")
    System(systemName, "[System Name]", "Description of the system")
    System_Ext(externalSystem, "External System", "Description")

    Rel(user, systemName, "Uses", "HTTPS")
    Rel(systemName, externalSystem, "Integrates with", "REST API")
```

### 2.2 Stakeholders

| Stakeholder  | Role   | Interest               |
| ------------ | ------ | ---------------------- |
| [Name/Group] | [Role] | [What they care about] |

---

## 3. Requirements

### 3.1 Functional Requirements

| ID   | Requirement               | Priority        |
| ---- | ------------------------- | --------------- |
| FR-1 | [Requirement description] | High/Medium/Low |

### 3.2 Non-Functional Requirements

| Category     | Requirement   | Target     |
| ------------ | ------------- | ---------- |
| Performance  | [Description] | [Metric]   |
| Scalability  | [Description] | [Metric]   |
| Availability | [Description] | [Metric]   |
| Security     | [Description] | [Standard] |

---

## 4. Architecture Overview

### 4.1 Architectural Style

[Description of the architectural pattern: microservices, layered, event-driven, etc.]

**Why this style:**

- Reason 1
- Reason 2
- Reason 3

### 4.2 High-Level Architecture

```mermaid
graph TB
    subgraph "Client Layer"
        WebApp[Web Application]
        MobileApp[Mobile App]
    end

    subgraph "API Gateway Layer"
        Gateway[API Gateway]
    end

    subgraph "Service Layer"
        AuthService[Auth Service]
        DataService[Data Service]
        NotificationService[Notification Service]
    end

    subgraph "Data Layer"
        DB[(Database)]
        Cache[(Cache)]
    end

    WebApp --> Gateway
    MobileApp --> Gateway
    Gateway --> AuthService
    Gateway --> DataService
    Gateway --> NotificationService

    AuthService --> DB
    DataService --> DB
    DataService --> Cache
    NotificationService --> Cache

    classDef client fill:#87CEEB,stroke:#333,stroke-width:2px,color:darkblue
    classDef edge fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef service fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class WebApp,MobileApp client
    class Gateway edge
    class AuthService,DataService,NotificationService service
    class DB,Cache store
```

---

## 5. Component Design

### 5.1 Component Overview

| Component   | Module    | Depends on              |
| ----------- | --------- | ----------------------- |
| Component A | Module A1 | Component B / Module B1 |
| Component A | Module A2 | Component B / Module B2 |
| Component B | Module B1 | —                       |
| Component B | Module B2 | —                       |

### 5.2 Component Descriptions

#### Component A

- **Purpose:** [What it does]
- **Responsibilities:** [Key responsibilities]
- **Technologies:** [Tech stack]
- **Dependencies:** [What it depends on]

---

## 6. Data Architecture

### 6.1 Data Model

```mermaid
erDiagram
    USER ||--o{ ORDER : places
    USER {
        int id PK
        string email
        string name
        datetime created_at
    }
    ORDER ||--|{ ORDER_ITEM : contains
    ORDER {
        int id PK
        int user_id FK
        datetime order_date
        decimal total
    }
    PRODUCT ||--o{ ORDER_ITEM : "ordered in"
    ORDER_ITEM {
        int id PK
        int order_id FK
        int product_id FK
        int quantity
        decimal price
    }
    PRODUCT {
        int id PK
        string name
        decimal price
        int stock
    }
```

### 6.2 Data Flow

A write request passes through these stages:

1. User input
2. Validation
3. Business logic
4. Data persistence
5. Cache update
6. Response

---

## 7. Integration Points

### 7.1 External Dependencies

| System   | Purpose   | Protocol        | SLA     |
| -------- | --------- | --------------- | ------- |
| [System] | [Purpose] | [REST/gRPC/etc] | [99.9%] |

### 7.2 API Design

```mermaid
sequenceDiagram
    participant Client
    participant Gateway
    participant AuthService
    participant DataService
    participant Database

    Client->>Gateway: POST /api/resource
    Gateway->>AuthService: Validate Token
    AuthService-->>Gateway: Token Valid
    Gateway->>DataService: Create Resource
    DataService->>Database: INSERT
    Database-->>DataService: Success
    DataService-->>Gateway: Resource Created
    Gateway-->>Client: 201 Created
```

---

## 8. Security Architecture

### 8.1 Security Layers

A request from the internet passes these layers:

| Order | Layer                     | Rejects                                     |
| ----- | ------------------------- | ------------------------------------------- |
| 1     | Web Application Firewall  | Known attack patterns, abusive clients      |
| 2     | TLS/SSL encryption        | Plaintext transport                         |
| 3     | Authentication            | Callers without a valid identity            |
| 4     | Authorization             | Identities without rights on the resource   |
| 5     | Data encryption (at rest) | Readable data on a compromised storage tier |

### 8.2 Authentication Flow

```mermaid
stateDiagram-v2
    [*] --> Unauthenticated
    Unauthenticated --> Authenticating: Login Request
    Authenticating --> Authenticated: Success
    Authenticating --> Unauthenticated: Failure
    Authenticated --> Unauthenticated: Logout
    Authenticated --> TokenRefresh: Token Expiring
    TokenRefresh --> Authenticated: Refresh Success
    TokenRefresh --> Unauthenticated: Refresh Failure
```

---

## 9. Deployment Architecture

### 9.1 Infrastructure

```mermaid
graph TB
    subgraph "Production Environment"
        subgraph "Region 1"
            LB1[Load Balancer]
            App1[App Server 1]
            App2[App Server 2]
            DB1[(Primary DB)]
        end

        subgraph "Region 2"
            LB2[Load Balancer]
            App3[App Server 3]
            App4[App Server 4]
            DB2[(Replica DB)]
        end
    end

    DNS --> LB1
    DNS --> LB2
    LB1 --> App1
    LB1 --> App2
    LB2 --> App3
    LB2 --> App4
    App1 --> DB1
    App2 --> DB1
    App3 --> DB2
    App4 --> DB2
    DB1 -.Replication.-> DB2

    classDef entry fill:#FFD700,stroke:#333,stroke-width:2px,color:black
    classDef app fill:#90EE90,stroke:#333,stroke-width:2px,color:darkgreen
    classDef store fill:#E6E6FA,stroke:#333,stroke-width:2px,color:darkblue

    class DNS,LB1,LB2 entry
    class App1,App2,App3,App4 app
    class DB1,DB2 store
```

---

## 10. Scalability & Performance

### 10.1 Scaling Strategy

| Component   | Strategy              | Trigger              | Max Scale     |
| ----------- | --------------------- | -------------------- | ------------- |
| [Component] | [Horizontal/Vertical] | [Metric > Threshold] | [N instances] |

### 10.2 Performance Targets

| Operation   | Target   | Current | Strategy                |
| ----------- | -------- | ------- | ----------------------- |
| [Operation] | [< X ms] | [Y ms]  | [Optimization approach] |

---

## 11. Monitoring & Observability

### 11.1 Key Metrics

| Metric         | Alert it raises     | Threshold    |
| -------------- | ------------------- | ------------ |
| Request rate   | — (capacity signal) | —            |
| Error rate     | High error rate     | [> X %]      |
| Response time  | Slow response       | [p95 > X ms] |
| Resource usage | Resource exhaustion | [> X %]      |

---

## 12. Disaster Recovery

### 12.1 Backup Strategy

| Data Type | Frequency   | Retention | RTO    | RPO    |
| --------- | ----------- | --------- | ------ | ------ |
| [Type]    | [Frequency] | [Period]  | [Time] | [Time] |

---

## 13. Technical Debt & Future Work

### 13.1 Known Limitations

1. [Limitation description]
2. [Limitation description]

### 13.2 Future Enhancements

```mermaid
gantt
    title Planned Enhancements
    dateFormat YYYY-MM-DD
    section Phase 1
    Enhancement 1       :2025-01-01, 30d
    Enhancement 2       :2025-02-01, 45d
    section Phase 2
    Enhancement 3       :2025-03-15, 60d
```

---

## 14. Decision Log

### ADR-001: [Decision Title]

**Date:** [YYYY-MM-DD]
**Status:** Accepted

**Context:**
[What led to this decision]

**Decision:**
[What was decided]

**Consequences:**

- Positive: [Benefits]
- Negative: [Costs/Trade-offs]

**Alternatives Considered:**

1. [Alternative 1] - Rejected because [reason]
2. [Alternative 2] - Rejected because [reason]

---

## 15. Appendices

### Glossary

| Term   | Definition   |
| ------ | ------------ |
| [Term] | [Definition] |

### References

1. [Document/Link]
2. [Document/Link]
