/**
 * architecture.ts  —  Architecture Model + Deterministic AWS Mapping
 *
 * Pipeline:
 *   RepoSignals / description → LLM → ArchitectureModel
 *     → validateArchitectureModel() → mapArchitectureModelToServicePlan()
 *     → ServicePlan → diagram.ts + cost.ts
 *
 * The LLM describes the APPLICATION, not AWS: components use real tech names
 * ("PostgreSQL", "Express"), and AWS service selection happens deterministically
 * in mapArchitectureModelToServicePlan() using a lookup table — patterns only
 * used as sanity-check labels, never to constrain component count.
 */

import { z } from "zod";
import {
  SERVICE_IDS,
  COMPONENT_TYPES,
  DiscoveredComponentSchema,
  ComponentRelationshipSchema,
  DeploymentModelSchema,
  AwsServiceMappingSchema,
  ServicePlanSchema,
  type ServiceId,
  type ComponentType,
  type ConfidenceTier,
  type Grounding,
  type ServicePlan,
  type DiscoveredComponent,
  type ComponentRelationship,
  type DeploymentModel,
  type AwsServiceMapping,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Architecture Model schema (LLM output)
// ---------------------------------------------------------------------------

export const ArchitectureComponentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  type: z.enum(COMPONENT_TYPES),
  technology: z.string().min(1).max(80),
  details: z.string().max(200).optional(),
  evidence: z.array(z.string().max(200)).max(5).optional().default([]),
  confidence: z.enum(["high", "medium", "low"]).optional().default("medium"),
});
export type ArchitectureComponent = z.infer<typeof ArchitectureComponentSchema>;

export const ArchitectureRelationshipSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  type: z.string().max(40).optional(),
});
export type ArchitectureRelationship = z.infer<typeof ArchitectureRelationshipSchema>;

export const PATTERN_IDS = [
  "static-site", "serverless-api", "containerised-app", "event-driven",
  "ml-pipeline", "full-stack-web", "data-pipeline", "generic",
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export const ArchitectureModelSchema = z.object({
  appType: z.string().default("full-stack-web"),
  appName: z.string().max(120).default("Cloud Application"),
  description: z.string().max(1000).default(""),
  components: z.array(ArchitectureComponentSchema).min(1),
  languages: z.array(z.string().max(60)).default([]),
  frameworks: z.array(z.string().max(60)).default([]),
  databases: z.array(z.string().max(60)).default([]),
  apis: z.array(z.string().max(100)).default([]),
  externalServices: z.array(z.string().max(100)).default([]),
  dependencies: z.array(z.string().max(100)).default([]),
  buildConfig: z.array(z.string().max(100)).default([]),
  relationships: z.array(ArchitectureRelationshipSchema).default([]),
});
export type ArchitectureModel = z.infer<typeof ArchitectureModelSchema>;

// ---------------------------------------------------------------------------
// Normalization + validation
// ---------------------------------------------------------------------------

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(s.trim());
  }
  return out;
}

export function normalizeArchitectureModel(model: ArchitectureModel): ArchitectureModel {
  const ids = new Set(model.components.map((c) => c.id));
  const seenIds = new Set<string>();
  const components = model.components.filter((c) => {
    if (seenIds.has(c.id)) return false;
    seenIds.add(c.id);
    return true;
  });

  return {
    ...model,
    appName: model.appName.trim(),
    description: model.description.trim(),
    components,
    languages: dedupeStrings(model.languages),
    frameworks: dedupeStrings(model.frameworks),
    databases: dedupeStrings(model.databases),
    apis: dedupeStrings(model.apis),
    externalServices: dedupeStrings(model.externalServices),
    dependencies: dedupeStrings(model.dependencies),
    buildConfig: dedupeStrings(model.buildConfig),
    relationships: model.relationships.filter((r) => ids.has(r.from) && ids.has(r.to)),
  };
}

export function validateArchitectureModel(raw: unknown): ArchitectureModel | null {
  const result = ArchitectureModelSchema.safeParse(raw);
  if (!result.success) {
    console.warn(
      "[architecture] LLM architecture model failed validation:",
      result.error.issues.map((i) => i.message).join("; ")
    );
    return null;
  }
  return normalizeArchitectureModel(result.data);
}

// ---------------------------------------------------------------------------
// Deterministic AWS service mapping (based ONLY on the architecture model)
// Pattern lookup table — used as SANITY CHECK only, never to constrain components
// ---------------------------------------------------------------------------

const COMPUTE_SERVICES: ServiceId[] = ["Lambda", "EC2", "ECS", "EKS", "Fargate", "Batch", "Lightsail"];

// Pattern → expected services lookup (for UI label only)
const PATTERN_SERVICE_LOOKUP: Record<PatternId, ServiceId[]> = {
  "static-site": ["S3", "CloudFront", "Route53"],
  "serverless-api": ["Lambda", "APIGateway", "DynamoDB", "SQS", "SNS", "Cognito"],
  "containerised-app": ["ECS", "ECR", "ALB", "RDS", "ElastiCache", "S3"],
  "event-driven": ["Lambda", "SQS", "SNS", "EventBridge", "DynamoDB", "RDS"],
  "ml-pipeline": ["SageMaker", "S3", "Lambda", "ECS"],
  "full-stack-web": ["CloudFront", "APIGateway", "ECS", "RDS", "ElastiCache", "S3", "Cognito"],
  "data-pipeline": ["Kinesis", "S3", "Lambda", "Redshift"],
  "generic": [],
};

// Component type + technology → AWS service mapping
function mapComponentToAws(c: ArchitectureComponent): AwsServiceMapping[] {
  const tech = `${c.name} ${c.technology} ${c.details ?? ""}`.toLowerCase();
  const ev = `component ${c.name} (${c.technology})`;
  const mappings: AwsServiceMapping[] = [];

  switch (c.type) {
    case "database":
      if (/dynamo/.test(tech)) mappings.push({ componentId: c.id, serviceId: "DynamoDB", confidence: "high", evidence: ev, fromPattern: false });
      else if (/mongo/.test(tech)) mappings.push({ componentId: c.id, serviceId: "DocumentDB", confidence: "high", evidence: ev, fromPattern: false });
      else if (/redis|memcached/.test(tech)) mappings.push({ componentId: c.id, serviceId: "ElastiCache", confidence: "high", evidence: ev, fromPattern: false });
      else if (/aurora/.test(tech)) mappings.push({ componentId: c.id, serviceId: "Aurora", confidence: "high", evidence: ev, fromPattern: false });
      else mappings.push({ componentId: c.id, serviceId: "RDS", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "cache":
      mappings.push({ componentId: c.id, serviceId: "ElastiCache", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "queue":
      mappings.push({ componentId: c.id, serviceId: "SQS", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "object-storage":
      mappings.push({ componentId: c.id, serviceId: "S3", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "search":
      mappings.push({ componentId: c.id, serviceId: "SageMaker", confidence: "medium", evidence: ev, fromPattern: false }); // OpenSearch not in catalog
      break;

    case "auth":
      if (/secrets|key|vault|jwt/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "SecretsManager", confidence: "high", evidence: ev, fromPattern: false });
      } else {
        mappings.push({ componentId: c.id, serviceId: "Cognito", confidence: "high", evidence: ev, fromPattern: false });
      }
      break;

    case "messaging":
      if (/sns|notification/.test(tech)) mappings.push({ componentId: c.id, serviceId: "SNS", confidence: "high", evidence: ev, fromPattern: false });
      else if (/eventbridge|event.bus/.test(tech)) mappings.push({ componentId: c.id, serviceId: "EventBridge", confidence: "high", evidence: ev, fromPattern: false });
      else if (/kinesis|stream/.test(tech)) mappings.push({ componentId: c.id, serviceId: "Kinesis", confidence: "high", evidence: ev, fromPattern: false });
      else mappings.push({ componentId: c.id, serviceId: "SQS", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "frontend":
      mappings.push(
        { componentId: c.id, serviceId: "S3", confidence: "high", evidence: `${ev} → static assets`, fromPattern: false },
        { componentId: c.id, serviceId: "CloudFront", confidence: "high", evidence: `${ev} → CDN`, fromPattern: false }
      );
      break;

    case "backend":
      if (/serverless|lambda/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false },
          { componentId: c.id, serviceId: "APIGateway", confidence: "medium", evidence: `${ev} → HTTP entry`, fromPattern: false }
        );
      } else if (/container|docker|kubernetes|k8s|ecs|fargate|eks/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "ECS", confidence: "high", evidence: ev, fromPattern: false });
      } else if (/ec2|virtual machine|vm|instance/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "EC2", confidence: "high", evidence: ev, fromPattern: false });
      } else {
        mappings.push({ componentId: c.id, serviceId: "ECS", confidence: "medium", evidence: `${ev} (Fargate container host)`, fromPattern: false });
      }
      break;

    case "worker":
      if (/serverless|lambda/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false });
      } else {
        mappings.push({ componentId: c.id, serviceId: "ECS", confidence: "medium", evidence: ev, fromPattern: false });
      }
      break;

    case "scheduler":
      if (/serverless|lambda/.test(tech)) {
        mappings.push(
          { componentId: c.id, serviceId: "Lambda", confidence: "high", evidence: ev, fromPattern: false },
          { componentId: c.id, serviceId: "EventBridge", confidence: "medium", evidence: `${ev} → schedule trigger`, fromPattern: false }
        );
      } else {
        mappings.push(
          { componentId: c.id, serviceId: "ECS", confidence: "medium", evidence: ev, fromPattern: false },
          { componentId: c.id, serviceId: "EventBridge", confidence: "medium", evidence: `${ev} → schedule trigger`, fromPattern: false }
        );
      }
      break;

    case "api":
      if (/alb|load balancer/.test(tech)) {
        mappings.push({ componentId: c.id, serviceId: "ALB", confidence: "high", evidence: ev, fromPattern: false });
      } else {
        mappings.push({ componentId: c.id, serviceId: "APIGateway", confidence: "high", evidence: ev, fromPattern: false });
      }
      break;

    case "proxy":
      if (/route ?53|dns/.test(tech)) mappings.push({ componentId: c.id, serviceId: "Route53", confidence: "high", evidence: ev, fromPattern: false });
      else if (/alb|load balancer/.test(tech)) mappings.push({ componentId: c.id, serviceId: "ALB", confidence: "high", evidence: ev, fromPattern: false });
      else if (/waf|firewall/.test(tech)) mappings.push({ componentId: c.id, serviceId: "WAF", confidence: "high", evidence: ev, fromPattern: false });
      break;

    case "external-service":
    case "websocket":
      break;
  }

  return mappings;
}

// Additional mappings from structured lists
function mapListTechnologies(model: ArchitectureModel, existing: Map<string, ServiceId>): AwsServiceMapping[] {
  const mappings: AwsServiceMapping[] = [];
  const listText = [
    ...model.databases,
    ...model.frameworks,
    ...model.buildConfig,
    ...model.languages,
  ].join(" ").toLowerCase();

  const hasService = (s: ServiceId) => Array.from(existing.values()).includes(s);
  const add = (service: ServiceId, confidence: ConfidenceTier, evidence: string) => {
    if (hasService(service)) return;
    const pseudoId = `list-${service.toLowerCase()}`;
    mappings.push({ componentId: pseudoId, serviceId: service, confidence, evidence, fromPattern: false });
  };

  if (/dynamo/.test(listText)) add("DynamoDB", "medium", "DynamoDB listed in model");
  if (/mongo/.test(listText)) add("DocumentDB", "medium", "MongoDB listed in model");
  if (/redis|memcached/.test(listText)) add("ElastiCache", "medium", "Redis/cache listed in model");
  if (/aurora/.test(listText)) add("Aurora", "medium", "Aurora listed in model");
  if (/(postgres|postgresql|mysql|mariadb|sql)/.test(listText) && !hasService("RDS") && !hasService("Aurora")) {
    add("RDS", "medium", "relational database listed in model");
  }
  if (/(sagemaker|tensorflow|pytorch|scikit|huggingface|transformers)/.test(listText)) {
    add("SageMaker", "medium", "ML framework/model training listed in model");
  }
  if (/(s3|bucket|object storage)/.test(listText)) add("S3", "medium", "object storage referenced in model");

  return mappings;
}

// Pattern baselines — ensures complete enterprise cloud blueprint
function applyPatternBaselines(model: ArchitectureModel, existing: Map<string, ServiceId>): AwsServiceMapping[] {
  const mappings: AwsServiceMapping[] = [];
  const hasService = (s: ServiceId) => Array.from(existing.values()).includes(s);
  const add = (service: ServiceId, confidence: ConfidenceTier, evidence: string) => {
    if (hasService(service)) return;
    mappings.push({ componentId: `pattern-${service.toLowerCase()}`, serviceId: service, confidence, evidence, fromPattern: true });
  };

  // 1. Edge & DNS Ingress for Web/API workloads
  add("Route53", "medium", "Route 53 DNS routing for web domain");
  if (model.components.some((c) => c.type === "frontend" || /react|vue|angular|svelte|next|static/i.test(c.technology))) {
    add("CloudFront", "high", "CloudFront CDN edge distribution");
    add("S3", "high", "S3 static asset storage & hosting");
  }

  // 2. Ingress & Compute
  if (model.components.some((c) => c.type === "backend" || c.type === "api")) {
    add("ALB", "medium", "Application Load Balancer for public ingress");
  }
  if (!COMPUTE_SERVICES.some((s) => hasService(s))) {
    add("ECS", "high", "ECS Fargate managed container host");
  }

  // 3. Observability, Security & IaC
  add("CloudWatch", "high", "CloudWatch logging, alarms, and performance metrics");
  add("SecretsManager", "medium", "Secrets Manager for environment variables and cryptographic keys");
  add("CloudFormation", "low", "CloudFormation / CDK infrastructure definition");

  return mappings;
}

function detectPatternFromComponents(components: ArchitectureComponent[]): PatternId {
  // Simple heuristic for UI label only
  const types = new Set(components.map((c) => c.type));
  const techs = components.map((c) => c.technology.toLowerCase()).join(" ");

  if (types.has("frontend") && !types.has("backend") && !types.has("api")) return "static-site";
  if (techs.includes("lambda") || techs.includes("serverless")) return "serverless-api";
  if (techs.includes("docker") || techs.includes("kubernetes") || techs.includes("ecs") || techs.includes("fargate")) return "containerised-app";
  if (types.has("queue") || types.has("messaging") || techs.includes("sqs") || techs.includes("eventbridge")) return "event-driven";
  if (techs.includes("sagemaker") || techs.includes("tensorflow") || techs.includes("pytorch")) return "ml-pipeline";
  if (types.has("frontend") && (types.has("backend") || types.has("api"))) return "full-stack-web";
  if (techs.includes("kinesis") || techs.includes("redshift") || techs.includes("airflow")) return "data-pipeline";
  return "generic";
}

// ---------------------------------------------------------------------------
// Main mapping function
// ---------------------------------------------------------------------------

export interface ModelContext {
  inputKind: "github_url" | "description";
  grounding: Grounding;
  truncated: boolean;
  parseErrors: string[];
}

export function mapArchitectureModelToServicePlan(
  model: ArchitectureModel,
  ctx: ModelContext
): ServicePlan {
  const componentServices = new Map<string, ServiceId>();
  const awsMappings: AwsServiceMapping[] = [];

  // 1. Map each discovered component to AWS services
  for (const c of model.components) {
    const mapped = mapComponentToAws(c);
    for (const m of mapped) {
      if (!componentServices.has(c.id)) componentServices.set(c.id, m.serviceId);
      // Deduplicate by (componentId, serviceId)
      const exists = awsMappings.some((a) => a.componentId === m.componentId && a.serviceId === m.serviceId);
      if (!exists) awsMappings.push(m);
    }
  }

  // 2. Map technologies from structured lists
  const listMappings = mapListTechnologies(model, componentServices);
  awsMappings.push(...listMappings);

  // 3. Apply pattern baselines (marked fromPattern: true for sanity-check only)
  const patternMappings = applyPatternBaselines(model, componentServices);
  awsMappings.push(...patternMappings);

  // 4. Build DiscoveredComponent output (pass through with status)
  const components: DiscoveredComponent[] = model.components.map((c) => ({
    id: c.id,
    type: c.type,
    technology: c.technology,
    evidence: c.evidence,
    confidence: c.confidence,
    status: c.evidence.length > 0 ? "detected" : "inferred",
  }));

  // 5. Build Relationships output
  const relationships: ComponentRelationship[] = model.relationships.map((r) => ({
    from: r.from,
    to: r.to,
    type: r.type,
  }));

  // 6. Build DeploymentModel per component (inferred, not templated)
  const deploymentModel: DeploymentModel[] = model.components.map((c) => {
    const mapped = componentServices.get(c.id);
    const isCompute = mapped && COMPUTE_SERVICES.includes(mapped);
    const isDatabase = c.type === "database";
    const isCache = c.type === "cache";

    return {
      componentId: c.id,
      public: c.type === "frontend" || c.type === "api",
      needsVpc: Boolean(isCompute || isDatabase || isCache),
      needsMultiAz: Boolean(isDatabase || isCache),
      needsAutoscaling: Boolean(isCompute && (mapped === "ECS" || mapped === "EC2" || mapped === "EKS")),
      source: "recommended" as const,
      notes: isDatabase ? "Production DB → recommend Multi-AZ" : undefined,
    };
  });

  // 7. Detect pattern for UI label (never constrains output)
  const detectedPattern = detectPatternFromComponents(model.components);

  // 8. Build ServicePlan
  const plan = {
    inputKind: ctx.inputKind,
    components,
    relationships,
    deploymentModel,
    awsMappings,
    detectedPattern,
    metadata: {
      grounding: ctx.grounding,
      truncated: ctx.truncated,
      parseErrors: ctx.parseErrors,
    },
  };

  const check = ServicePlanSchema.safeParse(plan);
  if (check.success) return check.data;

  console.warn("[architecture] mapped plan failed validation — using minimal floor");
  const floor = ServicePlanSchema.safeParse({
    inputKind: ctx.inputKind,
    components: [{ id: "fallback", type: "object-storage" as ComponentType, technology: "S3", evidence: [], confidence: "low" as ConfidenceTier, status: "inferred" as const }],
    relationships: [],
    deploymentModel: [],
    awsMappings: [{ componentId: "fallback", serviceId: "S3", confidence: "low" as ConfidenceTier, evidence: "fallback", fromPattern: false }],
    detectedPattern: "generic",
    metadata: { grounding: ctx.grounding, truncated: ctx.truncated, parseErrors: [...ctx.parseErrors, "mapped-plan-validation-failed"] },
  });
  return floor.success ? floor.data : plan as unknown as ServicePlan;
}