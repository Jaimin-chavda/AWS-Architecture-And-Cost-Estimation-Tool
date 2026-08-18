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
 * Input is a `RuleInput` — a bag of signals that either the RepoFetcher (Stage 2
 * — added later) or the freeform description path provides.
 */

import { ServicePlanSchema } from "./schema.ts";
import type { ServicePlan, PatternId, ConfidenceTier, Grounding } from "./schema.ts";

// ---------------------------------------------------------------------------
// RuleInput — signals available to the rule engine.
// Stage 2 (RepoFetcher) will populate all fields from repo content.
// Freeform path populates only description.
// ---------------------------------------------------------------------------
export interface RuleInput {
  /** Freeform description text or README content */
  description: string;
  /** Concatenated content of all key files (for keyword matching) */
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

function scoreStaticSite(combined: string, fileNames: string[]): number {
  let score = 0;
  if (hasAny(combined, ["vercel.json", "netlify.toml", "amplify.yml"])) score += 4;
  if (hasAny(combined, ["static", "gatsby", "hugo", "jekyll", "next export", "vite", "astro"])) score += 2;
  if (fileNames.some((f) => /^(vercel|netlify)\.toml?/.test(f))) score += 3;
  if (hasAny(combined, ["s3 static", "cloudfront", "s3 website"])) score += 3;
  if (!hasAny(combined, ["server", "api", "backend", "express", "fastapi", "django", "rails"])) score += 1;
  return score;
}

function scoreServerlessApi(combined: string, fileNames: string[]): number {
  let score = 0;
  if (fileNames.some((f) => /^serverless\.(yml|yaml)$/.test(f))) score += 5;
  if (hasAny(combined, ["aws-lambda", "lambda", "handler.js", "handler.ts", "handler.py"])) score += 3;
  if (hasAny(combined, ["api gateway", "apigateway", "aws_api_gateway", "httpapi"])) score += 3;
  if (hasAny(combined, ["dynamodb", "dynamo"])) score += 2;
  if (hasAny(combined, ["serverless framework", "sam template", "template.yaml"])) score += 4;
  if (fileNames.some((f) => /^template\.yaml$/.test(f))) score += 4;
  return score;
}

function scoreContainerisedApp(combined: string, fileNames: string[]): number {
  let score = 0;
  if (fileNames.some((f) => /^Dockerfile$/i.test(f))) score += 4;
  if (fileNames.some((f) => /^docker-compose\.(yml|yaml)$/.test(f))) score += 3;
  if (hasAny(combined, ["ecs", "fargate", "ecr", "kubernetes", "k8s", "eks"])) score += 4;
  if (hasAny(combined, ["container", "image:", "FROM ", "ENTRYPOINT"])) score += 2;
  if (hasAny(combined, ["alb", "load balancer", "application load balancer"])) score += 2;
  return score;
}

function scoreEventDriven(combined: string): number {
  let score = 0;
  if (hasAny(combined, ["sqs", "sns", "eventbridge", "kinesis", "kafka"])) score += 4;
  if (hasAny(combined, ["event", "message queue", "pub/sub", "pubsub", "worker", "consumer", "producer"])) score += 2;
  if (hasAny(combined, ["async", "asynchronous", "background job", "celery", "bull"])) score += 2;
  return score;
}

function scoreMlPipeline(combined: string): number {
  let score = 0;
  if (hasAny(combined, ["sagemaker", "machine learning", "ml model", "training job", "inference endpoint"])) score += 5;
  if (hasAny(combined, ["tensorflow", "pytorch", "scikit", "huggingface", "transformers", "jupyter"])) score += 3;
  if (hasAny(combined, ["rekognition", "comprehend", "bedrock", "llm", "embedding", "vector"])) score += 3;
  if (hasAny(combined, ["s3", "dataset", "pipeline", "batch"])) score += 1;
  return score;
}

function scoreFullStackWeb(combined: string, fileNames: string[]): number {
  let score = 0;
  // Has both frontend and backend signals
  const hasFrontend = hasAny(combined, ["react", "vue", "angular", "svelte", "next.js", "nuxt", "remix"]);
  const hasBackend = hasAny(combined, ["express", "fastapi", "django", "rails", "spring", "laravel", "nest"]);
  if (hasFrontend && hasBackend) score += 5;
  if (hasFrontend || hasBackend) score += 2;
  if (hasAny(combined, ["rds", "postgres", "mysql", "mongodb", "database"])) score += 2;
  if (hasAny(combined, ["ec2", "elastic beanstalk", "beanstalk"])) score += 2;
  if (fileNames.some((f) => /^package\.json$/.test(f))) score += 1;
  return score;
}

function scoreDataPipeline(combined: string): number {
  let score = 0;
  if (hasAny(combined, ["etl", "data pipeline", "data warehouse", "redshift", "glue", "athena"])) score += 5;
  if (hasAny(combined, ["kinesis", "kafka", "firehose", "spark", "hadoop"])) score += 3;
  if (hasAny(combined, ["s3", "parquet", "csv", "datalake", "data lake"])) score += 2;
  if (hasAny(combined, ["airflow", "dagster", "prefect", "dbt"])) score += 3;
  return score;
}

// ---------------------------------------------------------------------------
// Service signal detectors — return service signals from combined text
// ---------------------------------------------------------------------------

interface DetectedService {
  serviceId: string;
  confidence: ConfidenceTier;
  evidence: string;
}

function detectServices(
  combined: string,
  fileNames: string[],
  pattern: PatternId
): DetectedService[] {
  const services: DetectedService[] = [];
  const lower = combined.toLowerCase();

  const has = (kws: string[]) => kws.some((k) => lower.includes(k.toLowerCase()));
  const fileHas = (re: RegExp) => fileNames.some((f) => re.test(f));

  // --- Compute ---
  if (has(["aws lambda", "lambda function", "handler.js", "handler.ts", "handler.py", "aws-lambda"])) {
    services.push({ serviceId: "Lambda", confidence: "high", evidence: "Lambda handler or sdk reference detected" });
  }
  if (fileHas(/^Dockerfile$/i) || has(["fargate", " ecs ", "ecr"])) {
    if (has(["fargate"])) {
      services.push({ serviceId: "Fargate", confidence: "high", evidence: "Fargate reference detected" });
    }
    if (has([" ecs ", "elastic container service"])) {
      services.push({ serviceId: "ECS", confidence: "high", evidence: "ECS reference detected" });
    }
    if (fileHas(/^Dockerfile$/i) && !has(["fargate", " ecs "])) {
      services.push({ serviceId: "ECS", confidence: "medium", evidence: "Dockerfile present; ECS is the likely container host" });
    }
  }
  if (has(["ec2 instance", "elastic compute cloud", " ec2 ", "t3.", "t2.micro", "t3.micro", "ami-"])) {
    services.push({ serviceId: "EC2", confidence: "high", evidence: "EC2 instance reference detected" });
  }
  if (has(["eks", "kubernetes", "k8s", "kubectl"])) {
    services.push({ serviceId: "EKS", confidence: "high", evidence: "EKS/Kubernetes reference detected" });
  }
  if (has([" ecr ", "elastic container registry", "ecr.aws"])) {
    services.push({ serviceId: "ECR", confidence: "high", evidence: "ECR reference detected" });
  }

  // --- Storage ---
  if (has(["s3 bucket", "aws s3", " s3 ", "s3.amazonaws", "s3://"])) {
    services.push({ serviceId: "S3", confidence: "high", evidence: "S3 bucket reference detected" });
  }
  if (has(["dynamodb", "dynamo db"])) {
    services.push({ serviceId: "DynamoDB", confidence: "high", evidence: "DynamoDB reference detected" });
  }
  if (has(["rds", "relational database", "aurora", "mysql", "postgres", "postgresql", "mariadb"])) {
    if (has(["aurora"])) {
      services.push({ serviceId: "Aurora", confidence: "high", evidence: "Aurora reference detected" });
    } else {
      services.push({ serviceId: "RDS", confidence: "high", evidence: "RDS/relational database reference detected" });
    }
  }
  if (has(["elasticache", "redis", "memcached"])) {
    services.push({ serviceId: "ElastiCache", confidence: "high", evidence: "ElastiCache/Redis reference detected" });
  }

  // --- Networking ---
  if (has(["api gateway", "apigateway", "aws_api_gateway", "httpapi", "restapi"])) {
    services.push({ serviceId: "APIGateway", confidence: "high", evidence: "API Gateway reference detected" });
  }
  if (has(["cloudfront", "cdn", "distribution"])) {
    services.push({ serviceId: "CloudFront", confidence: "high", evidence: "CloudFront/CDN reference detected" });
  }
  if (has(["alb", "application load balancer", "load balancer", "elb"])) {
    services.push({ serviceId: "ALB", confidence: "medium", evidence: "Load balancer reference detected" });
  }
  if (has(["route 53", "route53", "dns", "hosted zone"])) {
    services.push({ serviceId: "Route53", confidence: "medium", evidence: "Route53/DNS reference detected" });
  }

  // --- Messaging ---
  if (has([" sqs ", "simple queue", "aws sqs"])) {
    services.push({ serviceId: "SQS", confidence: "high", evidence: "SQS reference detected" });
  }
  if (has([" sns ", "simple notification", "aws sns"])) {
    services.push({ serviceId: "SNS", confidence: "high", evidence: "SNS reference detected" });
  }
  if (has(["eventbridge", "event bus"])) {
    services.push({ serviceId: "EventBridge", confidence: "high", evidence: "EventBridge reference detected" });
  }
  if (has(["kinesis", "kinesis stream", "kinesis firehose"])) {
    services.push({ serviceId: "Kinesis", confidence: "high", evidence: "Kinesis reference detected" });
  }

  // --- Auth ---
  if (has(["cognito", "user pool", "identity pool"])) {
    services.push({ serviceId: "Cognito", confidence: "high", evidence: "Cognito reference detected" });
  }

  // --- Observability ---
  // CloudWatch is always added as a baseline — every AWS app has it
  services.push({ serviceId: "CloudWatch", confidence: "medium", evidence: "CloudWatch is present in every AWS deployment" });

  // --- ML ---
  if (has(["sagemaker", "training job", "inference endpoint"])) {
    services.push({ serviceId: "SageMaker", confidence: "high", evidence: "SageMaker reference detected" });
  }
  if (has(["rekognition"])) {
    services.push({ serviceId: "Rekognition", confidence: "high", evidence: "Rekognition reference detected" });
  }
  if (has(["comprehend"])) {
    services.push({ serviceId: "Comprehend", confidence: "high", evidence: "Comprehend reference detected" });
  }

  // --- Pattern-specific baseline additions ---
  if (pattern === "serverless-api" && !services.some((s) => s.serviceId === "Lambda")) {
    services.push({ serviceId: "Lambda", confidence: "medium", evidence: "Serverless pattern baseline" });
  }
  if (pattern === "serverless-api" && !services.some((s) => s.serviceId === "APIGateway")) {
    services.push({ serviceId: "APIGateway", confidence: "medium", evidence: "Serverless pattern baseline" });
  }
  if (pattern === "static-site" && !services.some((s) => s.serviceId === "S3")) {
    services.push({ serviceId: "S3", confidence: "medium", evidence: "Static site pattern baseline" });
  }
  if (pattern === "static-site" && !services.some((s) => s.serviceId === "CloudFront")) {
    services.push({ serviceId: "CloudFront", confidence: "medium", evidence: "Static site pattern baseline" });
  }
  if ((pattern === "containerised-app" || pattern === "full-stack-web") &&
      !services.some((s) => s.serviceId === "ECS") &&
      !services.some((s) => s.serviceId === "Fargate") &&
      !services.some((s) => s.serviceId === "EKS")) {
    services.push({ serviceId: "ECS", confidence: "low", evidence: "Container pattern baseline (no specific orchestrator detected)" });
  }

  // Deduplicate by serviceId — first occurrence wins (highest signal)
  const seen = new Set<string>();
  return services.filter((s) => {
    if (seen.has(s.serviceId)) return false;
    seen.add(s.serviceId);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Pattern → slot name mapping
// Each pattern has a fixed set of named slots. Services are mapped to slots
// in order of the detected services list; overflow goes to "additional_N".
// ---------------------------------------------------------------------------

const PATTERN_SLOTS: Record<PatternId, string[]> = {
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
const SERVICE_SLOT_AFFINITY: Record<string, string> = {
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

function assignSlots(
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

  // 1. Score each pattern
  const scores: PatternScore[] = [
    { pattern: "static-site",       score: scoreStaticSite(combined, input.fileNames) },
    { pattern: "serverless-api",    score: scoreServerlessApi(combined, input.fileNames) },
    { pattern: "containerised-app", score: scoreContainerisedApp(combined, input.fileNames) },
    { pattern: "event-driven",      score: scoreEventDriven(combined) },
    { pattern: "ml-pipeline",       score: scoreMlPipeline(combined) },
    { pattern: "full-stack-web",    score: scoreFullStackWeb(combined, input.fileNames) },
    { pattern: "data-pipeline",     score: scoreDataPipeline(combined) },
    { pattern: "generic",           score: 0 }, // always available as last resort
  ];

  // Pick highest-scoring pattern; ties broken by order (earlier = more specific)
  scores.sort((a, b) => b.score - a.score);
  const bestPattern = scores[0].pattern;

  // 2. Detect services from signals
  const detected = detectServices(combined, input.fileNames, bestPattern);

  // 3. Apply 12-service cap (Decision 2 / flaw 3)
  const capped = detected.slice(0, 12);

  // 4. Assign services to pattern slots
  const slots = assignSlots(bestPattern, capped);

  // 5. Build and validate the plan (the refine checks run here)
  const plan: ServicePlan = {
    inputKind: input.inputKind,
    pattern: bestPattern,
    slots,
    customEdges: [],
    metadata: {
      grounding: input.grounding,
      truncated: input.truncated,
      parseErrors: input.parseErrors,
    },
  };

  // Validate — this should always pass for rule engine output, but we check
  // defensively. If it somehow fails, return the absolute minimum viable plan.
  const result = ServicePlanSchema.safeParse(plan);
  if (!result.success) {
    // Minimum viable plan: generic pattern + CloudWatch only
    const fallback: ServicePlan = {
      inputKind: input.inputKind,
      pattern: "generic",
      slots: {
        monitoring: { serviceId: "CloudWatch", confidence: "low", evidence: "Rule engine fallback minimum" },
      },
      customEdges: [],
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
