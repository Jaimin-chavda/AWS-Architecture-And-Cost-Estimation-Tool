# SENIOR GRADUATION PROJECT (SGP) — PROGRESS REPORT

---

## Project Details

- **Project Title:** AWS Architect: Automated Cloud Architecture and Cost Estimation Tool
- **Mentor:** Dr. Amitkumar Nayak
- **Industry Expert:** Mansi Solanki
- **Student IDs:** D25DCE175, D25DCE170, D25DCE164
- **Review Period:** Academic Year 2026 (Phase 2 Review)
- **Scope:** **Module A — AI Architecture Advisor, only.** The Modules B (Cost Monitoring), C (Resource Optimization), and D (Security Scanner) originally scoped in W1 are **descoped as of 2026-09-05** and are not being pursued. All work described below, and all future improvements listed in Section 4, are within Module A.

---

## 1. Project Goal

> **Goal Statement:**  
> To analyze any GitHub repository or plain project idea, automatically suggest its required AWS cloud architecture, and generate an interactive draw.io deployment diagram, realistic cost estimate, and deployable CloudFormation template.

Scope is limited to this single capability (Module A). Live AWS-account monitoring, resource-optimization scanning, and security posture scanning are outside the project's scope.

---

## 2. Work Completed in the Current Phase

In direct response to external evaluation feedback, the current development phase focused on three major architectural capabilities:

### 2.1 Official AWS Pricing API & Multi-Region Cost Integration
* **Transition to Live AWS Rates:** Previously, the application depended mainly on predefined static pricing information, which could lead to less accurate estimates because AWS pricing differs across geographic regions and changes over time.
* **Official Pricing Endpoints:** The system was upgraded to programmatically query official AWS pricing endpoints (`@aws-sdk/client-pricing` / AWS Price List API) whenever possible, delivering accurate, regionalized on-demand unit costs for services across global regions (e.g., `us-east-1`, `ap-south-1`, `eu-west-1`).
* **Graceful Degradation & High Availability:** If current pricing cannot be retrieved due to network disruptions, rate limits, or absence of credentials, the system falls back to a verified baseline pricing catalog, ensuring the tool remains responsive and fully operational during demonstrations.
* **Interactive Cost Simulator:** Integrated an instant, client-side scaling slider allowing users to adjust expected active user load ($100 \rightarrow 1,000,000$ users). Cost adjustments recalculate in real time with zero network overhead, demonstrating how cloud expenditure scales as the application grows.

---

### 2.2 Alternative Architecture Suggestions & Trade-Off Analysis
* **Multi-Proposal Engine:** Previously, the application produced a single static architecture, even though modern cloud engineering offers multiple viable deployment strategies for any given application.
* **Context-Driven Alternatives:** The system now generates alternative architecture options alongside the primary design and clearly articulates their core differences:
  - **Serverless vs. Analytics Pipeline:** Compares a cost-optimized, low-latency transactional serverless architecture (AWS Lambda, API Gateway, DynamoDB) against an analytics-focused data pipeline (S3, Kinesis, Redshift / Athena).
  - **Containerized vs. Serverless:** Compares a containerized deployment on ECS/Fargate (zero cold-starts, persistent connection pools for steady high concurrency) against a serverless Lambda model (scale-to-zero compute spend during idle periods).
* **Multi-Dimensional Comparison:** Enables users to evaluate architectural alternatives side-by-side across six practical dimensions:
  1. **Cost:** Baseline idle spend vs. high-traffic cost scaling.
  2. **Scalability:** Elastic auto-scaling vs. provisioned resource thresholds.
  3. **Performance:** Steady-state throughput vs. cold-start response latency.
  4. **Application Requirements:** Key-value transactional workloads vs. complex ad-hoc analytical queries.
  5. **Expected Traffic:** Predictable constant load vs. intermittent/bursty traffic spikes.
  6. **Operational Complexity:** Maintenance overhead of container images and VPC networking vs. managed serverless runtimes.
* **Decision Support:** The objective is not to declare one design universally superior, but to empower engineers to make informed trade-offs tailored to their specific constraints.

---

### 2.3 CloudFormation Template (IaC) Generation
* **From Visual Diagrams to Provisioning Code:** Previously, users could only view and export the architecture as a draw.io diagram, requiring manual and error-prone translation into cloud resources.
* **Automated IaC Synthesis:** Implemented an Infrastructure-as-Code engine that generates valid, deployable AWS CloudFormation (CFT YAML) templates derived directly from the inferred architecture.
* **Supported Core AWS Resources:**
  - **Compute:** AWS Lambda functions, Amazon ECS clusters, task definitions, and services.
  - **Ingress & Networking:** Amazon API Gateway REST APIs, Application Load Balancers (ALB), VPCs, and public/private subnets.
  - **Storage & Databases:** Amazon S3 buckets, Amazon DynamoDB tables, and Amazon RDS database instances.
  - **Messaging & Coordination:** Amazon SQS queues, Amazon SNS topics, and Amazon EventBridge rules.
* **Production-Aligned Templates:** Injects required IAM execution roles with least-privilege managed policies, environment parameters (`AppName`, `Environment`), and output ARNs, accompanied by appropriate architectural review disclaimers.

---

## 3. Problems and Challenges Faced

During the implementation of this phase, several technical challenges were addressed:

1. **Repository Analysis Constraints:**  
   Repositories vary widely in structure, size, and packaging. Monorepos, deeply nested subdirectories, and large non-code assets caused processing slowdowns and occasional API timeouts, necessitating file-selection heuristics, file size caps, and prioritized manifest parsing.

2. **Architecture Diagram Generation & Readability:**  
   Generating clean, publication-ready draw.io diagrams programmatically presented visual layout hurdles—including overlapping labels on long AWS service names, crowded nodes in complex subnets, crisscrossing connection lines, and off-center canvas placement. These were resolved by implementing calculated bounding boxes, text word-wrapping, tier-based orthogonal gutter edge routing, and canvas translation offsets.

3. **Diversity of Project Archetypes:**  
   A one-size-fits-all architecture cannot suit diverse application domains (e.g., static frontend SPAs, high-throughput microservices, event-driven queues, ML model pipelines). The classification engine had to be refined using multi-signal evidence extraction across manifests, Dockerfiles, and cloud SDK calls.

4. **Architecture and Cost Consistency:**  
   Dynamic changes or alternative proposals in AWS services required immediate, synchronized updates to diagram structures, cost estimation rows, and CloudFormation definitions without contract drift.

5. **AI and API Reliability:**  
   External LLM providers and remote pricing APIs occasionally encounter transient rate limits, format drift, or latency spikes. A rules-first fallback safety net was architected to guarantee deterministic baseline generation even when external APIs are unreachable.

---

## 4. Future Improvements

Subsequent phases will refine and expand upon the established Module A foundation. All items below are Module A improvements; none of them reintroduce Modules B/C/D:

- **Repository Analysis:** Enhance parsing depth for large enterprise monorepos and polyglot stacks, improving automatic detection of background workers, message queues, and implicit database drivers.
- **Architecture Generation:** Expand rule-scoring algorithms and LLM prompting to support hybrid, multi-region, and multi-tier architectures with higher classification precision.
- **Diagram Generation:** Further improve diagram visual ergonomics by introducing automatic cluster auto-sizing, custom grouping containers for private microservices, and enhanced icon styling.
- **Cost Estimation:** Deepen cost modeling by incorporating regional data transfer costs, managed NAT gateway rates, and AWS Free Tier discount thresholds into the interactive simulator.
- **Architecture Comparison:** Deliver richer visual comparison diffs (visual highlighting of components added or removed between primary and alternate designs) alongside tabular cost variance breakdowns.
- **CloudFormation & IaC Expansion:** Enhance generated CloudFormation templates with customizable CIDR blocks, KMS encryption configurations, and optional Terraform (`.tf`) syntax export.
- **Deployment:** Host the application for real use rather than running it only as a local demo (see `.planning/PROJECT.md`, Decision #45).

### Explicitly Not Planned

Modules B (Cost Monitoring), C (Resource Optimization), and D (Security Scanner) — originally scoped in the W1 requirement gathering — are descoped as of 2026-09-05. Their supporting infrastructure (AWS Cost Explorer ingestion, TimescaleDB time-series storage, CIS-benchmark scanning, SES alerting) is therefore not part of the project and is not planned future work.

---

## 5. Conclusion

The current phase of the **AWS Architect** Senior Graduation Project achieved significant functional milestones by incorporating key recommendations from external evaluation:
- Programmatic integration of official AWS pricing with client-side cost simulation.
- Contextual alternative architecture proposals with multi-dimensional trade-off comparisons.
- One-click deployable AWS CloudFormation (CFT YAML) template generation.

All features are supported by automated verification tests ensuring shape stability, diagram integrity, and fallback safety. The project scope has been deliberately narrowed to Module A so that the single core capability — turning source code or an idea into a well-architected, cost-transparent AWS design — is delivered to depth rather than four modules delivered shallowly.

---

**Submitted by:**  
- **D25DCE175**  
- **D25DCE170**  
- **D25DCE164**  

**Under the Guidance of:**  
- **Dr. Amitkumar Nayak** (Project Mentor)  
- **Mansi Solanki** (Industry Expert)  
