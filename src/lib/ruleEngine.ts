/**
 * ruleEngine.ts
 *
 * Deterministic signal-based service detection — produces a ServicePlan
 * baseline without any LLM call. No pattern scoring, no slot limits.
 * Patterns only used as sanity-check in final mapping (architecture.ts).
 */

import { ServicePlanSchema } from "./schema.ts";
import type {
  ServicePlan,
  ServiceId,
  ConfidenceTier,
  Grounding,
  DiscoveredComponent,
  ComponentRelationship,
  DeploymentModel,
  AwsServiceMapping,
  MappingCategory,
} from "./schema.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";
import { type PatternId, deduplicateAwsMappings } from "./architecture.ts";
import { buildAlternateProposal } from "./patternAlternates.ts";

// ---------------------------------------------------------------------------
// RuleInput — signals available to the rule engine
// ---------------------------------------------------------------------------

export interface RuleInput {
  description: string;
  fileContent: string;
  fileNames: string[];
  inputKind: "github_url" | "description";
  grounding: Grounding;
  truncated: boolean;
  parseErrors: string[];
  profile?: ProjectProfile;
}

// ---------------------------------------------------------------------------
// Service detection — keyword + profile-based
// ---------------------------------------------------------------------------

export interface DetectedService {
  serviceId: ServiceId;
  confidence: ConfidenceTier;
  evidence: string;
  category?: MappingCategory;
}

const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_RANK: Record<MappingCategory, number> = {
  "repository-evidence": 4,
  "deployment-requirement": 3,
  "inference": 2,
  "recommendation": 1,
};

function hasAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function hasWord(text: string, words: string[]): boolean {
  return words.some((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(text);
  });
}

function profileHasFramework(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.frameworks.some((f) => lower.some((n) => f.name.toLowerCase().includes(n)));
}

function profileHasDatabase(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.databases.some((d) => lower.some((n) => d.name.toLowerCase().includes(n)));
}

function profileHasInfra(profile: ProjectProfile, ...names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase());
  return profile.infrastructure.some((i) => lower.some((n) => i.name.toLowerCase().includes(n)));
}

function profileHasAwsUsage(profile: ProjectProfile, ...services: string[]): boolean {
  const lower = services.map((s) => s.toLowerCase());
  return profile.awsUsage.some((a) => lower.some((s) => a.name.toLowerCase().includes(s)));
}

function awsEvidence(profile: ProjectProfile | undefined, service: string): string | null {
  if (!profile) return null;
  const hit = profile.awsUsage.find((a) => a.name.toLowerCase().includes(service.toLowerCase()));
  return hit ? hit.evidence : null;
}

function dbEvidence(profile: ProjectProfile | undefined, db: string): string | null {
  if (!profile) return null;
  const hit = profile.databases.find((d) => d.name.toLowerCase().includes(db.toLowerCase()));
  return hit ? hit.evidence : null;
}

function infraEvidence(profile: ProjectProfile | undefined, name: string): string | null {
  if (!profile) return null;
  const hit = profile.infrastructure.find((i) => i.name.toLowerCase().includes(name.toLowerCase()));
  return hit ? hit.evidence : null;
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

function detectServices(
  combined: string,
  fileNames: string[],
  profile?: ProjectProfile
): DetectedService[] {
  const detected: DetectedService[] = [];
  const lower = combined.toLowerCase();
  const fileHas = (re: RegExp) => fileNames.some((f) => re.test(f));

  const hasDocker = Boolean(
    infraEvidence(profile, "docker") ||
    infraEvidence(profile, "dockerfile") ||
    infraEvidence(profile, "docker-compose") ||
    fileHas(/Dockerfile/i) ||
    fileHas(/docker-compose/i)
  );

  const hasDbConnectionString = /(?:postgres|postgresql|mysql|mariadb):\/\/|DATABASE_URL|DB_HOST|DB_PASSWORD|POSTGRES_USER|MYSQL_DATABASE|RDS_ENDPOINT/i.test(combined);
  const hasRedisConnectionString = /(?:redis|rediss):\/\/|REDIS_URL|REDIS_HOST|REDIS_PORT|CACHE_HOST/i.test(combined);

  const add = (
    serviceId: ServiceId,
    confidence: ConfidenceTier,
    evidence: string,
    category?: MappingCategory
  ) => {
    const existing = detected.find((d) => d.serviceId === serviceId);
    if (existing) {
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
        existing.confidence = confidence;
      }
      if (category && (!existing.category || CATEGORY_RANK[category] > CATEGORY_RANK[existing.category])) {
        existing.category = category;
      }
      if (!existing.evidence.includes(evidence)) {
        existing.evidence = `${existing.evidence}; ${evidence}`.slice(0, 200);
      }
      return;
    }

    const defaultCategory: MappingCategory =
      category ?? (confidence === "high" ? "repository-evidence" : "inference");

    detected.push({
      serviceId,
      confidence,
      evidence: evidence.slice(0, 200),
      category: defaultCategory,
    });
  };

  // --- Compute ---
  const lambdaEv = awsEvidence(profile, "lambda");
  const hasLambdaHandler = hasAny(combined, ["aws lambda", "lambda function", "handler.js", "handler.ts", "handler.py", "aws-lambda", "lambda_function.py"]);
  if (lambdaEv) add("Lambda", "high", `AWS SDK Lambda client imported — ${lambdaEv}`);
  else if (hasLambdaHandler || hasAny(combined, ["aws::lambda::function", "aws::serverless::function", "aws_lambda_function"])) {
    add("Lambda", "high", "Lambda handler or function definition in repository files");
  }

  const dockerfileEv = infraEvidence(profile, "dockerfile") || infraEvidence(profile, "docker");
  if (dockerfileEv || hasDocker || hasWord(combined, ["fargate", "ecs", "ecr"])) {
    const fargateEv = awsEvidence(profile, "fargate");
    if (fargateEv || hasAny(combined, ["fargate", "aws_ecs_task_definition", "aws::ecs::taskdefinition"])) {
      add("Fargate", "high", fargateEv ? `ECS Fargate SDK usage — ${fargateEv}` : "Fargate reference in repository files");
    } else if (awsEvidence(profile, "ecs") || hasAny(combined, ["elastic container service", "aws_ecs_cluster", "aws::ecs::cluster"]) || hasWord(combined, ["ecs"])) {
      add("ECS", "high", awsEvidence(profile, "ecs") ? `ECS SDK usage — ${awsEvidence(profile, "ecs")}` : "ECS reference in repository files");
    } else if (dockerfileEv || hasDocker) {
      add("ECS", "medium", "Dockerfile/container config present → ECS as standard container host on AWS");
    }
  }

  const ec2Ev = awsEvidence(profile, "ec2");
  if (ec2Ev) add("EC2", "high", `EC2 SDK client imported — ${ec2Ev}`);
  else if (hasAny(combined, ["ec2 instance", "elastic compute cloud", "aws_instance", "aws::ec2::instance"]) || hasWord(combined, ["ami"]) || /t2\.micro|t3\.micro|t3\.small|t3\.medium/i.test(combined)) {
    add("EC2", "high", "EC2 instance reference in repository files");
  }

  const k8sEv = infraEvidence(profile, "kubernetes");
  if (k8sEv || hasAny(combined, ["kubernetes", "k8s", "kubectl", "aws_eks_cluster", "aws::eks::cluster"]) || hasWord(combined, ["eks"])) {
    add("EKS", "high", k8sEv ? `Kubernetes manifests detected — ${k8sEv}` : "EKS/Kubernetes reference in repository files");
  }

  if (hasAny(combined, ["elastic container registry", "ecr.aws", "aws_ecr_repository", "aws::ecr::repository"]) || hasWord(combined, ["ecr"])) {
    add("ECR", "high", "ECR reference detected");
  } else if ((detected.some((s) => s.serviceId === "ECS" || s.serviceId === "EKS")) && (dockerfileEv || k8sEv || infraEvidence(profile, "kubernetes") || infraEvidence(profile, "github actions") || infraEvidence(profile, "codebuild"))) {
    add("ECR", "medium", "Container deployment on AWS (ECS/EKS) → ECR for container image storage");
  }

  // --- Storage ---
  const s3Ev = awsEvidence(profile, "s3");
  if (s3Ev) add("S3", "high", `AWS S3 SDK client imported — ${s3Ev}`);
  else if (hasAny(combined, ["s3 bucket", "aws s3", "s3.amazonaws", "s3://", "aws_s3_bucket", "aws::s3::bucket"]) || hasWord(combined, ["s3"])) {
    add("S3", "high", "S3 bucket reference in repository files");
  }

  // DynamoDB
  const dynamoEv = awsEvidence(profile, "dynamodb");
  if (dynamoEv) add("DynamoDB", "high", `DynamoDB SDK client imported — ${dynamoEv}`);
  else if (hasAny(combined, ["dynamodb", "dynamo db", "aws_dynamodb_table", "aws::dynamodb::table", "aws::serverless::simpletable"])) {
    add("DynamoDB", "high", "DynamoDB reference in repository files");
  }

  // --- Database (RDS / Aurora / ElastiCache) ---
  const rdsSdkEv = awsEvidence(profile, "rds");
  const postgresEv = dbEvidence(profile, "postgresql") || dbEvidence(profile, "postgres");
  const mysqlEv = dbEvidence(profile, "mysql") || dbEvidence(profile, "mariadb");
  const auroraEv = awsEvidence(profile, "aurora") || (hasAny(combined, ["aurora"]) ? "aurora reference detected" : null);

  if (auroraEv) {
    add("Aurora", "high", typeof auroraEv === "string" ? auroraEv : "Aurora reference in repository files");
  } else if (rdsSdkEv || hasAny(combined, ["aws::rds::dbinstance", "aws_db_instance"])) {
    add("RDS", "high", rdsSdkEv ? `RDS SDK client imported — ${rdsSdkEv}` : "Explicit RDS declaration in IaC/config");
  } else if (postgresEv || mysqlEv || hasAny(combined, ["mysql", "postgres", "postgresql", "mariadb", "sql server", "sqlserver", "mssql"])) {
    const weakLabel = postgresEv ? `PostgreSQL (${postgresEv})` : mysqlEv ? `MySQL/MariaDB (${mysqlEv})` : "Relational database";
    const hasOrm = hasAny(combined, [
      "prisma", "typeorm", "sequelize", "sqlalchemy", "knex", "hibernate",
      "django.db", "diesel", "gorm", "sqlx", "entityframework", "efcore",
      "activerecord", "active_record", "eloquent", "spring-data", "rails"
    ]);
    if (hasDbConnectionString || hasOrm) {
      const corroboration = hasDbConnectionString
        ? "corroborated by database connection configuration"
        : "corroborated by relational ORM configuration";
      add("RDS", "medium", `${weakLabel} dependency detected — ${corroboration} → RDS`);
    } else if (!hasDocker) {
      add("RDS", "low", `${weakLabel} reference detected without connection configuration — suggested RDS`);
    }
  }

  // ElastiCache / Redis
  const elastiCacheSdkEv = awsEvidence(profile, "elasticache");
  const redisEv = dbEvidence(profile, "redis") || (hasAny(combined, ["redis", "ioredis", "memcached", "predis"]) ? "redis keyword" : null);
  if (elastiCacheSdkEv || hasAny(combined, ["aws::elasticache::cachecluster", "aws_elasticache_cluster"])) {
    add("ElastiCache", "high", elastiCacheSdkEv ? `ElastiCache SDK imported — ${elastiCacheSdkEv}` : "Explicit ElastiCache declaration in IaC");
  } else if (redisEv) {
    const hasRedisWorkload = hasRedisConnectionString || hasAny(combined, ["sidekiq", "celery", "bull", "cache", "session"]);
    if (hasRedisWorkload) {
      add("ElastiCache", "medium", `Redis dependency detected — corroborated by caching/worker configuration → ElastiCache Redis`);
    } else if (!hasDocker) {
      add("ElastiCache", "low", "Redis reference detected without connection config — suggested ElastiCache");
    }
  }

  // --- Networking ---
  const apigwEv = awsEvidence(profile, "api gateway") || awsEvidence(profile, "apigateway");
  if (apigwEv) add("APIGateway", "high", `API Gateway SDK usage — ${apigwEv}`, "repository-evidence");
  else if (hasAny(combined, ["api gateway", "apigateway", "aws_api_gateway", "aws::apigateway::restapi", "httpapi"])) {
    add("APIGateway", "high", "API Gateway reference in repository files", "repository-evidence");
  }

  if (hasAny(combined, ["cloudfront", "aws_cloudfront_distribution", "aws::cloudfront::distribution"]) || hasWord(combined, ["cdn"])) {
    add("CloudFront", "high", "CloudFront/CDN reference in repository files");
  }

  if (hasAny(combined, ["application load balancer", "load balancer", "aws_lb", "aws::elasticloadbalancingv2::loadbalancer", "kind: ingress", "ingress.yaml", "ingress.yml"]) || hasWord(combined, ["alb", "elb"])) {
    add("ALB", "medium", "Load balancer / Ingress reference in repository files");
  } else if (profile && profileHasInfra(profile, "docker") && !hasAny(combined, ["serverless", "lambda"])) {
    add("ALB", "low", "Containerised app pattern — ALB typically fronts ECS services");
  }

  if (hasAny(combined, ["route 53", "route53", "hosted zone", "aws_route53_zone", "aws::route53::hostedzone"]) || hasWord(combined, ["dns"])) {
    add("Route53", "medium", "Route53/DNS reference in repository files");
  }

  // --- Messaging ---
  const kafkaEv = awsEvidence(profile, "msk") || (hasAny(combined, ["kafka", "confluent", "spring-kafka"]) ? "Apache Kafka event streaming detected" : null);
  if (kafkaEv) {
    add("MSK", "high", typeof kafkaEv === "string" ? kafkaEv : "Kafka reference in repository files");
  }

  const sqsEv = awsEvidence(profile, "sqs");
  if (sqsEv) add("SQS", "high", `SQS SDK client imported — ${sqsEv}`);
  else if (hasAny(combined, ["simple queue", "aws sqs", "aws_sqs_queue", "aws::sqs::queue"]) || hasWord(combined, ["sqs"])) {
    add("SQS", "high", "SQS reference in repository files");
  } else if (profile && (profileHasFramework(profile, "celery") || profileHasFramework(profile, "bull"))) {
    const workerEv = profile.frameworks.find((f) => /celery|bull/i.test(f.name));
    if (hasDocker || hasAny(combined, ["worker", "queue"])) {
      add("SQS", "medium", `Task queue library detected (${workerEv?.evidence}) → SQS as backing queue on AWS`);
    } else {
      add("SQS", "low", `Task queue library detected (${workerEv?.evidence}) — suggested SQS`);
    }
  }

  const snsEv = awsEvidence(profile, "sns");
  if (snsEv) add("SNS", "high", `SNS SDK client imported — ${snsEv}`);
  else if (hasAny(combined, ["simple notification", "aws sns", "aws_sns_topic", "aws::sns::topic"]) || hasWord(combined, ["sns"])) {
    add("SNS", "high", "SNS reference in repository files");
  }

  const ebEv = awsEvidence(profile, "eventbridge");
  if (ebEv) add("EventBridge", "high", `EventBridge SDK client imported — ${ebEv}`);
  else if (hasAny(combined, ["eventbridge", "event bus", "aws_cloudwatch_event_rule", "aws::events::rule"])) {
    add("EventBridge", "high", "EventBridge reference in repository files");
  }

  const kinesisEv = awsEvidence(profile, "kinesis");
  if (kinesisEv) add("Kinesis", "high", `Kinesis SDK client imported — ${kinesisEv}`);
  else if (hasAny(combined, ["kinesis", "kinesis stream", "kinesis firehose", "aws_kinesis_stream", "aws::kinesis::stream"])) {
    add("Kinesis", "high", "Kinesis reference in repository files");
  }

  // --- Search ---
  const searchEv = awsEvidence(profile, "opensearch") || (hasAny(combined, ["opensearch", "elasticsearch"]) ? "OpenSearch/Elasticsearch search engine detected" : null);
  if (searchEv) {
    add("OpenSearch", "high", typeof searchEv === "string" ? searchEv : "OpenSearch reference in repository files");
  }

  // --- Auth ---
  const cognitoEv = awsEvidence(profile, "cognito");
  if (cognitoEv) add("Cognito", "high", `Cognito SDK client imported — ${cognitoEv}`);
  else if (hasAny(combined, ["cognito", "user pool", "identity pool", "aws_cognito_user_pool", "aws::cognito::userpool"])) {
    add("Cognito", "high", "Cognito reference in repository files");
  } else if (hasAny(combined, ["keycloak"])) {
    add("Cognito", "medium", "Managed service substitution: Keycloak identity provider → Amazon Cognito");
  }

  // --- ML ---
  if (profile?.workloadClassification?.type === "ml-inference") {
    add("SageMaker", "high", "Machine learning inference endpoint detected → Amazon SageMaker Endpoint");
    if (!detected.some((s) => s.serviceId === "ALB")) {
      add("ALB", "medium", "Load balancer for inference API traffic → ALB");
    }
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Model weights and serialized artifact storage → S3");
    }
  } else if (profile?.workloadClassification?.type === "ml-training" || hasAny(combined, ["tensorflow", "pytorch", "keras", "model training", "training job", "train.py"]) || hasWord(combined, ["cnn"])) {
    add("SageMaker", "high", "Machine learning model training detected → Amazon SageMaker");
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Dataset and model artifact storage → S3");
    }
  } else if (hasAny(combined, ["sagemaker", "training job", "inference endpoint", "aws_sagemaker_model"])) {
    add("SageMaker", "high", "SageMaker reference in repository files");
  }
  if (hasAny(combined, ["rekognition"])) add("Rekognition", "high", "Rekognition reference in repository files");
  if (hasAny(combined, ["comprehend"])) add("Comprehend", "high", "Comprehend reference in repository files");

  const bedrockEv = awsEvidence(profile, "bedrock");
  if (bedrockEv) add("Bedrock", "high", `AWS Bedrock client imported — ${bedrockEv}`);
  else if (hasAny(combined, ["bedrock", "aws-bedrock", "aws::bedrock", "bedrock-runtime"])) {
    add("Bedrock", "high", "Amazon Bedrock foundation model reference detected");
  }

  // --- Analytics & ETL ---
  const athenaEv = awsEvidence(profile, "athena");
  if (athenaEv) add("Athena", "high", `AWS Athena client imported — ${athenaEv}`);
  else if (hasAny(combined, ["athena", "aws-athena", "aws::athena", "aws_athena"])) {
    add("Athena", "high", "Amazon Athena serverless analytics query engine reference detected");
  }

  const glueEv = awsEvidence(profile, "glue");
  if (glueEv) add("Glue", "high", `AWS Glue client imported — ${glueEv}`);
  else if (hasAny(combined, ["aws glue", "glue job", "glue etl", "aws_glue", "aws::glue::job"]) || hasWord(combined, ["glue"])) {
    add("Glue", "high", "AWS Glue ETL service reference detected in repository files");
  }

  const emrEv = awsEvidence(profile, "emr");
  if (emrEv) add("EMR", "high", `AWS EMR client imported — ${emrEv}`);
  else if (hasAny(combined, ["elastic mapreduce", "aws::emr", "aws_emr_cluster", "pyspark"]) || hasWord(combined, ["emr"])) {
    add("EMR", "high", "Amazon EMR cluster reference detected in repository files");
  }

  // --- Step Functions ---
  const sfnEv = awsEvidence(profile, "stepfunctions") || awsEvidence(profile, "states");
  if (sfnEv) add("StepFunctions", "high", `AWS Step Functions client imported — ${sfnEv}`);
  else if (hasAny(combined, ["step functions", "stepfunctions", "aws-stepfunctions", "aws::stepfunctions", "states:::"])) {
    add("StepFunctions", "high", "AWS Step Functions state machine workflow reference detected");
  }

  // --- Security & Encryption ---
  const kmsEv = awsEvidence(profile, "kms");
  if (kmsEv) add("KMS", "high", `AWS KMS client imported — ${kmsEv}`);
  else if (hasAny(combined, ["aws-kms", "aws_kms_key", "aws::kms::key", "kms:encrypt", "kms:decrypt"]) || hasWord(combined, ["kms"])) {
    add("KMS", "high", "AWS Key Management Service (KMS) reference detected");
  }

  // --- App Runner ---
  const apprunnerEv = awsEvidence(profile, "apprunner");
  if (apprunnerEv) add("AppRunner", "high", `AWS App Runner client imported — ${apprunnerEv}`);
  else if (hasAny(combined, ["app runner", "apprunner", "aws_apprunner", "aws::apprunner"])) {
    add("AppRunner", "high", "AWS App Runner container service reference detected");
  }

  // --- Static site / frontend hosting ---
  const isStaticSite =
    hasAny(combined, ["static site", "static website", "gatsby", "hugo", "jekyll", "astro"]) ||
    fileHas(/vercel\.json|netlify\.toml|amplify\.yml/i) ||
    (hasAny(combined, ["vite", "static"]) && !hasAny(combined, ["express", "fastify", "koa", "nestjs", "django", "flask", "spring", "docker", "serverless"]));

  if (isStaticSite) {
    if (!detected.some((s) => s.serviceId === "S3")) {
      add("S3", "medium", "Static site generator or hosting config present → S3 for static hosting");
    }
    if (!detected.some((s) => s.serviceId === "CloudFront")) {
      add("CloudFront", "medium", "Static site generator or hosting config present → CloudFront CDN in front of S3");
    }
    if (!detected.some((s) => s.serviceId === "Route53")) {
      add("Route53", "medium", "DNS routing for custom domain → Route 53");
    }
  }

  // --- Serverless Framework / SAM files ---
  const hasServerlessFile = fileHas(/serverless\.(yml|yaml)/i) || fileHas(/(template|sam)\.(yml|yaml)/i);
  if (hasServerlessFile) {
    if (!detected.some((s) => s.serviceId === "Lambda")) {
      add("Lambda", "high", "Serverless framework / SAM template in repository files");
    }
    if (!detected.some((s) => s.serviceId === "APIGateway")) {
      add("APIGateway", "high", "Serverless API entry point");
    }
  }

  // --- Discovered components from repoAnalyzer (structural evidence) ---
  if (profile?.discoveredComponents?.length) {
    for (const dc of profile.discoveredComponents) {
      const dcEv = `${dc.source}: ${dc.evidence[0] ?? dc.name} (${dc.confidence} confidence)`;
      switch (dc.type) {
        case "database": {
          const tech = dc.technology.toLowerCase();
          if (/dynamo/.test(tech)) { if (!detected.some((s) => s.serviceId === "DynamoDB")) add("DynamoDB", dc.confidence, dcEv); }
          else if (/mongo/.test(tech)) { if (!detected.some((s) => s.serviceId === "DocumentDB")) add("DocumentDB", dc.confidence, dcEv); }
          else if (/aurora/.test(tech)) { if (!detected.some((s) => s.serviceId === "Aurora")) add("Aurora", dc.confidence, dcEv); }
          else if (/athena/.test(tech)) { if (!detected.some((s) => s.serviceId === "Athena")) add("Athena", dc.confidence, dcEv); }
          else { if (!detected.some((s) => s.serviceId === "RDS" || s.serviceId === "Aurora")) add("RDS", dc.confidence, dcEv); }
          break;
        }
        case "cache": { if (!detected.some((s) => s.serviceId === "ElastiCache")) add("ElastiCache", dc.confidence, dcEv); break; }
        case "queue": {
          const tech = dc.technology.toLowerCase();
          if (/kafka|confluent/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "MSK")) add("MSK", dc.confidence, dcEv);
          } else {
            if (!detected.some((s) => s.serviceId === "SQS")) add("SQS", dc.confidence, dcEv);
          }
          break;
        }
        case "messaging": {
          const tech = dc.technology.toLowerCase();
          if (/kafka|confluent/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "MSK")) add("MSK", dc.confidence, dcEv);
          } else if (/kinesis/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "Kinesis")) add("Kinesis", dc.confidence, dcEv);
          } else if (/sns/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "SNS")) add("SNS", dc.confidence, dcEv);
          } else if (/step.?function/.test(tech)) {
            if (!detected.some((s) => s.serviceId === "StepFunctions")) add("StepFunctions", dc.confidence, dcEv);
          } else {
            if (!detected.some((s) => s.serviceId === "SQS")) add("SQS", dc.confidence, dcEv);
          }
          break;
        }
        case "search": {
          if (!detected.some((s) => s.serviceId === "OpenSearch")) add("OpenSearch", dc.confidence, dcEv);
          break;
        }
        case "api": {
          if (dc.source === "serverless-yml" && !detected.some((s) => s.serviceId === "Lambda")) {
            add("Lambda", dc.confidence, dcEv, "deployment-requirement");
          }
          if (dc.source === "serverless-yml" || /serverless|lambda/.test(dc.technology.toLowerCase())) {
            if (!detected.some((s) => s.serviceId === "APIGateway")) {
              add("APIGateway", dc.confidence, `${dcEv} → Serverless HTTP entry`, "deployment-requirement");
            }
          } else if (/apigateway|api gateway|httpapi|aws_api_gateway/.test(dc.technology.toLowerCase())) {
            if (!detected.some((s) => s.serviceId === "APIGateway")) {
              add("APIGateway", dc.confidence, dcEv, "repository-evidence");
            }
          } else {
            // Framework or generic API alone does not prove APIGateway. Recommend ALB for ingress.
            if (!detected.some((s) => s.serviceId === "ALB")) {
              add("ALB", "medium", `${dcEv} → Ingress load balancer recommendation`, "recommendation");
            }
            if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Lambda")) {
              add("ECS", "low", `${dcEv} → possible container host, no container evidence`, "inference");
            }
          }
          break;
        }
        case "backend": {
          const tech = dc.technology.toLowerCase();
          if (/bedrock/.test(tech)) { if (!detected.some((s) => s.serviceId === "Bedrock")) add("Bedrock", dc.confidence, dcEv); }
          else if (/app.?runner/.test(tech)) { if (!detected.some((s) => s.serviceId === "AppRunner")) add("AppRunner", dc.confidence, dcEv); }
          break;
        }
        case "worker": {
          const tech = dc.technology.toLowerCase();
          if (dc.source === "serverless-yml") { if (!detected.some((s) => s.serviceId === "Lambda")) add("Lambda", dc.confidence, dcEv); }
          else if (/glue/.test(tech)) { if (!detected.some((s) => s.serviceId === "Glue")) add("Glue", dc.confidence, dcEv); }
          else if (/emr|spark/.test(tech)) { if (!detected.some((s) => s.serviceId === "EMR")) add("EMR", dc.confidence, dcEv); }
          else if (/step.?function/.test(tech)) { if (!detected.some((s) => s.serviceId === "StepFunctions")) add("StepFunctions", dc.confidence, dcEv); }
          else if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Fargate") && !detected.some((s) => s.serviceId === "Lambda")) {
            add("ECS", dc.confidence, dcEv);
          }
          break;
        }
        case "scheduler": {
          if (dc.source === "serverless-yml") { if (!detected.some((s) => s.serviceId === "Lambda")) add("Lambda", dc.confidence, dcEv); }
          else if (!detected.some((s) => s.serviceId === "ECS") && !detected.some((s) => s.serviceId === "Fargate") && !detected.some((s) => s.serviceId === "Lambda")) {
            add("ECS", dc.confidence, dcEv);
          }
          if (!detected.some((s) => s.serviceId === "EventBridge")) add("EventBridge", dc.confidence, dcEv);
          break;
        }
        case "storage": { if (!detected.some((s) => s.serviceId === "S3")) add("S3", dc.confidence, dcEv); break; }
        case "auth": {
          const tech = dc.technology.toLowerCase();
          if (/kms/.test(tech)) { if (!detected.some((s) => s.serviceId === "KMS")) add("KMS", dc.confidence, dcEv); }
          else { if (!detected.some((s) => s.serviceId === "Cognito")) add("Cognito", dc.confidence, dcEv); }
          break;
        }
        case "frontend": { if (!detected.some((s) => s.serviceId === "CloudFront")) add("CloudFront", "medium", `${dcEv} → CloudFront CDN`, "deployment-requirement"); break; }
      }
    }
  }

  // --- Observability (gated behind active compute) ---
  const COMPUTE_SERVICES: ServiceId[] = ["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "SageMaker"];
  const hasActiveCompute = detected.some((s) => COMPUTE_SERVICES.includes(s.serviceId));
  if (hasActiveCompute && !detected.some((s) => s.serviceId === "CloudWatch")) {
    add("CloudWatch", "medium", "CloudWatch monitoring for active compute services", "recommendation");
  }

  return detected;
}

// ---------------------------------------------------------------------------
// Pattern classifier
// ---------------------------------------------------------------------------

export function classifyPattern(services: DetectedService[]): PatternId {
  if (!services || services.length === 0) return "generic";

  const has = (id: ServiceId) => services.some((s) => s.serviceId === id);
  const hasAnyId = (ids: ServiceId[]) => services.some((s) => ids.includes(s.serviceId));
  const hasEvidence = (re: RegExp) => services.some((s) => re.test(s.evidence));

  // 1. ML Pipeline (highest specificity — SageMaker, Rekognition, Comprehend)
  if (hasAnyId(["SageMaker", "Rekognition", "Comprehend"]) || hasEvidence(/sagemaker|machine learning|ml model/i)) {
    return "ml-pipeline";
  }

  // 2. Data Pipeline (ETL / Warehouse / Kinesis + S3)
  if (
    has("Redshift") ||
    (has("Kinesis") && has("S3")) ||
    hasEvidence(/data pipeline|etl|data warehouse|glue|athena/i)
  ) {
    return "data-pipeline";
  }

  // 3. Containerised App (ECS, Fargate, EKS, ECR)
  const hasContainers = hasAnyId(["ECS", "Fargate", "EKS", "ECR"]) || hasEvidence(/docker|container|fargate|ecs|eks/i);
  if (hasContainers) {
    return "containerised-app";
  }

  // 4. Serverless API (SAM / serverless.yml / Lambda without container orchestrators)
  if (has("Lambda") || hasEvidence(/serverless|sam|template\.yaml|aws-lambda/i)) {
    return "serverless-api";
  }

  // 5. Event-Driven (Messaging / Queues without compute)
  if (hasAnyId(["SQS", "SNS", "EventBridge", "Kinesis"])) {
    return "event-driven";
  }

  // 6. Full-Stack Web (Compute + Relational Database)
  if ((has("EC2") || has("ALB")) && (has("RDS") || has("Aurora"))) {
    return "full-stack-web";
  }

  // 6. Static Site (S3 + CloudFront / CDN without compute or databases)
  const hasCompute = hasAnyId(["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "SageMaker"]);
  const hasDatabase = hasAnyId(["RDS", "Aurora", "DynamoDB", "Redshift", "DocumentDB"]);
  const hasMessaging = hasAnyId(["SQS", "SNS", "EventBridge", "Kinesis"]);

  if (!hasCompute && !hasDatabase && !hasMessaging) {
    if ((has("S3") && has("CloudFront")) || hasEvidence(/static site|static asset|s3 for hosting|cloudfront cdn/i)) {
      return "static-site";
    }
  }

  return "generic";
}

// ---------------------------------------------------------------------------
// Build ServicePlan from detected services (no pattern constraints)
// ---------------------------------------------------------------------------

export function buildServicePlan(
  input: RuleInput,
  services: DetectedService[]
): ServicePlan {
  // Retain all detected services (hard 12-cap removed; soft ceiling handled by schema warnings)
  const planServices = services;

  // Convert detected services to DiscoveredComponent format
  const components: DiscoveredComponent[] = planServices.map((s) => ({
    id: `svc-${s.serviceId.toLowerCase()}`,
    type: serviceTypeFromId(s.serviceId),
    technology: s.serviceId,
    evidence: [s.evidence],
    confidence: s.confidence,
    status: s.confidence === "high" ? "detected" : "inferred",
  }));

  // Build basic relationships (compute → database, compute → cache, etc.)
  const relationships: ComponentRelationship[] = buildBasicRelationships(components);

  // Build deployment model (inferred)
  const deploymentModel: DeploymentModel[] = components.map((c) => {
    const isCompute = ["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail", "AppRunner", "ElasticBeanstalk"].includes(c.technology);
    const isDatabase = c.type === "database";
    const isCache = c.type === "cache";

    return {
      componentId: c.id,
      public: c.type === "frontend" || c.type === "api",
      needsVpc: isCompute || isDatabase || isCache,
      needsMultiAz: isDatabase || isCache,
      needsAutoscaling: isCompute && ["ECS", "EC2", "EKS", "AppRunner"].includes(c.technology),
      source: "recommended" as const,
      notes: isDatabase ? "Production DB → recommend Multi-AZ" : undefined,
    };
  });

  // Build AWS mappings (1:1 with components)
  const rawAwsMappings: AwsServiceMapping[] = planServices.map((s) => ({
    componentId: `svc-${s.serviceId.toLowerCase()}`,
    serviceId: s.serviceId,
    confidence: s.confidence,
    evidence: s.evidence,
    fromPattern: false,
    category: s.category ?? (s.confidence === "high" ? "repository-evidence" : "inference"),
  }));
  const awsMappings = deduplicateAwsMappings(rawAwsMappings);

  const plan = {
    inputKind: input.inputKind,
    components,
    relationships,
    deploymentModel,
    awsMappings,
    detectedPattern: classifyPattern(services),
    metadata: {
      grounding: input.grounding,
      truncated: input.truncated,
      parseErrors: input.parseErrors,
    },
    warnings: [],
  };

  const check = ServicePlanSchema.safeParse(plan);
  if (!check.success) {
    console.warn("[ruleEngine] plan failed validation:", check.error.issues.map((i) => i.message).join("; "));
    const floor: ServicePlan = {
      inputKind: input.inputKind,
      components: [{ id: "fallback", type: "object-storage", technology: "S3", evidence: [], confidence: "low", status: "inferred" }],
      relationships: [],
      deploymentModel: [],
      awsMappings: [{ componentId: "fallback", serviceId: "S3", confidence: "low", evidence: "fallback", fromPattern: false }],
      detectedPattern: "generic",
      metadata: { grounding: input.grounding, truncated: input.truncated, parseErrors: [...input.parseErrors, "rule-engine-validation-failed"] },
      warnings: ["Rule engine output failed validation — showing minimal S3 placeholder, not an inference."],
    };
    return floor;
  }

  return check.data;
}

const buildPlan = buildServicePlan;

export function serviceTypeFromId(serviceId: ServiceId): DiscoveredComponent["type"] {
  const map: Partial<Record<ServiceId, DiscoveredComponent["type"]>> = {
    EC2: "backend", Lambda: "backend", ECS: "backend", EKS: "backend", Fargate: "backend", Lightsail: "backend", Batch: "worker",
    AppRunner: "backend", ElasticBeanstalk: "backend", Outposts: "backend", Wavelength: "backend", LocalZones: "backend",
    ServerlessApplicationRepository: "backend", EC2ImageBuilder: "worker", SimSpaceWeaver: "backend",
    S3: "object-storage", EBS: "object-storage", EFS: "object-storage", Glacier: "object-storage", FSx: "object-storage",
    StorageGateway: "object-storage", Backup: "object-storage", Snowball: "object-storage", Snowcone: "object-storage",
    S3GlacierDeepArchive: "object-storage",
    RDS: "database", DynamoDB: "database", ElastiCache: "cache", Aurora: "database", Redshift: "database", DocumentDB: "database",
    Neptune: "database", Keyspaces: "database", Timestream: "database", MemoryDB: "cache", QLDB: "database",
    CloudFront: "frontend", APIGateway: "api", ALB: "api", NLB: "api", GLB: "api", Route53: "api", VPC: "proxy", NATGateway: "proxy",
    DirectConnect: "proxy", TransitGateway: "proxy", GlobalAccelerator: "proxy", PrivateLink: "proxy", AppMesh: "proxy",
    CloudMap: "proxy", VPCEndpoints: "proxy", SiteToSiteVPN: "proxy", ClientVPN: "proxy",
    SQS: "queue", SNS: "messaging", EventBridge: "messaging", Kinesis: "messaging", KinesisDataFirehose: "messaging",
    KinesisDataStreams: "messaging", KinesisDataAnalytics: "messaging", MSK: "messaging", MQ: "messaging", AppSync: "api",
    StepFunctions: "worker", ManagedAirflow: "worker", EventBridgePipes: "messaging", EventBridgeScheduler: "scheduler",
    Cognito: "auth", SecretsManager: "auth", WAF: "proxy", Shield: "proxy", IAM: "auth", KMS: "auth", GuardDuty: "proxy",
    Inspector: "proxy", Macie: "proxy", SecurityHub: "proxy", CertificateManager: "proxy", DirectoryService: "auth",
    IAMIdentityCenter: "auth", NetworkFirewall: "proxy", Artifact: "proxy", AuditManager: "proxy", Detective: "proxy",
    CloudHSM: "auth", SystemsManager: "proxy", ParameterStore: "auth",
    CloudWatch: "proxy", CloudWatchLogs: "proxy", CloudWatchSynthetics: "proxy", CloudWatchEvidently: "proxy",
    CloudWatchRUM: "proxy", CloudTrail: "proxy", XRay: "proxy", Config: "proxy", ServiceCatalog: "proxy",
    ComputeOptimizer: "proxy", TrustedAdvisor: "proxy", HealthDashboard: "proxy", Organizations: "proxy",
    ControlTower: "proxy", LicenseManager: "proxy", WellArchitectedTool: "proxy",
    CodePipeline: "proxy", CodeBuild: "worker", CodeDeploy: "worker", CodeCommit: "proxy", CodeArtifact: "proxy",
    CodeCatalyst: "proxy", CloudFormation: "proxy", CDK: "proxy", ECR: "proxy", Cloud9: "backend",
    FaultInjectionSimulator: "proxy",
    SageMaker: "backend", Rekognition: "backend", Comprehend: "backend", Transcribe: "backend", Translate: "backend",
    Polly: "backend", Textract: "backend", Kendra: "search", Lex: "backend", Personalize: "backend", Forecast: "backend",
    Bedrock: "backend", Q: "backend", CodeWhisperer: "backend",
    OpenSearch: "search", EMR: "worker", Athena: "database", Glue: "worker", QuickSight: "frontend",
    LakeFormation: "database", DataPipeline: "worker", CleanRooms: "database", MSKConnect: "messaging",
    SES: "messaging", Amplify: "frontend", AppFlow: "proxy", DeviceFarm: "worker", LocationService: "proxy",
    Pinpoint: "messaging", Connect: "backend", WorkSpaces: "backend", AppStream: "backend",
    DMS: "worker", DataSync: "worker", TransferFamily: "proxy", ApplicationDiscoveryService: "proxy", MigrationHub: "proxy",
    IoTCore: "messaging", Greengrass: "backend", IoTEvents: "messaging", IoTAnalytics: "messaging",
  };
  return map[serviceId] ?? "external-service";
}

function buildBasicRelationships(components: DiscoveredComponent[]): ComponentRelationship[] {
  const relationships: ComponentRelationship[] = [];
  const computeComponents = components.filter((c) => ["backend", "worker", "scheduler", "api"].includes(c.type));
  const dbComponents = components.filter((c) => c.type === "database");
  const cacheComponents = components.filter((c) => c.type === "cache");
  const queueComponents = components.filter((c) => c.type === "queue" || c.type === "messaging");
  const storageComponents = components.filter((c) => c.type === "object-storage");

  for (const compute of computeComponents) {
    for (const db of dbComponents) {
      relationships.push({ from: compute.id, to: db.id, type: "reads/writes", evidence: "compute → database" });
    }
    for (const cache of cacheComponents) {
      relationships.push({ from: compute.id, to: cache.id, type: "reads/writes", evidence: "compute → cache" });
    }
    for (const queue of queueComponents) {
      relationships.push({ from: compute.id, to: queue.id, type: "sends/receives", evidence: "compute → queue" });
    }
    for (const storage of storageComponents) {
      relationships.push({ from: compute.id, to: storage.id, type: "reads/writes", evidence: "compute → storage" });
    }
  }

  // Worker → queue
  for (const worker of components.filter((c) => c.type === "worker")) {
    for (const queue of queueComponents) {
      relationships.push({ from: worker.id, to: queue.id, type: "consumes", evidence: "worker → queue" });
    }
  }

  // Scheduler → compute
  for (const scheduler of components.filter((c) => c.type === "scheduler")) {
    for (const compute of computeComponents) {
      relationships.push({ from: scheduler.id, to: compute.id, type: "triggers", evidence: "scheduler → compute" });
    }
  }

  // Frontend → API
  for (const frontend of components.filter((c) => c.type === "frontend")) {
    for (const api of components.filter((c) => c.type === "api" || c.type === "backend")) {
      relationships.push({ from: frontend.id, to: api.id, type: "calls", evidence: "frontend → API" });
    }
  }

  return relationships.slice(0, 50);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Main exported functions
// ---------------------------------------------------------------------------

export function runRuleEngine(
  input: RuleInput,
  options: { returnArray: true }
): ServicePlan[];
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: false }
): ServicePlan;
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: boolean }
): ServicePlan | ServicePlan[];
export function runRuleEngine(
  input: RuleInput,
  options?: { returnArray?: boolean }
): ServicePlan | ServicePlan[] {
  const combined = [input.description, input.fileContent].join("\n");
  const services = detectServices(combined, input.fileNames, input.profile);
  const primaryPlan = buildPlan(input, services);

  // Check for curated alternate architecture pair
  const alternatePlan = buildAlternateProposal(primaryPlan, input);
  if (alternatePlan) {
    const p1 = { ...primaryPlan };
    delete p1.proposals;
    const p2 = { ...alternatePlan };
    delete p2.proposals;
    primaryPlan.proposals = [p1, p2];
    alternatePlan.proposals = [p1, p2];
  } else {
    const p1 = { ...primaryPlan };
    delete p1.proposals;
    primaryPlan.proposals = [p1];
  }

  if (options?.returnArray) {
    return primaryPlan.proposals;
  }

  return primaryPlan;
}

/**
 * Convenience helper returning all available proposals (1 or 2) as an array.
 */
export function runRuleEngineProposals(input: RuleInput): ServicePlan[] {
  const res = runRuleEngine(input, { returnArray: true });
  return Array.isArray(res) ? res : [res];
}