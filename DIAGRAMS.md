# DFD & Use Case Diagrams

Project: AWS Cloud Governance Platform (Modules A–D).
Mermaid diagrams — render on GitHub / VS Code / any mermaid-enabled markdown viewer.

## Use Case Diagrams

### Module A — AI Architecture Advisor
```mermaid
flowchart LR
    Student["Student"]
    UC1(Submit GitHub repo URL)
    UC2(Submit freeform description)
    UC3(View inferred AWS service map)
    UC4(Preview draw.io diagram)
    UC5(Download .drawio file)
    UC6(View monthly cost estimate)
    UC7(Adjust user-count slider)
    UC8(Select AWS region)
    UC9(Email diagram to self)

    Student --> UC1
    Student --> UC2
    Student --> UC4
    Founder --> UC1
    UC1 --> UC3
    UC2 --> UC3
    UC3 --> UC4
    UC4 --> UC5
    UC3 --> UC6
    UC6 --> UC7
    UC6 --> UC8
    UC4 --> UC9
```

### Module B — Cost Monitoring & Anomaly Detection
```mermaid
flowchart LR
    Admin["Administrator"]
    UC1(Configure spike threshold)
    UC2(View daily cost breakdown)
    UC3(View 7-day rolling average)
    UC4(View spike alerts)
    UC5(Rank spikes by dollar impact)
    UC6(View 30-day trend chart)
    UC7(Receive email alert)

    Admin --> UC1
    Admin --> UC2
    Admin --> UC3
    Admin --> UC5
    Admin --> UC6
    UC4 --> UC5
    UC4 -. system-generated .-> UC7
```

### Module C — Resource Optimization Engine
```mermaid
flowchart LR
    DevOps["DevOps / Administrator"]
    UC1(Run daily resource scan)
    UC2(View findings list)
    UC3(View savings estimate per finding)
    UC4(Sort findings by savings)
    UC5(Dismiss a finding)
    UC6(View recommended action)

    DevOps --> UC1
    DevOps --> UC2
    DevOps --> UC4
    UC1 --> UC2
    UC2 --> UC3
    UC2 --> UC6
    UC3 --> UC4
    UC2 --> UC5
```

### Module D — Security Posture Scanner
```mermaid
flowchart LR
    SecAdmin["Security Administrator"]
    UC1(Run CIS-aligned scan)
    UC2(View findings by severity)
    UC3(View remediation steps)
    UC4(Compare with previous scan)

    SecAdmin --> UC1
    SecAdmin --> UC2
    SecAdmin --> UC4
    UC1 --> UC2
    UC2 --> UC3
```

## DFD — Module A: AI Architecture Advisor

### Level 0 (Context Diagram)
```mermaid
flowchart LR
    User["User<br/>(Student / Founder)"]
    GH["GitHub API"]
    PRICE["AWS Price List API"]
    Mail["SES Email"]
    P0(("P0<br/>Architecture Advisor"))

    User -->|repo URL / description| P0
    P0 -->|service map + diagram + cost| User
    P0 -->|repo + manifest request| GH
    GH -->|README + manifests| P0
    P0 -->|price query| PRICE
    PRICE -->|unit prices| P0
    P0 -->|diagram email| Mail
    Mail -->|delivery status| P0
```

### Level 1 (Decomposed)
```mermaid
flowchart TD
    User["User"]
    GH["GitHub API"]
    PRICE["AWS Price List API"]
    P1["P1<br/>Fetch Repo Data"]
    P2["P2<br/>Parse & Compact Manifests"]
    P3["P3<br/>Rules Engine"]
    P4["P4<br/>LLM Inference"]
    P5["P5<br/>Catalog Validation"]
    P6["P6<br/>Diagram Generator"]
    P7["P7<br/>Cost Engine"]
    D1[("D1<br/>Repo Cache")]
    D2[("D2<br/>Price Cache")]
    D3[("D3<br/>ServicePlan")]

    User -->|repo URL| P1
    P1 <--> D1
    P1 -->|fetch request| GH
    GH -->|README + manifests| P1
    P1 -->|manifest files| P2
    P2 -->|structured evidence| P3
    P2 -->|evidence sample| P4
    P3 -->|candidate services| P4
    P3 -->|rule baseline| P5
    P4 -->|LLM service list| P5
    P4 -. fallback on failure .-> P5
    P5 -->|validated ServicePlan| D3
    D3 -->|ServicePlan| P6
    P6 -->|diagram XML| User
    D3 -->|ServicePlan| P7
    P7 -->|price query| PRICE
    PRICE -->|unit prices| D2
    D2 -->|prices| P7
    P7 -->|monthly estimate| User
```

## DFD — Module B: Cost Monitoring & Anomaly Detection

### Level 0 (Context Diagram)
```mermaid
flowchart LR
    CE["AWS Cost & Usage API<br/>(Cost Explorer)"]
    Admin["Administrator"]
    Mail["Email service"]
    P0(("P0<br/>Cost Monitoring"))

    P0 -->|daily usage query| CE
    CE -->|usage data| P0
    Admin -->|threshold setting| P0
    P0 -->|trend chart + spike list| Admin
    P0 -->|alert email| Mail
```

### Level 1 (Decomposed)
```mermaid
flowchart TD
    CE["AWS Cost & Usage API"]
    Admin["Administrator"]
    Mail["Email service"]
    P1["P1<br/>Daily Ingestion"]
    P2["P2<br/>Rolling Average"]
    P3["P3<br/>Spike Detection"]
    P4["P4<br/>Spike Ranking"]
    P5["P5<br/>Trend Reporting"]
    P6["P6<br/>Alert Dispatch"]
    D1[("D1<br/>Cost Data Store<br/>(TimescaleDB)")]
    D2[("D2<br/>Threshold Config")]
    D3[("D3<br/>Spike Log")]

    P1 -->|daily usage query| CE
    CE -->|usage data| P1
    P1 -->|store raw costs| D1
    Admin -->|threshold| D2
    D1 -->|daily costs| P2
    P2 -->|7-day avg| P3
    D2 -->|threshold| P3
    D1 -->|usage history| P5
    P3 -->|spike flags| P4
    P4 -->|ranked spikes| D3
    P4 -->|ranked alerts| P6
    P6 -->|alert email| Mail
    P5 -->|30-day trend chart| Admin