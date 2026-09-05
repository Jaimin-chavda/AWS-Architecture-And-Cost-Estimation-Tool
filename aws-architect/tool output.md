# AWS Architecture Inference Test Set - Agent Evaluation Report

## Purpose

Benchmark data for evaluating an tool that analyzes GitHub repositories and:

1. detects the application technology stack;
2. identifies repository/application components;
3. infers appropriate AWS services;
4. grounds each inference in repository evidence;
5. assigns confidence to each inference;
6. classifies the architecture pattern.

## Important Evaluation Rule

Keep these concepts separate:

- **Detected technology** = directly visible in repository files/dependencies/configuration.
- **Repository component** = application component identified from the codebase.
- **Inferred AWS service** = proposed AWS target for a detected component.
- **Pattern service** = generic infrastructure/service added from an architecture pattern rather than direct repository evidence.
- **External dependency** = technology/service that may not be replaced by an AWS service and should not automatically be mapped.

The test set exposes several cases where the current inference logic appears too template-driven. Agents should preserve repository evidence and avoid inventing infrastructure.

---

## Dataset Summary

| # | Repository / Test Case | Pattern | Stack | Reported AWS Entries | Cost |
|---|---|---|---|---:|---:|
| 1 | Electronics eCommerce Shop with Admin Dashboard | containerised-app | Node.js/TypeScript, Next.js, React, Express, Prisma, MySQL | 5 | $170.47 |
| 2 | Decentralized Voting System (VoteChain) | full-stack-web | Node.js/TypeScript, Express, React, Vite, MongoDB, Solidity/Hardhat | 11 | $141.61 |
| 3 | Plant Disease Identification using CNN | generic | Python/CNN from README; no structured stack detected | 5 | $62.99 |
| 4 | Next.js eCommerce | generic | Node.js/TypeScript, Next.js, React, Prisma, Docker Compose, Dockerfile | 10 | $109.08 |
| 5 | Spring Boot Microservices | event-driven | Java/JVM, Spring Boot, Spring Data JPA, PostgreSQL, MongoDB, Kafka | 15 | $268.13 |
| 6 | SpringCommerce | generic | Java/JVM, Spring Boot, Spring Data JPA, MySQL, MongoDB | 11 | $137.15 |
| 7 | eCommerce Microservices / Micro Marketplace | event-driven | Java/JVM, Spring Boot, Spring Data JPA, MySQL, MongoDB, Docker Compose, Kafka, Keycloak, Eureka, Zipkin, Prometheus, Grafana | 15 | $161.63 |
| 8 | eCommerce Multi-Vendor Platform | event-driven | Java/JVM, Spring Boot, Spring Data JPA, PostgreSQL, Redis, Kafka, OpenSearch, AWS SDKs, Docker Compose | 27 | $583.82 |

**Note:** Cost values are retained only as reference metadata. They are not the primary benchmark target for architecture inference.

---

# Test Case 1 - Electronics eCommerce Shop with Admin Dashboard

**Repository:** `https://github.com/Kuzma02/Electronics-eCommerce-Shop-With-Admin-Dashboard-NextJS-NodeJS`

**Pattern:** `containerised-app`

### Detected Stack

- Language/runtime: Node.js, TypeScript
- Frontend: Next.js, React
- Backend: Express.js
- Database/ORM: Prisma ORM, MySQL
- Infrastructure/CI: GitHub Actions (`.github/workflows/blank1.yml`)

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `svc-lambda` | backend | Lambda | Lambda handler/function definition reported |
| `svc-ec2` | backend | EC2 | EC2 instance reference reported |
| `svc-eks` | backend | EKS/Kubernetes | EKS/Kubernetes reference reported |
| `svc-rds` | database | RDS | MySQL dependency + DB connection configuration |
| `svc-cloudwatch` | proxy | CloudWatch | monitoring for active compute services |

### Current Inferred AWS Services

| AWS Service | Component | Confidence | Evidence |
|---|---|---|---|
| Lambda | `svc-lambda` | HIGH | Lambda handler/function definition |
| EC2 | `svc-ec2` | HIGH | EC2 instance reference |
| EKS | `svc-eks` | HIGH | EKS/Kubernetes reference |
| RDS | `svc-rds` | MEDIUM | MySQL dependency and connection configuration |
| CloudWatch | `svc-cloudwatch` | MEDIUM | monitoring assumption |

### Agent Validation Notes

- The simultaneous HIGH-confidence mapping to **Lambda + EC2 + EKS** is suspicious unless the repository contains explicit deployment evidence for all three.
- A MySQL dependency supports a database choice, but does not by itself prove RDS is actually deployed.
- CloudWatch is a reasonable operational target, but should be marked inferred unless monitoring configuration is present.
- This is a strong test for **mutually inconsistent compute-service inference**.

---

# Test Case 2 - Decentralized Voting System (VoteChain)

**Repository:** `https://github.com/Jaimin-chavda/Decentralized-Voting-System`

**Pattern:** `full-stack-web`

### Detected Stack

- Language/runtime: Node.js, TypeScript
- Frontend: React, Vite
- Backend: Express.js
- Database: MongoDB
- Blockchain: Solidity, Hardhat

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `frontend` | frontend | React | `frontend/package.json`, README, React dependency |
| `backend` | api | Express | `backend/package.json`, `backend/server/index.js`, README |
| `database` | database | MongoDB | `package.json` MongoDB dependency, `MONGO_URI` config |
| `blockchain` | external-service | Solidity | README and `contracts/` |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| S3 | frontend | HIGH |
| CloudFront | frontend | HIGH |
| API Gateway | backend | HIGH |
| DocumentDB | database | HIGH |
| Route 53 | generic pattern | MEDIUM |
| CloudFront | generic pattern | HIGH |
| ALB | generic pattern | MEDIUM |
| ECS | generic pattern | HIGH |
| CloudWatch | generic pattern | HIGH |
| Secrets Manager | generic pattern | MEDIUM |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- **CloudFront is duplicated**: once as frontend mapping and once as generic pattern mapping.
- The architecture should deduplicate service counts while preserving component-level evidence.
- MongoDB -> DocumentDB may be a valid AWS target, but the repository only proves MongoDB usage, not DocumentDB deployment.
- Solidity/Hardhat is an important external dependency and should not automatically disappear from the architecture.
- Generic ECS/ALB/Route 53/CloudFormation services appear pattern-driven unless explicit infrastructure files prove them.

---

# Test Case 3 - Plant Disease Identification using CNN

**Repository:** not explicitly listed in the report metadata.

**Pattern:** `generic`

### Detected Stack

- Structured stack detection: none
- Application technology inferred from README: Python / Convolutional Neural Network
- Dataset dependency: Kaggle PlantVillage dataset

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `cnn-model` | worker | Python / CNN | README: plant disease detection using CNN |
| `kaggle-dataset` | external-service | Kaggle | README instructs downloading PlantVillage dataset from Kaggle |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| ECS | `cnn-model` | MEDIUM |
| Route 53 | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| Secrets Manager | generic pattern | MEDIUM |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- This test checks behavior when **structured package/deployment signals are weak or absent**.
- Python/CNN detection comes from README evidence rather than dependency metadata.
- Kaggle is an external dependency and should remain explicit.
- ECS is a possible deployment target, not proof of deployment.
- Generic network/operations infrastructure should not be added without supporting evidence or an explicit architecture-targeting mode.

---

# Test Case 4 - Next.js eCommerce

**Pattern:** `generic`

### Detected Stack

- Language/runtime: Node.js, TypeScript
- Frontend: Next.js, React
- ORM: Prisma
- Infrastructure: Docker Compose, Dockerfile
- CI/CD: GitHub Actions

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `dc-app` | backend | Next.js | `docker-compose.yml`, Dockerfile, `package.json` |
| `dc-postgres` | database | PostgreSQL | Docker Compose image + README |
| `dc-redis` | cache | Redis | Docker Compose image |
| `s3-storage` | object-storage | AWS S3 | `@aws-sdk/client-s3` dependency |
| `stripe-api` | external-service | Stripe | README and Stripe key configuration |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| ECS | `dc-app` | MEDIUM |
| RDS | `dc-postgres` | HIGH |
| ElastiCache | `dc-redis` | HIGH |
| S3 | `s3-storage` | HIGH |
| Route 53 | generic pattern | MEDIUM |
| CloudFront | generic pattern | HIGH |
| ALB | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| Secrets Manager | generic pattern | MEDIUM |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- PostgreSQL -> RDS and Redis -> ElastiCache are reasonable managed-service targets, but repository evidence only proves local/development technology usage.
- `@aws-sdk/client-s3` is direct evidence of AWS S3 usage and should receive stronger confidence.
- Stripe must remain an external integration.
- Generic infrastructure services require explicit deployment evidence or a clearly documented target-architecture assumption.

---

# Test Case 5 - Spring Boot Microservices

**Pattern:** `event-driven`

### Detected Stack

- Language/runtime: Java/JVM
- Frameworks: Spring Boot, Spring Data JPA
- Databases: PostgreSQL, MongoDB
- Messaging: Apache Kafka

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `gateway` | proxy | Spring Cloud Gateway | `gateway/pom.xml`, README |
| `config-server` | backend | Spring Cloud Config | `config-server/pom.xml`, README |
| `discovery` | backend | Eureka | `discovery/pom.xml`, README |
| `customer-service` | api | Spring Boot | `customer/pom.xml`, README |
| `product-service` | api | Spring Boot | `product/pom.xml`, README |
| `order-service` | api | Spring Boot | `order/pom.xml`, README |
| `payment-service` | api | Spring Boot | `payment/pom.xml`, README |
| `notification-service` | worker | Spring Boot | `notification/pom.xml`, README |
| `postgres` | database | PostgreSQL | PostgreSQL dependency / README |
| `mongodb` | database | MongoDB | README |
| `kafka` | messaging | Apache Kafka | README |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| ECS | `config-server` | MEDIUM |
| ECS | `discovery` | MEDIUM |
| API Gateway | `customer-service` | HIGH |
| API Gateway | `product-service` | HIGH |
| API Gateway | `order-service` | HIGH |
| API Gateway | `payment-service` | HIGH |
| ECS | `notification-service` | MEDIUM |
| RDS | `postgres` | HIGH |
| DocumentDB | `mongodb` | HIGH |
| Kinesis | `kafka` | HIGH |
| Route 53 | generic pattern | MEDIUM |
| ALB | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| Secrets Manager | generic pattern | MEDIUM |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- Kafka -> **Kinesis** is a semantic substitution, not a direct detection.
- Multiple microservices mapped independently to API Gateway may be architecturally questionable; an API Gateway is normally an ingress/gateway layer rather than a replacement for every service.
- PostgreSQL -> RDS and MongoDB -> DocumentDB are target-service mappings and should be clearly distinguished from detected technologies.
- Eureka and Spring Cloud Config do not automatically imply equivalent AWS services without an architecture decision.

---

# Test Case 6 - SpringCommerce

**Pattern:** `generic`

### Detected Stack

- Language/runtime: Java/JVM
- Frameworks: Spring Boot, Spring Data JPA
- Databases: MySQL, MongoDB

### Repository Components

| Component | Type | Technology | Evidence |
|---|---|---|---|
| `api-gateway` | proxy | Spring Boot | `api-gateway/pom.xml` |
| `product-service` | api | Spring Boot | `product-service/pom.xml`, README |
| `order-service` | api | Spring Boot | `order-service/pom.xml`, README |
| `inventory-service` | api | Spring Boot | `inventory-service/pom.xml`, README |
| `notification-service` | worker | Spring Boot | `notification-service/pom.xml` |
| `mongodb` | database | MongoDB | README |
| `mysql` | database | MySQL | README |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| API Gateway | `product-service` | HIGH |
| API Gateway | `order-service` | HIGH |
| API Gateway | `inventory-service` | HIGH |
| ECS | `notification-service` | MEDIUM |
| DocumentDB | `mongodb` | HIGH |
| RDS | `mysql` | HIGH |
| Route 53 | generic pattern | MEDIUM |
| ALB | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| Secrets Manager | generic pattern | MEDIUM |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- Service-to-API-Gateway mappings should be reviewed for architectural correctness.
- MongoDB/MySQL are detected databases; DocumentDB/RDS are proposed managed-service targets.
- No messaging technology is evidenced in this test, so event-driven infrastructure should not be inferred without repository support.

---

# Test Case 7 - eCommerce Microservices / Micro Marketplace

**Pattern:** `event-driven`

### Detected Stack

- Language/runtime: Java/JVM
- Frameworks: Spring Boot, Spring Data JPA
- Database: MySQL, MongoDB
- Infrastructure: Docker Compose
- Messaging: Kafka + ZooKeeper
- Identity: Keycloak
- Service discovery: Eureka
- Gateway: Spring Cloud Gateway
- Observability: Zipkin, Prometheus, Grafana

### High-Confidence Repository Components

| Component | Type | Technology |
|---|---|---|
| `dc-mysql-order` | database | MySQL |
| `dc-mysql-inventory` | database | MySQL |
| `dc-mongo` | database | MongoDB |
| `dc-keycloak-mysql` | database | MySQL |
| `dc-keycloak` | auth | Keycloak |
| `dc-zookeeper` | messaging | ZooKeeper |
| `dc-broker` | queue | Kafka |
| `dc-zipkin` | external-service | Zipkin |
| `dc-discovery-server` | proxy | Netflix Eureka |
| `dc-api-gateway` | proxy | Spring Cloud Gateway |
| `dc-product-service` | api | Spring Boot |
| `dc-order-service` | api | Spring Boot |
| `dc-inventory-service` | api | Spring Boot |
| `dc-notification-service` | worker | Spring Boot |
| `dc-prometheus` | external-service | Prometheus |
| `dc-grafana` | external-service | Grafana |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| RDS | `dc-mysql-order` | HIGH |
| RDS | `dc-mysql-inventory` | HIGH |
| DocumentDB | `dc-mongo` | HIGH |
| RDS | `dc-keycloak-mysql` | HIGH |
| Secrets Manager | `dc-keycloak` | HIGH |
| SQS | `dc-zookeeper` | HIGH |
| SQS | `dc-broker` | HIGH |
| API Gateway | `dc-product-service` | HIGH |
| API Gateway | `dc-order-service` | HIGH |
| API Gateway | `dc-inventory-service` | HIGH |
| ECS | `dc-notification-service` | MEDIUM |
| Route 53 | generic pattern | MEDIUM |
| ALB | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- **Kafka -> SQS is a major semantic mismatch.** Kafka is an event-streaming platform; SQS is a queue. Mapping should be justified or replaced with a closer AWS streaming equivalent.
- **ZooKeeper -> SQS is also incorrect semantically.** ZooKeeper is a coordination service, not a queue.
- Keycloak -> Secrets Manager is not an equivalent service mapping; Keycloak is an identity/access-management platform.
- Zipkin, Prometheus, Grafana and Eureka should remain visible as application infrastructure/external technologies unless an explicit AWS replacement is selected.
- This repository is useful for testing **microservice decomposition and infrastructure-component preservation**.

---

# Test Case 8 - eCommerce Multi-Vendor Platform

**Pattern:** `event-driven`

### Detected Stack

- Language/runtime: Java/JVM
- Frameworks: Spring Boot, Spring Data JPA
- Databases: PostgreSQL, Redis, OpenSearch
- Infrastructure: Docker Compose
- Messaging: Kafka
- AWS SDK usage: S3, DynamoDB, SQS
- Application services: gateway, service discovery, auth, tenant/product/inventory/order/payment services
- Observability: Prometheus, Grafana, Jaeger

### Repository Components

Key components directly evidenced by the repository include:

| Component | Type | Technology |
|---|---|---|
| `api-gateway` | proxy | Spring Cloud Gateway |
| `service-discovery` | proxy | Eureka Server |
| `auth-service` | auth | Spring Security JWT |
| `tenant-service` | backend | Spring Boot |
| `product-service` | backend | Spring Boot |
| `inventory-service` | backend | Spring Boot |
| `order-service` | backend | Spring Boot |
| `payment-service` | backend | Spring Boot |
| `dc-postgres` | database | PostgreSQL |
| `dc-pgadmin` | frontend | pgAdmin |
| `dc-redis` | cache | Redis |
| `dc-zookeeper` | backend | ZooKeeper |
| `dc-kafka` | messaging | Kafka |
| `dc-opensearch` | search | OpenSearch |
| `dc-opensearch-dashboards` | frontend | OpenSearch Dashboards |
| `dc-prometheus` | backend | Prometheus |
| `dc-grafana` | frontend | Grafana |
| `dc-jaeger` | backend | Jaeger |
| `aws-s3` | object-storage | AWS S3 |
| `aws-dynamodb` | database | DynamoDB |
| `aws-sqs` | queue | AWS SQS |

### Current Inferred AWS Services

| AWS Service | Component | Confidence |
|---|---|---|
| Secrets Manager | `auth-service` | HIGH |
| ECS | `tenant-service` | MEDIUM |
| ECS | `product-service` | MEDIUM |
| ECS | `inventory-service` | MEDIUM |
| ECS | `order-service` | MEDIUM |
| ECS | `payment-service` | MEDIUM |
| RDS | `dc-postgres` | HIGH |
| S3 | `dc-pgadmin` | HIGH |
| CloudFront | `dc-pgadmin` | HIGH |
| ElastiCache | `dc-redis` | HIGH |
| ECS | `dc-zookeeper` | MEDIUM |
| Kinesis | `dc-kafka` | HIGH |
| SageMaker | `dc-opensearch` | MEDIUM |
| S3 | `dc-opensearch-dashboards` | HIGH |
| CloudFront | `dc-opensearch-dashboards` | HIGH |
| ECS | `dc-prometheus` | MEDIUM |
| S3 | `dc-grafana` | HIGH |
| CloudFront | `dc-grafana` | HIGH |
| ECS | `dc-jaeger` | MEDIUM |
| S3 | `aws-s3` | HIGH |
| DynamoDB | `aws-dynamodb` | HIGH |
| SQS | `aws-sqs` | HIGH |
| Route 53 | generic pattern | MEDIUM |
| CloudFront | generic pattern | HIGH |
| ALB | generic pattern | MEDIUM |
| CloudWatch | generic pattern | HIGH |
| CloudFormation | generic pattern | LOW |

### Agent Validation Notes

- This repository has **direct AWS SDK evidence** for S3, DynamoDB and SQS. Those should rank above pattern-derived mappings.
- Kafka -> Kinesis is more semantically plausible than Kafka -> SQS, but still represents a target-service mapping rather than evidence of AWS Kinesis deployment.
- **OpenSearch -> SageMaker is incorrect semantically.** OpenSearch should not be represented as SageMaker merely because both are AWS services used in broader data/ML architectures.
- ZooKeeper should remain a coordination dependency unless an AWS-native replacement is explicitly selected.
- pgAdmin/Grafana/OpenSearch Dashboards are application tooling, not necessarily static websites requiring S3 + CloudFront.

---

# Cross-Test Findings for Agent Evaluation

## 1. Evidence Grounding

The agent should prioritize evidence in this order:

1. Explicit AWS infrastructure/configuration (`terraform`, CloudFormation/CDK, SAM, serverless config, ECS/EKS manifests, deployment scripts).
2. Direct AWS SDK/client dependencies and explicit AWS resource references.
3. Docker Compose/Dockerfile/container configuration.
4. Framework/dependency files (`package.json`, `pom.xml`, etc.).
5. README/documentation statements.
6. Generic architecture assumptions.

Generic assumptions should never override stronger repository evidence.

## 2. Detection vs Inference

A repository containing `MongoDB` proves MongoDB usage. It does **not** prove Amazon DocumentDB deployment.

A repository containing `Kafka` proves Kafka usage. It does **not** prove Kinesis deployment.

A repository containing `Docker Compose` proves local/container orchestration configuration. It does **not** prove ECS deployment.

A repository containing a database client proves database usage. It does **not** prove the exact AWS managed service used in production.

## 3. Service Equivalence Problems Seen

Known problematic mappings in the current test outputs:

| Source Technology | Current Mapping | Problem |
|---|---|---|
| Kafka | Kinesis | target mapping, not direct evidence; needs semantic justification |
| Kafka | SQS | semantic mismatch: streaming/event log vs queue |
| ZooKeeper | SQS | semantic mismatch: coordination vs queue |
| Keycloak | Secrets Manager | semantic mismatch: IAM/identity platform vs secret storage |
| OpenSearch | SageMaker | semantic mismatch: search/analytics vs ML platform |
| pgAdmin / Grafana / OpenSearch Dashboards | S3 + CloudFront | deployment assumption, not implied by being a UI |
| MongoDB | DocumentDB | plausible managed target, but target inference rather than detected deployment |
| PostgreSQL/MySQL | RDS | plausible managed target, but target inference rather than detected deployment |

## 4. Generic Pattern Leakage

The following services appear repeatedly without repository-specific evidence:

- Route 53
- ALB
- CloudWatch
- Secrets Manager
- CloudFormation
- CloudFront
- ECS

Agents should not automatically add these services solely because a repository is classified as `full-stack-web`, `generic`, `containerised-app`, or `event-driven`.

## 5. Duplicate Services

Service counting should support both:

- `unique_services`: unique AWS service names in the architecture;
- `service_mappings`: every component-to-service mapping with evidence and confidence.

Example: VoteChain contains CloudFront twice. The architecture may have one CloudFront service node while still retaining multiple reasons/components that reference it.

## 6. Confidence Calibration

Recommended meaning:

- **HIGH**: direct, explicit repository evidence strongly supports the exact claim.
- **MEDIUM**: technology/component is clear, but the AWS target requires an architectural assumption.
- **LOW**: mostly pattern-based or weakly supported; should require additional verification.

A HIGH-confidence label should not be used for a generic architectural guess.

## 7. Architecture Pattern Classification

Expected patterns represented in this benchmark:

- `full-stack-web`
- `containerised-app`
- `event-driven`
- `generic`

Pattern classification should be derived from repository structure and detected technologies, not from the presence of generic AWS services.

---

# Agent Evaluation Checklist

For each repository, verify:

- [ ] Language/runtime correctly detected.
- [ ] Frameworks correctly detected.
- [ ] Databases correctly detected.
- [ ] Messaging/event systems correctly detected.
- [ ] Infrastructure/deployment files correctly detected.
- [ ] External services/integrations preserved.
- [ ] Application components identified from real repository evidence.
- [ ] AWS service mappings are semantically valid.
- [ ] Direct AWS evidence is distinguished from target architecture inference.
- [ ] Generic pattern services are not hallucinated.
- [ ] Duplicate service entries are deduplicated in the final architecture graph.
- [ ] Confidence matches evidence strength.
- [ ] Architecture pattern matches repository structure.

# Recommended Agent Output Schema

```yaml
repository:
  name: "..."
  url: "..."

architecture_pattern:
  name: "full-stack-web|containerised-app|event-driven|generic"
  confidence: "HIGH|MEDIUM|LOW"

tech_stack:
  languages: []
  frameworks: []
  databases: []
  messaging: []
  infrastructure: []
  external_services: []
  aws_dependencies: []

components:
  - id: "..."
    type: "frontend|api|backend|worker|database|cache|messaging|auth|proxy|search|external-service|object-storage|queue"
    technology: "..."
    status: "detected|inferred"
    confidence: "HIGH|MEDIUM|LOW"
    evidence:
      - file: "path/to/file"
        signal: "dependency|config|docker-compose|dockerfile|readme|aws-sdk|infrastructure"
        detail: "..."

aws_services:
  - service: "..."
    component_ids: ["..."]
    confidence: "HIGH|MEDIUM|LOW"
    mapping_type: "direct-evidence|managed-service-target|pattern-inference"
    evidence: "..."
    semantic_equivalence: "valid|approximate|invalid|unknown"

validation_flags:
  - "..."

unsupported_inferences:
  - "..."
```

# Priority Issues to Fix in the Inference Engine

1. Stop treating generic architecture patterns as repository evidence.
2. Separate **detected technology** from **AWS target service**.
3. Improve semantic service mapping for Kafka, ZooKeeper, Keycloak, OpenSearch, and developer/observability tools.
4. Preserve external technologies such as Stripe, Kaggle, Solidity/Hardhat, Keycloak, Eureka, Zipkin, Prometheus and Grafana.
5. Deduplicate AWS services at architecture-graph level while retaining all component mappings.
6. Recalibrate HIGH/MEDIUM/LOW confidence based on evidence strength.
7. Prefer explicit deployment/infrastructure files over README-only or dependency-only evidence when deciding whether an AWS service is actually deployed.
