/**
 * ruleEngine.ts
 *
 * Deterministic keyword/signal-based rule engine that produces a ServicePlan
 * baseline without any LLM call or network access.
 *
 * Decision 3: Rules-first, LLM-enhances.
 * Decision 5: LLM failure silently degrades to rules baseline — this is that baseline.
 * Decision 15: Inference = LLM-based with rule-based keyword fallback.
 *
 * The rule engine NEVER fails. It always returns a valid ServicePlan (at minimum
 * the "generic" pattern with CloudWatch + S3 as the floor).
 *
 * Input is a `RuleInput` — a bag of signals that either the RepoFetcher (Stage 2)
 * or the freeform description path provides. When a `ProjectProfile` is attached
 * (repo path), scoring uses typed profile fields; keyword matching acts as fallback.
 */

import { ServicePlanSchema } from "./schema.ts";
import type { ServicePlan, PatternId, ConfidenceTier, Grounding } from "./schema.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// RuleInput — signals available to the rule engine.
// Stage 2 (RepoFetcher) will populate all fields from repo content.
// Freeform path populates only description.
// ---------------------------------------------------------------------------
export interface RuleInput {
  /** Freeform description text or README content */
  description: string;
  /** Concatenated content of all key files (for keyword matching fallback) */
  fileContent: string;
  /** List of key file names found in the repo (e.g. ["Dockerfile", "package.json"]) */
  fileNames: string[];
  /** Whether the input kind is a github URL or freeform description */
  inputKind: "github_url" | "description";
  /** Grounding — may differ from inputKind if repo fell back to description */
  grounding: Grounding;
  /** Metadata flags from the fetcher */
  truncated: boolean;
  parseErrors: string[];
  /**
   * Structured project profile from repoAnalyzer — populated on the github_url
   * path. When present, pattern scoring and service detection use typed profile
   * fields instead of raw keyword matching, producing file-specific evidence.
   */
  profile?: ProjectProfile;
}

// ---------------------------------------------------------------------------
// Internal scoring helpers
// ---------------------------------------------------------------------------

function hasAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

function countMatches(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase())).length;
}

// ---------------------------------------------------------------------------
// Pattern classifiers
// Each returns a score 0–N; highest score wins.
// ---------------------------------------------------------------------------

interface PatternScore {
  pattern: PatternId;
  score: number;
}

// ---------------------------------------------------------------------------
// Profile-aware scoring helpers
// When a ProjectProfile is available, these helpers use its typed fields
// instead of keyword-matching the raw text blob.
// ---------------------------------------------------------------------------

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

function scoreStaticSite(combined: string, fileNames: string[], profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    // Deployment hints: Vercel/Netlify/Amplify strongly indicate static site
    if (profile.deploymentHints.some((h) => /vercel|netlify|amplify/i.test(h.name))) score += 4;
    // Static-site generators / build tools
    if (profileHasFramework(profile, "gatsby", "hugo", "jekyll", "astro")) score += 3;
    if (profileHasFramework(profile, "vite") && !profileHasFramework(profile, "express", "fastify", "koa", "nestjs")) score += 2;
    // Pure frontend with no backend framework → static
    const hasFrontend = profileHasFramework(profile, "react", "vue", "angular", "svelte");
    const hasBackend = profileHasFramework(profile, "express", "fastapi", "django", "flask", "rails", "spring", "nestjs");
    if (hasFrontend && !hasBackend) score += 2;
    if (profileHasAwsUsage(profile, "s3", "cloudfront")) score += 3;
  } else {
    if (hasAny(combined, ["vercel.json", "netlify.toml", "amplify.yml"])) score += 4;
    if (hasAny(combined, ["static", "gatsby", "hugo", "jekyll", "next export", "vite", "astro"])) score += 2;
    if (fileNames.some((f) => /^(vercel|netlify)\.toml?/.test(f))) score += 3;
    if (hasAny(combined, ["s3 static", "cloudfront", "s3 website"])) score += 3;
    if (!hasAny(combined, ["server", "api", "backend", "express", "fastapi", "django", "rails"])) score += 1;
  }
  return score;
}

function scoreServerlessApi(combined: string, fileNames: string[], profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    if (profileHasInfra(profile, "serverless framework")) score += 5;
    if (profileHasInfra(profile, "aws sam")) score += 5;
    if (profileHasAwsUsage(profile, "lambda", "api gateway", "dynamodb")) score += 4;
    if (profileHasAwsUsage(profile, "sqs", "sns", "eventbridge")) score += 2;
  } else {
    if (fileNames.some((f) => /^serverless\.(yml|yaml)$/.test(f))) score += 5;
    if (hasAny(combined, ["aws-lambda", "lambda", "handler.js", "handler.ts", "handler.py"])) score += 3;
    if (hasAny(combined, ["api gateway", "apigateway", "aws_api_gateway", "httpapi"])) score += 3;
    if (hasAny(combined, ["dynamodb", "dynamo"])) score += 2;
    if (hasAny(combined, ["serverless framework", "sam template", "template.yaml"])) score += 4;
    if (fileNames.some((f) => /^template\.yaml$/.test(f))) score += 4;
  }
  return score;
}

function scoreContainerisedApp(combined: string, fileNames: string[], profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    if (profileHasInfra(profile, "docker")) score += 4;
    if (profileHasInfra(profile, "docker compose")) score += 3;
    if (profileHasInfra(profile, "kubernetes")) score += 5;
    if (profileHasAwsUsage(profile, "ecs", "fargate", "ecr", "eks")) score += 4;
  } else {
    if (fileNames.some((f) => /^Dockerfile$/i.test(f))) score += 4;
    if (fileNames.some((f) => /^docker-compose\.(yml|yaml)$/.test(f))) score += 3;
    if (hasAny(combined, ["ecs", "fargate", "ecr", "kubernetes", "k8s", "eks"])) score += 4;
    if (hasAny(combined, ["container", "image:", "FROM ", "ENTRYPOINT"])) score += 2;
    if (hasAny(combined, ["alb", "load balancer", "application load balancer"])) score += 2;
  }
  return score;
}

function scoreEventDriven(combined: string, profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    if (profileHasAwsUsage(profile, "sqs", "sns", "eventbridge", "kinesis")) score += 5;
    if (profileHasFramework(profile, "celery", "bull")) score += 3;
  } else {
    if (hasAny(combined, ["sqs", "sns", "eventbridge", "kinesis", "kafka"])) score += 4;
    if (hasAny(combined, ["event", "message queue", "pub/sub", "pubsub", "worker", "consumer", "producer"])) score += 2;
    if (hasAny(combined, ["async", "asynchronous", "background job", "celery", "bull"])) score += 2;
  }
  return score;
}

function scoreMlPipeline(combined: string, profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    if (profileHasFramework(profile, "tensorflow", "pytorch", "scikit", "huggingface", "transformers")) score += 4;
    if (profileHasAwsUsage(profile, "sagemaker", "rekognition", "comprehend")) score += 5;
    if (profileHasFramework(profile, "openai", "anthropic")) score += 2;
  } else {
    if (hasAny(combined, ["sagemaker", "machine learning", "ml model", "training job", "inference endpoint"])) score += 5;
    if (hasAny(combined, ["tensorflow", "pytorch", "scikit", "huggingface", "transformers", "jupyter"])) score += 3;
    if (hasAny(combined, ["rekognition", "comprehend", "bedrock", "llm", "embedding", "vector"])) score += 3;
    if (hasAny(combined, ["s3", "dataset", "pipeline", "batch"])) score += 1;
  }
  return score;
}

function scoreFullStackWeb(combined: string, fileNames: string[], profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    const hasFrontend = profileHasFramework(profile, "react", "vue", "angular", "svelte", "next.js", "nuxt", "remix");
    const hasBackend = profileHasFramework(profile, "express", "fastapi", "django", "flask", "rails", "spring", "nestjs", "koa", "fastify");
    if (hasFrontend && hasBackend) score += 6; // strongest signal — both tiers present
    else if (hasFrontend || hasBackend) score += 2;
    if (profileHasDatabase(profile, "postgresql", "mysql", "mongodb", "mariadb")) score += 2;
    if (profileHasDatabase(profile, "redis")) score += 1;
  } else {
    const hasFrontend = hasAny(combined, ["react", "vue", "angular", "svelte", "next.js", "nuxt", "remix"]);
    const hasBackend = hasAny(combined, ["express", "fastapi", "django", "rails", "spring", "laravel", "nest"]);
    if (hasFrontend && hasBackend) score += 5;
    if (hasFrontend || hasBackend) score += 2;
    if (hasAny(combined, ["rds", "postgres", "mysql", "mongodb", "database"])) score += 2;
    if (hasAny(combined, ["ec2", "elastic beanstalk", "beanstalk"])) score += 2;
    if (fileNames.some((f) => /^package\.json$/.test(f))) score += 1;
  }
  return score;
}

function scoreDataPipeline(combined: string, profile?: ProjectProfile): number {
  let score = 0;
  if (profile) {
    if (profileHasFramework(profile, "airflow", "dagster", "prefect", "dbt")) score += 4;
    if (profileHasAwsUsage(profile, "kinesis", "redshift")) score += 4;
    if (hasAny(combined, ["etl", "data warehouse", "data lake", "parquet"])) score += 2;
  } else {
    if (hasAny(combined, ["etl", "data pipeline", "data warehouse", "redshift", "glue", "athena"])) score += 5;
    if (hasAny(combined, ["kinesis", "kafka", "firehose", "spark", "hadoop"])) score += 3;
    if (hasAny(combined, ["s3", "parquet", "csv", "datalake", "data lake"])) score += 2;
    if (hasAny(combined, ["airflow", "dagster", "prefect", "dbt"])) score += 3;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Service signal detectors — return service signals from combined text
// ---------------------------------------------------------------------------

export interface DetectedService {
  serviceId: string;
  confidence: ConfidenceTier;
  evidence: string;
}

// ---------------------------------------------------------------------------
// Service detection — Two-tier signal evaluation (Fix 5)
// Strong signals (IaC, SDK client imports) map directly with high confidence.
// Weak signals (single keyword/package) go to suggestedServices unless
// corroborated by a second independent signal (e.g. Docker + connection string).
// ---------------------------------------------------------------------------

interface ServiceDetectionResult {
  promotedServices: DetectedService[];
  suggestedServices: DetectedService[];
}

function detectServices(
  combined: string,
  fileNames: string[],
  pattern: PatternId,
  profile?: ProjectProfile
): ServiceDetectionResult {
  const promoted: DetectedService[] = [];
  const suggested: DetectedService[] = [];
  const lower = combined.toLowerCase();

  const has = (kws: string[]) => kws.some((k) => lower.includes(k.toLowerCase()));
  const fileHas = (re: RegExp) => fileNames.some((f) => re.test(f));

  // Helper: find evidence string from profile's awsUsage for a specific service
  const awsEvidence = (service: string): string | null => {
    if (!profile) return null;
    const hit = profile.awsUsage.find((a) => a.name.toLowerCase().includes(service.toLowerCase()));
    return hit ? hit.evidence : null;
  };

  // Helper: find evidence string from profile's databases for a DB type
  const dbEvidence = (db: string): string | null => {
    if (!profile) return null;
    const hit = profile.databases.find((d) => d.name.toLowerCase().includes(db.toLowerCase()));
    return hit ? hit.evidence : null;
  };

  // Helper: find evidence string from profile's infrastructure
  const infraEvidence = (name: string): string | null => {
    if (!profile) return null;
    const hit = profile.infrastructure.find((i) => i.name.toLowerCase().includes(name.toLowerCase()));
    return hit ? hit.evidence : null;
  };

  const hasDocker = Boolean(
    infraEvidence("docker") ||
    infraEvidence("dockerfile") ||
    infraEvidence("docker-compose") ||
    fileHas(/Dockerfile/i) ||
    fileHas(/docker-compose/i)
  );

  const hasDbConnectionString = /(?:postgres|postgresql|mysql|mariadb):\/\/|DATABASE_URL|DB_HOST|DB_PASSWORD|POSTGRES_USER|MYSQL_DATABASE|RDS_ENDPOINT/i.test(combined);
  const hasRedisConnectionString = /(?:redis|rediss):\/\/|REDIS_URL|REDIS_HOST|REDIS_PORT|CACHE_HOST/i.test(combined);

  // --- Compute ---

  // Lambda: explicit SDK usage, SAM/Serverless template, or handler files
  const lambdaEv = awsEvidence("lambda");
  const hasLambdaHandler = has(["aws lambda", "lambda function", "handler.js", "handler.ts", "handler.py", "aws-lambda", "lambda_function.py"]);
  if (lambdaEv) {
    promoted.push({ serviceId: "Lambda", confidence: "high", evidence: `AWS SDK Lambda client imported — ${lambdaEv}` });
  } else if (hasLambdaHandler || has(["aws::lambda::function", "aws::serverless::function", "aws_lambda_function"])) {
    promoted.push({ serviceId: "Lambda", confidence: "high", evidence: "Lambda handler or function definition in repository files" });
  }

  // Docker → ECS/Fargate
  const dockerfileEv = infraEvidence("dockerfile") || infraEvidence("docker");
  if (dockerfileEv || hasDocker || has(["fargate", " ecs ", "ecr"])) {
    const ecsEv = awsEvidence("ecs");
    const fargateEv = awsEvidence("fargate");
    if (fargateEv || has(["fargate", "aws_ecs_task_definition", "aws::ecs::taskdefinition"])) {
      promoted.push({ serviceId: "Fargate", confidence: "high", evidence: fargateEv ? `ECS Fargate SDK usage — ${fargateEv}` : "Fargate reference in repository files" });
    } else if (ecsEv || has([" ecs ", "elastic container service", "aws_ecs_cluster", "aws::ecs::cluster"])) {
      promoted.push({ serviceId: "ECS", confidence: "high", evidence: ecsEv ? `ECS SDK usage — ${ecsEv}` : "ECS reference in repository files" });
    } else if (dockerfileEv || hasDocker) {
      promoted.push({ serviceId: "ECS", confidence: "medium", evidence: "Dockerfile/container config present → ECS as the standard container host on AWS" });
    }
  }

  // EC2
  const ec2Ev = awsEvidence("ec2");
  if (ec2Ev) {
    promoted.push({ serviceId: "EC2", confidence: "high", evidence: `EC2 SDK client imported — ${ec2Ev}` });
  } else if (has(["ec2 instance", "elastic compute cloud", "aws_instance", "aws::ec2::instance", "t3.", "t2.micro", "t3.micro", "ami-"])) {
    promoted.push({ serviceId: "EC2", confidence: "high", evidence: "EC2 instance reference in repository files" });
  }

  // EKS/Kubernetes
  const k8sEv = infraEvidence("kubernetes");
  if (k8sEv || has(["eks", "kubernetes", "k8s", "kubectl", "aws_eks_cluster", "aws::eks::cluster"])) {
    promoted.push({ serviceId: "EKS", confidence: "high", evidence: k8sEv ? `Kubernetes manifests detected — ${k8sEv}` : "EKS/Kubernetes reference in repository files" });
  }

  // ECR
  if (has([" ecr ", "elastic container registry", "ecr.aws", "aws_ecr_repository", "aws::ecr::repository"])) {
    promoted.push({ serviceId: "ECR", confidence: "high", evidence: "ECR reference detected" });
  } else if (dockerfileEv && (infraEvidence("github actions") || infraEvidence("codebuild"))) {
    promoted.push({ serviceId: "ECR", confidence: "medium", evidence: "Dockerfile + CI/CD pipeline → ECR for container image storage" });
  }

  // --- Storage ---

  const s3Ev = awsEvidence("s3");
  if (s3Ev) {
    promoted.push({ serviceId: "S3", confidence: "high", evidence: `AWS S3 SDK client imported — ${s3Ev}` });
  } else if (has(["s3 bucket", "aws s3", " s3 ", "s3.amazonaws", "s3://", "aws_s3_bucket", "aws::s3::bucket"])) {
    promoted.push({ serviceId: "S3", confidence: "high", evidence: "S3 bucket reference in repository files" });
  }

  // DynamoDB
  const dynamoEv = awsEvidence("dynamodb");
  if (dynamoEv) {
    promoted.push({ serviceId: "DynamoDB", confidence: "high", evidence: `DynamoDB SDK client imported — ${dynamoEv}` });
  } else if (has(["dynamodb", "dynamo db", "aws_dynamodb_table", "aws::dynamodb::table", "aws::serverless::simpletable"])) {
    promoted.push({ serviceId: "DynamoDB", confidence: "high", evidence: "DynamoDB reference in repository files" });
  }

  // --- Database (RDS / Aurora / ElastiCache) (Fix 5: two-tier signals) ---

  const rdsSdkEv = awsEvidence("rds");
  const postgresEv = dbEvidence("postgresql") || dbEvidence("postgres");
  const mysqlEv = dbEvidence("mysql") || dbEvidence("mariadb");
  const auroraEv = awsEvidence("aurora") || (has(["aurora"]) ? "aurora reference detected" : null);

  if (auroraEv) {
    promoted.push({ serviceId: "Aurora", confidence: "high", evidence: typeof auroraEv === "string" ? auroraEv : "Aurora reference in repository files" });
  } else if (rdsSdkEv || has(["aws::rds::dbinstance", "aws_db_instance"])) {
    // Strong signal: explicit SDK / IaC declaration
    promoted.push({ serviceId: "RDS", confidence: "high", evidence: rdsSdkEv ? `RDS SDK client imported — ${rdsSdkEv}` : "Explicit RDS declaration in IaC/config" });
  } else if (postgresEv || mysqlEv || has(["mysql", "postgres", "postgresql", "mariadb"])) {
    // Weak signal: only promoted if corroborated by connection string, env var, or ORM config
    const weakLabel = postgresEv ? `PostgreSQL (${postgresEv})` : mysqlEv ? `MySQL/MariaDB (${mysqlEv})` : "Relational database";
    const hasOrm = has(["prisma", "typeorm", "sequelize", "sqlalchemy", "knex", "hibernate", "django.db", "diesel", "gorm"]);
    if (hasDbConnectionString || hasOrm) {
      const corroboration = hasDbConnectionString
        ? "corroborated by database connection configuration in environment/files"
        : "corroborated by relational ORM configuration";
      promoted.push({
        serviceId: "RDS",
        confidence: "medium",
        evidence: `${weakLabel} dependency detected — ${corroboration} → RDS`,
      });
    } else {
      // Uncorroborated weak signal (e.g. Docker-only or unconfigured dependency) → suggested only
      suggested.push({
        serviceId: "RDS",
        confidence: "low",
        evidence: `${weakLabel} reference detected without connection configuration — suggested RDS`,
      });
    }
  }

  // ElastiCache / Redis
  const elastiCacheSdkEv = awsEvidence("elasticache");
  const redisEv = dbEvidence("redis") || (has(["redis", "ioredis", "memcached"]) ? "redis keyword" : null);
  if (elastiCacheSdkEv || has(["aws::elasticache::cachecluster", "aws_elasticache_cluster"])) {
    promoted.push({ serviceId: "ElastiCache", confidence: "high", evidence: elastiCacheSdkEv ? `ElastiCache SDK imported — ${elastiCacheSdkEv}` : "Explicit ElastiCache declaration in IaC" });
  } else if (redisEv) {
    if (hasRedisConnectionString) {
      promoted.push({
        serviceId: "ElastiCache",
        confidence: "medium",
        evidence: `Redis dependency detected — corroborated by connection config → ElastiCache Redis`,
      });
    } else {
      // Uncorroborated weak signal → suggested only
      suggested.push({
        serviceId: "ElastiCache",
        confidence: "low",
        evidence: "Redis reference detected without connection config — suggested ElastiCache",
      });
    }
  }

  // --- Networking ---

  const apigwEv = awsEvidence("api gateway") || awsEvidence("apigateway");
  if (apigwEv) {
    promoted.push({ serviceId: "APIGateway", confidence: "high", evidence: `API Gateway SDK usage — ${apigwEv}` });
  } else if (has(["api gateway", "apigateway", "aws_api_gateway", "aws::apigateway::restapi", "httpapi", "restapi"])) {
    promoted.push({ serviceId: "APIGateway", confidence: "high", evidence: "API Gateway reference in repository files" });
  }

  if (has(["cloudfront", "cdn", "distribution", "aws_cloudfront_distribution", "aws::cloudfront::distribution"])) {
    promoted.push({ serviceId: "CloudFront", confidence: "high", evidence: "CloudFront/CDN reference in repository files" });
  }

  if (has(["alb", "application load balancer", "load balancer", "elb", "aws_lb", "aws::elasticloadbalancingv2::loadbalancer"])) {
    promoted.push({ serviceId: "ALB", confidence: "medium", evidence: "Load balancer reference in repository files" });
  } else if (profile && profileHasInfra(profile, "docker") && !has(["serverless", "lambda"])) {
    promoted.push({ serviceId: "ALB", confidence: "low", evidence: "Containerised app pattern — ALB typically fronts ECS services" });
  }

  if (has(["route 53", "route53", "dns", "hosted zone", "aws_route53_zone", "aws::route53::hostedzone"])) {
    promoted.push({ serviceId: "Route53", confidence: "medium", evidence: "Route53/DNS reference in repository files" });
  }

  // --- Messaging ---

  const sqsEv = awsEvidence("sqs");
  if (sqsEv) {
    promoted.push({ serviceId: "SQS", confidence: "high", evidence: `SQS SDK client imported — ${sqsEv}` });
  } else if (has([" sqs ", "simple queue", "aws sqs", "aws_sqs_queue", "aws::sqs::queue"])) {
    promoted.push({ serviceId: "SQS", confidence: "high", evidence: "SQS reference in repository files" });
  } else if (profile && profileHasFramework(profile, "celery", "bull")) {
    const workerEv = profile.frameworks.find((f) => /celery|bull/i.test(f.name));
    if (hasDocker || has(["worker", "queue"])) {
      promoted.push({ serviceId: "SQS", confidence: "medium", evidence: `Task queue library detected (${workerEv?.evidence}) → SQS as the backing queue on AWS` });
    } else {
      suggested.push({ serviceId: "SQS", confidence: "low", evidence: `Task queue library detected (${workerEv?.evidence}) — suggested SQS` });
    }
  }

  const snsEv = awsEvidence("sns");
  if (snsEv) {
    promoted.push({ serviceId: "SNS", confidence: "high", evidence: `SNS SDK client imported — ${snsEv}` });
  } else if (has([" sns ", "simple notification", "aws sns", "aws_sns_topic", "aws::sns::topic"])) {
    promoted.push({ serviceId: "SNS", confidence: "high", evidence: "SNS reference in repository files" });
  }

  const ebEv = awsEvidence("eventbridge");
  if (ebEv) {
    promoted.push({ serviceId: "EventBridge", confidence: "high", evidence: `EventBridge SDK client imported — ${ebEv}` });
  } else if (has(["eventbridge", "event bus", "aws_cloudwatch_event_rule", "aws::events::rule"])) {
    promoted.push({ serviceId: "EventBridge", confidence: "high", evidence: "EventBridge reference in repository files" });
  }

  const kinesisEv = awsEvidence("kinesis");
  if (kinesisEv) {
    promoted.push({ serviceId: "Kinesis", confidence: "high", evidence: `Kinesis SDK client imported — ${kinesisEv}` });
  } else if (has(["kinesis", "kinesis stream", "kinesis firehose", "aws_kinesis_stream", "aws::kinesis::stream"])) {
    promoted.push({ serviceId: "Kinesis", confidence: "high", evidence: "Kinesis reference in repository files" });
  }

  // --- Auth ---

  const cognitoEv = awsEvidence("cognito");
  if (cognitoEv) {
    promoted.push({ serviceId: "Cognito", confidence: "high", evidence: `Cognito SDK client imported — ${cognitoEv}` });
  } else if (has(["cognito", "user pool", "identity pool", "aws_cognito_user_pool", "aws::cognito::userpool"])) {
    promoted.push({ serviceId: "Cognito", confidence: "high", evidence: "Cognito reference in repository files" });
  }

  // --- ML ---
  if (has(["sagemaker", "training job", "inference endpoint", "aws_sagemaker_model"])) {
    promoted.push({ serviceId: "SageMaker", confidence: "high", evidence: "SageMaker reference in repository files" });
  }
  if (has(["rekognition"])) {
    promoted.push({ serviceId: "Rekognition", confidence: "high", evidence: "Rekognition reference in repository files" });
  }
  if (has(["comprehend"])) {
    promoted.push({ serviceId: "Comprehend", confidence: "high", evidence: "Comprehend reference in repository files" });
  }

  // --- Pattern-specific baseline additions ---

  if (pattern === "serverless-api" && !promoted.some((s) => s.serviceId === "Lambda")) {
    const sfEv = infraEvidence("serverless framework") || infraEvidence("sam");
    promoted.push({ serviceId: "Lambda", confidence: "medium", evidence: sfEv ? `Serverless/SAM config present (${sfEv}) → Lambda compute` : "Serverless pattern baseline" });
  }
  if (pattern === "serverless-api" && !promoted.some((s) => s.serviceId === "APIGateway")) {
    promoted.push({ serviceId: "APIGateway", confidence: "medium", evidence: "Serverless API pattern → API Gateway as the HTTP entry point" });
  }
  if (pattern === "static-site" && !promoted.some((s) => s.serviceId === "S3")) {
    const buildEv = profile?.frameworks.find((f) => /vite|gatsby|hugo|astro|jekyll/i.test(f.name));
    promoted.push({ serviceId: "S3", confidence: "medium", evidence: buildEv ? `Static build tool (${buildEv.evidence}) → S3 for built assets` : "Static site pattern → S3 for hosting" });
  }
  if (pattern === "static-site" && !promoted.some((s) => s.serviceId === "CloudFront")) {
    promoted.push({ serviceId: "CloudFront", confidence: "medium", evidence: "Static site pattern → CloudFront CDN in front of S3" });
  }
  if ((pattern === "containerised-app" || pattern === "full-stack-web") &&
      !promoted.some((s) => s.serviceId === "ECS") &&
      !promoted.some((s) => s.serviceId === "Fargate") &&
      !promoted.some((s) => s.serviceId === "EKS")) {
    const dockerEv = infraEvidence("docker");
    promoted.push({ serviceId: "ECS", confidence: "low", evidence: dockerEv ? `Containerised app with Dockerfile (${dockerEv}) → ECS (no orchestrator explicitly specified)` : "Container pattern baseline — no specific orchestrator detected" });
  }

  // --- Observability (Fix 5: Gated behind active compute service presence) ---
  const COMPUTE_SERVICES = ["Lambda", "ECS", "EC2", "Fargate", "EKS", "Batch", "Lightsail"];
  const hasActiveCompute = promoted.some((s) => COMPUTE_SERVICES.includes(s.serviceId));
  if (hasActiveCompute) {
    promoted.push({ serviceId: "CloudWatch", confidence: "medium", evidence: "CloudWatch monitoring for active compute services" });
  }

  // Deduplicate promoted by serviceId — first occurrence wins
  const seenPromoted = new Set<string>();
  const uniquePromoted = promoted.filter((s) => {
    if (seenPromoted.has(s.serviceId)) return false;
    seenPromoted.add(s.serviceId);
    return true;
  });

  // Deduplicate suggested (and exclude anything already in promoted)
  const seenSuggested = new Set<string>();
  const uniqueSuggested = suggested.filter((s) => {
    if (seenPromoted.has(s.serviceId) || seenSuggested.has(s.serviceId)) return false;
    seenSuggested.add(s.serviceId);
    return true;
  });

  return {
    promotedServices: uniquePromoted,
    suggestedServices: uniqueSuggested,
  };
}

// ---------------------------------------------------------------------------
// Pattern → slot name mapping
// Each pattern has a fixed set of named slots. Services are mapped to slots
// in order of the detected services list; overflow goes to "additional_N".
// ---------------------------------------------------------------------------

export const PATTERN_SLOTS: Record<PatternId, string[]> = {
  "static-site":      ["cdn", "storage", "dns", "monitoring"],
  "serverless-api":   ["api", "compute", "database", "storage", "queue", "auth", "monitoring"],
  "containerised-app":["compute", "registry", "load_balancer", "database", "cache", "storage", "monitoring"],
  "event-driven":     ["producer", "queue", "consumer", "compute", "database", "monitoring"],
  "ml-pipeline":      ["training", "storage", "compute", "api", "monitoring"],
  "full-stack-web":   ["frontend", "api", "compute", "database", "cache", "storage", "cdn", "monitoring"],
  "data-pipeline":    ["ingestion", "processing", "storage", "warehouse", "monitoring"],
  "generic":          ["compute", "storage", "database", "networking", "monitoring"],
};

// Preferred service → slot mapping for each pattern
// If a service is detected, it goes into this slot (if available)
export const SERVICE_SLOT_AFFINITY: Record<string, string> = {
  // static-site
  CloudFront: "cdn",
  S3: "storage",
  Route53: "dns",
  CloudWatch: "monitoring",
  // serverless-api / full-stack-web / containerised-app
  APIGateway: "api",
  Lambda: "compute",
  DynamoDB: "database",
  RDS: "database",
  Aurora: "database",
  SQS: "queue",
  SNS: "queue",
  Cognito: "auth",
  ALB: "load_balancer",
  ECS: "compute",
  Fargate: "compute",
  EKS: "compute",
  EC2: "compute",
  ECR: "registry",
  ElastiCache: "cache",
  EventBridge: "producer",
  Kinesis: "ingestion",
  SageMaker: "training",
  Rekognition: "compute",
  Comprehend: "compute",
  Amplify: "frontend",
};

export function assignSlots(
  pattern: PatternId,
  services: DetectedService[]
): Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }> {
  const slots: Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }> = {};
  const templateSlots = [...PATTERN_SLOTS[pattern]];
  const remainingSlots = new Set(templateSlots);
  let additionalIndex = 1;

  for (const svc of services) {
    const preferredSlot = SERVICE_SLOT_AFFINITY[svc.serviceId];
    if (preferredSlot && remainingSlots.has(preferredSlot)) {
      slots[preferredSlot] = { serviceId: svc.serviceId, confidence: svc.confidence, evidence: svc.evidence };
      remainingSlots.delete(preferredSlot);
    } else if (remainingSlots.size > 0) {
      // Take the next available slot from the template
      const nextSlot = [...remainingSlots][0];
      slots[nextSlot] = { serviceId: svc.serviceId, confidence: svc.confidence, evidence: svc.evidence };
      remainingSlots.delete(nextSlot);
    } else {
      // Template slots full — use an overflow slot (still counted toward the 12-service cap)
      const overflowSlot = `additional_${additionalIndex++}`;
      slots[overflowSlot] = { serviceId: svc.serviceId, confidence: svc.confidence, evidence: svc.evidence };
    }
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Runs the deterministic rule engine over the given signals.
 * Always returns a valid ServicePlan — never throws.
 *
 * Decision 3: rules-first baseline, never fails.
 */
export function runRuleEngine(input: RuleInput): ServicePlan {
  const combined = [input.description, input.fileContent].join("\n");
  const p = input.profile; // may be undefined on description path

  // 1. Score each pattern (profile-aware when available)
  const scores: PatternScore[] = [
    { pattern: "static-site",       score: scoreStaticSite(combined, input.fileNames, p) },
    { pattern: "serverless-api",    score: scoreServerlessApi(combined, input.fileNames, p) },
    { pattern: "containerised-app", score: scoreContainerisedApp(combined, input.fileNames, p) },
    { pattern: "event-driven",      score: scoreEventDriven(combined, p) },
    { pattern: "ml-pipeline",       score: scoreMlPipeline(combined, p) },
    { pattern: "full-stack-web",    score: scoreFullStackWeb(combined, input.fileNames, p) },
    { pattern: "data-pipeline",     score: scoreDataPipeline(combined, p) },
    { pattern: "generic",           score: 0 }, // always available as last resort
  ];

  // Pick highest-scoring pattern; ties broken by order (earlier = more specific)
  scores.sort((a, b) => b.score - a.score);
  const bestPattern = scores[0].pattern;

  // 2. Detect services from signals (pass profile for file-specific evidence)
  const { promotedServices, suggestedServices } = detectServices(
    combined,
    input.fileNames,
    bestPattern,
    input.profile
  );

  // 3. Apply 12-service cap (Decision 2 / flaw 3)
  const capped = promotedServices.slice(0, 12);

  // 4. Assign services to pattern slots
  const slots = assignSlots(bestPattern, capped);

  // 5. Build and validate the plan (the refine checks run here)
  const plan: ServicePlan = {
    inputKind: input.inputKind,
    pattern: bestPattern,
    slots,
    customEdges: [],
    suggestedServices: suggestedServices.slice(0, 10).map((s) => ({
      serviceId: s.serviceId,
      confidence: s.confidence,
      evidence: s.evidence,
    })),
    metadata: {
      grounding: input.grounding,
      truncated: input.truncated,
      parseErrors: input.parseErrors,
    },
  };

  // Validate — this should always pass for rule engine output, but we check
  // defensively. If it somehow fails, return the fallback plan.
  const result = ServicePlanSchema.safeParse(plan);
  if (!result.success) {
    const fallback: ServicePlan = {
      inputKind: input.inputKind,
      pattern: "generic",
      slots: {},
      customEdges: [],
      suggestedServices: [],
      metadata: {
        grounding: input.grounding,
        truncated: input.truncated,
        parseErrors: [...input.parseErrors, "rule-engine-schema-validation-failed"],
      },
    };
    return fallback;
  }

  return result.data;
}
