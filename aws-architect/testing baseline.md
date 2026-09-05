# AWS Architecture Testing Baseline

## Global baseline

These services are assumed for all deployable repositories and are **not scored**:

- VPC
- Route 53
- ACM
- CloudWatch
- IAM
- Secrets Manager

---

## 1. Kuzma02 Electronics eCommerce

### Tech stack
- Next.js 15 App Router
- React 18
- TypeScript
- Tailwind + daisyUI/Flowbite
- Prisma 6
- MySQL
- NextAuth v4 + bcryptjs
- Zustand
- Zod
- express-fileupload
- ApexCharts
- CSV bulk upload

### Architecture
- Compute: Amplify Hosting **or** App Runner **or** Fargate + ALB
- Database: RDS for MySQL
- Storage/CDN: S3 + CloudFront

### Do not infer
- PostgreSQL
- DynamoDB
- Cognito
- SES
- ElastiCache
- SQS
- OpenSearch
- EKS

### Important signals
- Server-rendered/full-stack Next.js application
- MySQL is explicit
- File uploads justify S3
- No Docker, payments, email, cache, or queue

---

## 2. Decentralized Voting System

### Tech stack
- Solidity + Hardhat
- ethers.js
- React (Create React App)
- Node.js + Express
- JWT authentication
- MongoDB Atlas
- MetaMask
- Sepolia testnet

### Architecture
- Frontend: S3 + CloudFront
- Backend: App Runner **or** Fargate + ALB
- Database: DocumentDB **or** external MongoDB Atlas
- Blockchain RPC: external provider; **no AWS blockchain service required**

### Do not infer
- RDS
- DynamoDB
- Cognito
- Managed Blockchain
- ElastiCache

### Important signals
- CRA frontend is static
- Express is the backend
- MongoDB Atlas is already external
- Blockchain interaction uses external testnet/RPC

---

## 3. Plant Disease Identification using CNN

### Tech stack
- Python
- TensorFlow / Keras
- CNN
- PlantVillage dataset from Kaggle
- Single training script

### Architecture
- Training: SageMaker Training Job (GPU) **or** EC2 g4dn/g5
- Storage: S3 for dataset and model artifacts
- Container/image: ECR
- Monitoring: CloudWatch
- Optional inference:
  - SageMaker Endpoint
  - **or** Lambda container + API Gateway

### Do not infer
- RDS
- DynamoDB
- ALB
- Fargate web tier
- CloudFront
- Cognito
- SQS

### Important signals
- This is a **training workload, not a web service**
- No web app
- No API
- No database
- No Docker in the repository
- GPU compute is appropriate

---

## 4. SatvikPraveen Next.js eCommerce

### Tech stack
- Next.js 15
- React 18
- TypeScript 5.9
- Tailwind + shadcn/ui
- Server Actions
- PostgreSQL 15
- Prisma 5.22
- NextAuth
  - Credentials
  - Google
  - GitHub
  - Discord
- RBAC
- Stripe checkout + webhooks
- Email templates + newsletter
- Jest / RTL / Cypress
- Docker Compose
- GitHub Actions

### Architecture
- Compute: Fargate + ALB **or** Amplify
- Containers: ECR
- Database: RDS for PostgreSQL
- Storage/CDN: S3 + CloudFront
- Email: SES

### Do not infer
- MySQL
- DynamoDB
- ElastiCache
- OpenSearch
- SQS
- Cognito
- EKS

### Important signals
- PostgreSQL is explicit
- Docker evidence supports container deployment
- Stripe is external payment provider
- Email functionality supports SES

---

## 5. pandaind/springboot-microservices

### Tech stack
- Java 17
- Spring Boot 3
- Spring Cloud Config Server
- Eureka
- API Gateway
- Spring Data JPA
- PostgreSQL
- Flyway
- Spring Data MongoDB
- Apache Kafka
- Zipkin
- MailDev SMTP
- Maven
- Docker Compose
- Kubernetes manifests
- ingress.yaml

### Architecture
- Compute/orchestration: EKS
- Containers: ECR
- Load balancing: ALB
- Relational DB: RDS for PostgreSQL
- Document DB: DocumentDB
- Messaging: MSK for Kafka
- Email: SES
- Observability: X-Ray **or** ADOT -> CloudWatch

### Do not infer
- DynamoDB
- SQS as replacement for Kafka
- Amplify
- ElastiCache
- OpenSearch
- Lambda-only architecture

### Important signals
- Kubernetes manifests are explicit evidence for EKS
- Kafka should map to MSK, not SQS
- Both PostgreSQL and MongoDB are used
- Multiple Spring services indicate microservices architecture

---

## 6. rahult18/springcommerce

### Note
The README is incomplete. Important architecture facts were verified in the Maven POMs.

### Tech stack
- Java 21
- Spring Boot 3
- Spring Cloud Gateway MVC
- MongoDB (product service)
- MySQL + JPA + Flyway (order + inventory)
- Kafka
- Avro
- Confluent Schema Registry
- Spring Mail
- OAuth2 Resource Server
- Keycloak
- Resilience4j
- Prometheus
- Zipkin
- Tempo
- TestContainers
- Docker Compose
- No Eureka

### Architecture
- Compute: Fargate + ALB
- Containers: ECR
- Relational DB: RDS for MySQL
- Document DB: DocumentDB
- Messaging: MSK
- Schema management: Glue Schema Registry
- Email: SES
- Identity: Cognito **or** self-hosted Keycloak
- Monitoring: AMP + AMG

### Do not infer
- EKS
- DynamoDB
- ElastiCache
- OpenSearch

### Important signals
- No Kubernetes manifests -> do not assume EKS
- MySQL and MongoDB are both explicit
- Kafka + Avro indicates event-driven microservices
- Keycloak is already part of the application architecture

---

## 7. ibatulanandjp/ecommerce-microservices

### Tech stack
- Java
- Spring Boot
- Spring Cloud Gateway
- Eureka discovery server
- MongoDB (product)
- MySQL (order + inventory)
- Stateless notification service
- Kafka
- Keycloak OAuth2
- Resilience4j
- Micrometer
- Zipkin
- Prometheus
- Grafana
- Docker Compose
- Jib
- No Kubernetes

### Architecture
- Compute: Fargate + ALB
- Containers: ECR
- Relational DB: RDS for MySQL
- Document DB: DocumentDB
- Messaging: MSK
- Email: SES
- Identity: Cognito **or** self-hosted Keycloak
- Monitoring: AMP + AMG
- Tracing: X-Ray

### Do not infer
- EKS
- DynamoDB
- ElastiCache
- OpenSearch
- Amplify
- Lambda-only architecture

### Important signals
- Jib provides strong container deployment evidence
- No Kubernetes -> do not infer EKS
- Kafka -> MSK, not SQS
- Both MySQL and MongoDB are explicit

---

## 8. omarfesal/ecommerce-multi-vendor-platform

### Project status
- README explicitly declares AWS architecture
- Approximately 10 commits
- Early-stage project

### Tech stack / implemented modules
- Java 17
- Spring Boot 3
- Spring Cloud Gateway
- Eureka
- Spring Security JWT/OAuth2
- Liquibase
- Maven
- Docker Compose
- Modules present:
  - API Gateway
  - Auth
  - Product
  - Order
  - Inventory
  - Payment
  - Tenant
  - Service Discovery
- Multi-tenant architecture
- Payment provider is unnamed

### Architecture declared by project
- Compute: EKS **or** Fargate
- Containers: ECR
- Load balancing: ALB
- Database: RDS for PostgreSQL
- NoSQL: DynamoDB
- Cache: ElastiCache for Redis
- Messaging: MSK
- Search: OpenSearch Service
- Static/object storage + CDN: S3 + CloudFront
- Monitoring: CloudWatch + AMP/AMG

### Important warning
The README also mentions:
- Notification
- Search
- Analytics
- Content

These modules **do not exist yet** in the repository.

### Evaluation rule
A good architecture inference should distinguish:

- **Declared**: mentioned in README
- **Built**: actually present in the repository
- **Inferred**: logically derived from implementation

Do not treat README-only future modules as implemented services.

---

# Cross-repository inference rules

## Database mapping

| Repository technology | Expected AWS mapping |
|---|---|
| MySQL | RDS for MySQL |
| PostgreSQL | RDS for PostgreSQL |
| MongoDB | DocumentDB, or external MongoDB when explicitly used |
| MongoDB Atlas | Prefer external Atlas; do not force AWS replacement |

## Compute mapping

| Repository evidence | Expected mapping |
|---|---|
| Next.js hosted app | Amplify, App Runner, or Fargate + ALB |
| Express backend | App Runner or Fargate + ALB |
| Docker/containerized app | ECR + Fargate/appropriate container platform |
| Kubernetes manifests | EKS |
| ML training script | SageMaker Training Job or GPU EC2 |
| Static CRA frontend | S3 + CloudFront |

## Messaging mapping

| Technology | Expected mapping |
|---|---|
| Apache Kafka | MSK |
| Kafka + Avro/schema registry | MSK + Glue Schema Registry |
| No queue/event system | Do not invent SQS |

## Authentication mapping

| Evidence | Expected mapping |
|---|---|
| NextAuth | Application-level auth; do not automatically map to Cognito |
| Keycloak | Self-hosted Keycloak, or explicitly proposed Cognito alternative |
| JWT | Auth mechanism; not by itself proof of Cognito |

## Storage/CDN mapping

Use S3 + CloudFront when there is clear evidence for:
- Static frontend hosting
- User/file uploads
- Object storage
- CDN delivery

Do not add CloudFront merely because the project is a web application.

## Email mapping

Map email functionality to SES only when the repository shows:
- Mail sending
- SMTP/mail integration
- Email templates
- Notification emails

Do not add SES to projects with no email functionality.

## Monitoring mapping

Existing evidence such as:
- Prometheus
- Grafana
- Zipkin
- Tempo
- Micrometer
- CloudWatch

should influence the observability architecture.

---

# Scoring guidance

For each inferred AWS service, evaluate:

1. **Evidence exists**  
   Is there repository evidence supporting the service?

2. **Correct mapping**  
   Is the technology mapped to the appropriate AWS service?

3. **No unsupported services**  
   Did the model invent services with no evidence?

4. **Deployment fit**  
   Does the compute choice match the project type?

5. **Implemented vs declared**  
   Does the model distinguish existing code from README plans?

6. **Alternatives handled correctly**  
   When multiple valid architectures exist, are they presented as alternatives rather than all being treated as mandatory?

---

# Key failure patterns to watch for

- Mapping MySQL projects to PostgreSQL or DynamoDB
- Mapping MongoDB Atlas to RDS
- Mapping Kafka to SQS
- Adding Cognito whenever authentication exists
- Adding SES without email functionality
- Adding ElastiCache without cache/Redis evidence
- Adding OpenSearch without search requirements
- Adding EKS without Kubernetes evidence
- Treating every Next.js project as Amplify-only
- Treating ML training code as a web application
- Treating README roadmap items as implemented modules
- Adding Lambda/API Gateway to projects with no serverless evidence
