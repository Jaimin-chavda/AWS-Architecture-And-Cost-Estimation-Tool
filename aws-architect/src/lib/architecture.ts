/**
 * architecture.ts  —  The central reasoning layer (Architecture Model)
 *
 * This module is the single source of truth between "what the repository
 * actually contains" and "which AWS services the deployment needs".
 *
 * Pipeline position:
 *   RepoSignals / description → LLM (llmClient) → ArchitectureModel
 *     → validateArchitectureModel() → mapArchitectureModelToServicePlan()
 *     → ServicePlan → diagram.ts + cost.ts
 *
 * Downstream components (AWS mapping, diagram, cost) consume ONLY this model
 * (via the derived ServicePlan). No downstream component re-reads raw repo
 * content or re-infers the project structure independently.
 *
 * The LLM describes the APPLICATION, not AWS: components use real tech names
 * ("PostgreSQL", "Express"), and AWS service selection happens deterministically
 * in mapArchitectureModelToServicePlan(). This replaces the previous two-way
 * pipeline where the LLM and the rule engine each independently inferred AWS
 * services and their results were merged.
 */

import { z } from "zod";
import {
  PATTERN_IDS,
  ServicePlanSchema,
} from "./schema.ts";
import type {
  ServicePlan,
  PatternId,
  ServiceId,
  ConfidenceTier,
  Grounding,
  CustomEdge,
} from "./schema.ts";
import { assignSlots } from "./ruleEngine.ts";
import type { DetectedService } from "./ruleEngine.ts";

// ---------------------------------------------------------------------------
// Architecture Model schema
// ---------------------------------------------------------------------------

export const COMPONENT_TYPES = [
  "frontend",
  "backend",
  "worker",
  "database",
  "cache",
  "queue",
  "api",
  "external_service",
  "auth",
  "storage",
  "monitoring",
  "other",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

export const ArchitectureComponentSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  type: z.enum(COMPONENT_TYPES),
  /** Actual technology the component is built with (e.g. "Next.js", "PostgreSQL") — never an AWS service name */
  technology: z.string().min(1).max(80),
  details: z.string().max(200).optional(),
});
export type ArchitectureComponent = z.infer<typeof ArchitectureComponentSchema>;

export const ArchitectureRelationshipSchema = z.object({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  type: z.string().max(40).optional(),
});
export type ArchitectureRelationship = z.infer<typeof ArchitectureRelationshipSchema>;

/**
 * The structured model of the whole application as a system.
 * Produced by the LLM (llmClient), validated/normalized here, and consumed
 * by mapArchitectureModelToServicePlan().
 */
export const ArchitectureModelSchema = z.object({
  /** Best-fitting deployment pattern — reuses the ServicePlan pattern set */
  appType: z.enum(PATTERN_IDS),
  appName: z.string().max(120),
  description: z.string().max(600),
  components: z.array(ArchitectureComponentSchema).min(1).max(40),
  languages: z.array(z.string().max(40)).max(20),
  frameworks: z.array(z.string().max(40)).max(20),
  databases: z.array(z.string().max(40)).max(10),
  apis: z.array(z.string().max(80)).max(20),
  /** Non-AWS SaaS the app depends on (Stripe, Auth0, Twilio, SendGrid, ...) */
  externalServices: z.array(z.string().max(80)).max(20),
  dependencies: z.array(z.string().max(80)).max(40),
  /** Build/deployment configuration detected (Docker, CI/CD, serverless.yml, terraform, ...) */
  buildConfig: z.array(z.string().max(80)).max(20),
  /** Runtime relationships between components (from/to are component ids) */
  relationships: z.array(ArchitectureRelationshipSchema).max(40),
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

/** Normalizes a valid model: trims, dedupes, and drops dangling relationship refs. */
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

/**
 * Validates raw LLM output against the ArchitectureModelSchema.
 * Returns null on any schema violation (caller falls back to rules baseline).
 */
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
// ---------------------------------------------------------------------------

const COMPUTE_SERVICES: ServiceId[] = ["Lambda", "EC2", "ECS", "EKS", "Fargate", "Batch", "Lightsail"];

interface ComponentMapping {
  service: ServiceId;
  confidence: ConfidenceTier;
  evidence: string;
}

function componentServicesFor(c: ArchitectureComponent, appType: PatternId): ComponentMapping[] {
  const tech = `${c.name} ${c.technology} ${c.details ?? ""}`;
  const lower = tech.toLowerCase();
  const ev = `component ${c.name} (${c.technology})`;

  switch (c.type) {
    case "database":
      if (/dynamo/.test(lower)) return [{ service: "DynamoDB", confidence: "high", evidence: ev }];
      if (/mongo/.test(lower)) return [{ service: "DocumentDB", confidence: "high", evidence: ev }];
      if (/redis|memcached/.test(lower)) return [{ service: "ElastiCache", confidence: "high", evidence: ev }];
      if (/aurora/.test(lower)) return [{ service: "Aurora", confidence: "high", evidence: ev }];
      return [{ service: "RDS", confidence: "high", evidence: ev }];
    case "cache":
      return [{ service: "ElastiCache", confidence: "medium", evidence: ev }];
    case "queue":
      return [{ service: "SQS", confidence: "high", evidence: ev }];
    case "storage":
      return [{ service: "S3", confidence: "high", evidence: ev }];
    case "auth":
      return [{ service: "Cognito", confidence: "high", evidence: ev }];
    case "monitoring":
      return [{ service: "CloudWatch", confidence: "medium", evidence: ev }];
    case "frontend":
      if (appType === "static-site") {
        return [
          { service: "S3", confidence: "high", evidence: ev },
          { service: "CloudFront", confidence: "medium", evidence: ev },
        ];
      }
      return [{ service: "CloudFront", confidence: "low", evidence: ev }];
    case "backend":
      if (/serverless|lambda/.test(lower)) {
        return [
          { service: "Lambda", confidence: "high", evidence: ev },
          { service: "APIGateway", confidence: "medium", evidence: ev },
        ];
      }
      if (/container|docker|kubernetes|k8s|ecs|fargate|eks/.test(lower)) {
        return [{ service: "ECS", confidence: "medium", evidence: ev }];
      }
      if (/ec2|virtual machine|vm|instance/.test(lower)) {
        return [{ service: "EC2", confidence: "high", evidence: ev }];
      }
      // Managed container host for a plain backend service
      return [{ service: "ECS", confidence: "low", evidence: ev }];
    case "worker":
      if (/serverless|lambda/.test(lower)) {
        return [{ service: "Lambda", confidence: "high", evidence: ev }];
      }
      return [{ service: "ECS", confidence: "medium", evidence: ev }];
    case "api":
      return [{ service: "APIGateway", confidence: "medium", evidence: ev }];
    case "external_service":
    case "other":
      return []; // SaaS / uncategorised — no AWS mapping
  }
}

function detectServicesFromModel(
  model: ArchitectureModel
): { services: DetectedService[]; componentServices: Map<string, ServiceId> } {
  const services: DetectedService[] = [];
  const componentServices = new Map<string, ServiceId>();
  const add = (service: ServiceId, confidence: ConfidenceTier, evidence: string) => {
    if (services.some((d) => d.serviceId === service)) return;
    services.push({ serviceId: service, confidence, evidence: evidence.slice(0, 200) });
  };
  const hasService = (s: ServiceId) => services.some((d) => d.serviceId === s);

  // Primary pass: components drive the mapping.
  for (const c of model.components) {
    const mapped = componentServicesFor(c, model.appType);
    if (mapped.length === 0) continue;
    if (!componentServices.has(c.id)) componentServices.set(c.id, mapped[0].service);
    for (const m of mapped) add(m.service, m.confidence, m.evidence);
  }

  // Secondary pass: structured lists catch technologies the LLM listed but
  // did not model as components.
  const listText = [
    ...model.databases,
    ...model.frameworks,
    ...model.buildConfig,
    ...model.languages,
  ].join(" ").toLowerCase();

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

  // Pattern baselines — mirror the rule engine's pattern guarantees.
  if (model.appType === "static-site") {
    add("S3", "medium", "static-site pattern → S3 for hosting");
    add("CloudFront", "medium", "static-site pattern → CloudFront CDN");
  }
  if (model.appType === "serverless-api") {
    if (!hasService("Lambda")) add("Lambda", "medium", "serverless-api pattern → Lambda compute");
    if (!hasService("APIGateway")) add("APIGateway", "medium", "serverless-api pattern → API Gateway entry point");
  }
  if (
    (model.appType === "containerised-app" || model.appType === "full-stack-web" || model.appType === "event-driven") &&
    !COMPUTE_SERVICES.some((s) => hasService(s))
  ) {
    add("ECS", "low", `${model.appType} pattern → ECS container host (no orchestrator specified)`);
  }

  // Observability: CloudWatch only when there is active compute.
  if (COMPUTE_SERVICES.some((s) => hasService(s))) {
    add("CloudWatch", "medium", "CloudWatch monitoring for compute services");
  }

  return { services, componentServices };
}

function modelToCustomEdges(
  model: ArchitectureModel,
  componentServices: Map<string, ServiceId>
): CustomEdge[] {
  const edges: CustomEdge[] = [];
  const seen = new Set<string>();
  for (const rel of model.relationships) {
    const from = componentServices.get(rel.from);
    const to = componentServices.get(rel.to);
    if (!from || !to || from === to) continue;
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, label: rel.type ?? undefined });
  }
  return edges.slice(0, 20);
}

export interface ModelContext {
  inputKind: "github_url" | "description";
  grounding: Grounding;
  truncated: boolean;
  parseErrors: string[];
}

/**
 * Maps a validated ArchitectureModel to a ServicePlan.
 * This is the ONLY place AWS services are chosen from the model — downstream
 * (diagram, cost) consume the resulting ServicePlan.
 */
export function mapArchitectureModelToServicePlan(
  model: ArchitectureModel,
  ctx: ModelContext
): ServicePlan {
  const { services, componentServices } = detectServicesFromModel(model);

  let pattern: PatternId = model.appType;
  if (services.length === 0) {
    // Nothing mappable — generic floor with a usable (if minimal) diagram.
    pattern = "generic";
    services.push(
      { serviceId: "S3", confidence: "low", evidence: "architecture model produced no mappable services" },
      { serviceId: "CloudWatch", confidence: "low", evidence: "architecture model produced no mappable services" }
    );
  }

  const capped = services.slice(0, 12);
  const slots = assignSlots(pattern, capped);
  const customEdges = modelToCustomEdges(model, componentServices);

  const plan = {
    inputKind: ctx.inputKind,
    pattern,
    slots,
    customEdges,
    suggestedServices: [],
    metadata: {
      grounding: ctx.grounding,
      truncated: ctx.truncated,
      parseErrors: ctx.parseErrors,
    },
  };

  const check = ServicePlanSchema.safeParse(plan);
  if (check.success) return check.data;

  // Defense-in-depth: should be unreachable; generic floor if it somehow isn't.
  console.warn("[architecture] mapped plan failed validation — using generic floor");
  const floor = ServicePlanSchema.safeParse({
    inputKind: ctx.inputKind,
    pattern: "generic",
    slots: {
      storage: { serviceId: "S3", confidence: "low", evidence: "mapped plan failed validation" },
      monitoring: { serviceId: "CloudWatch", confidence: "low", evidence: "mapped plan failed validation" },
    },
    customEdges: [],
    suggestedServices: [],
    metadata: { grounding: ctx.grounding, truncated: ctx.truncated, parseErrors: [...ctx.parseErrors, "mapped-plan-validation-failed"] },
  });
  return floor.success ? floor.data : plan as unknown as ServicePlan;
}