/**
 * schema.ts
 *
 * Single source of truth for the ServicePlan contract.
 * The same schema is used by:
 *   - RuleEngine (produces it)
 *   - LLMClient (generateObject target — Stage 2)
 *   - DiagramGenerator (consumes it — Stage 3/4)
 *   - CostService (consumes it — Stage 5)
 *   - /api/analyze route (validates it at the boundary)
 *
 * Decision 2: one JSON contract `ServicePlan` drives both diagram and cost.
 * Decision 16: output contract = single zod ServicePlan schema, identical for every provider.
 * Decision 17: catalog allowlist (~30–40 fixed service enum).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Catalog allowlist (Decision 17)
// ~35 services; hallucinated IDs are rejected at the safeParse gate.
// To add a service: append here + add rules in ruleEngine.ts + pricing in Stage 5.
// ---------------------------------------------------------------------------
export const SERVICE_IDS = [
  // Compute
  "EC2",
  "Lambda",
  "ECS",
  "EKS",
  "Fargate",
  "Lightsail",
  "Batch",
  // Storage
  "S3",
  "EBS",
  "EFS",
  "Glacier",
  // Database
  "RDS",
  "DynamoDB",
  "ElastiCache",
  "Aurora",
  "Redshift",
  "DocumentDB",
  // Networking
  "CloudFront",
  "APIGateway",
  "ALB",
  "Route53",
  "VPC",
  "NATGateway",
  // Messaging / Async
  "SQS",
  "SNS",
  "EventBridge",
  "Kinesis",
  // Auth / Identity
  "Cognito",
  // DevOps / Observability
  "CloudWatch",
  "CodePipeline",
  "ECR",
  // AI / ML
  "SageMaker",
  "Rekognition",
  "Comprehend",
  // Misc
  "SES",
  "Amplify",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

// ---------------------------------------------------------------------------
// Service categories — used for gap detection during LLM result filtering.
// If the LLM result covers compute but not storage, rules fill only storage.
// ---------------------------------------------------------------------------
export const SERVICE_CATEGORIES: Record<ServiceId, string> = {
  EC2: "compute", Lambda: "compute", ECS: "compute", EKS: "compute",
  Fargate: "compute", Lightsail: "compute", Batch: "compute",
  S3: "storage", EBS: "storage", EFS: "storage", Glacier: "storage",
  RDS: "database", DynamoDB: "database", ElastiCache: "database",
  Aurora: "database", Redshift: "database", DocumentDB: "database",
  CloudFront: "networking", APIGateway: "networking", ALB: "networking",
  Route53: "networking", VPC: "networking", NATGateway: "networking",
  SQS: "messaging", SNS: "messaging", EventBridge: "messaging", Kinesis: "messaging",
  Cognito: "auth",
  CloudWatch: "observability", CodePipeline: "observability", ECR: "observability",
  SageMaker: "ml", Rekognition: "ml", Comprehend: "ml",
  SES: "misc", Amplify: "misc",
};

// ---------------------------------------------------------------------------
// Architecture pattern templates (Decision in PROJECT.md — 5–8 patterns).
// These drive diagram layout (Stage 3/4) and slot validation.
// ---------------------------------------------------------------------------
export const PATTERN_IDS = [
  "static-site",
  "serverless-api",
  "containerised-app",
  "event-driven",
  "ml-pipeline",
  "full-stack-web",
  "data-pipeline",
  "generic",
] as const;

export type PatternId = (typeof PATTERN_IDS)[number];

// ---------------------------------------------------------------------------
// Confidence tiers (Decision 19: description-grounded capped at "low")
// ---------------------------------------------------------------------------
export const CONFIDENCE_TIERS = ["high", "medium", "low"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

// ---------------------------------------------------------------------------
// Grounding modes (Decision 39: input_kind != grounding — they may differ)
// ---------------------------------------------------------------------------
export const GROUNDING_VALUES = ["repo", "description"] as const;
export type Grounding = (typeof GROUNDING_VALUES)[number];

// ---------------------------------------------------------------------------
// Per-slot entry: one service in one named slot of the pattern template
// ---------------------------------------------------------------------------
export const ServiceSlotSchema = z.object({
  /** Must be in SERVICE_IDS — allowlist gate enforced by ServicePlanSchema.refine */
  serviceId: z.string(),
  confidence: z.enum(CONFIDENCE_TIERS),
  /** Short human-readable note on why this service was inferred */
  evidence: z.string().max(200),
});
export type ServiceSlot = z.infer<typeof ServiceSlotSchema>;

// ---------------------------------------------------------------------------
// Custom edge (for hybrid/unclassifiable patterns — flagged for manual review)
// ---------------------------------------------------------------------------
export const CustomEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  label: z.string().max(80).optional(),
});
export type CustomEdge = z.infer<typeof CustomEdgeSchema>;

// ---------------------------------------------------------------------------
// Metadata block
// ---------------------------------------------------------------------------
export const ServicePlanMetadataSchema = z.object({
  grounding: z.enum(GROUNDING_VALUES),
  /** True if any fetched file was size- or count-capped */
  truncated: z.boolean(),
  /** Paths of files that failed to parse (YAML/JSON errors) */
  parseErrors: z.array(z.string()),
});
export type ServicePlanMetadata = z.infer<typeof ServicePlanMetadataSchema>;

// ---------------------------------------------------------------------------
// Root ServicePlan schema
// Decision 2: one contract for diagram + cost.
// slots is a Record<slotName, ServiceSlot>; slotNames are pattern-specific.
// Max 12 distinct services (flaw 3 bound).
// ---------------------------------------------------------------------------
export const ServicePlanSchema = z
  .object({
    /** Mirrors the input_kind that started this request */
    inputKind: z.enum(["github_url", "description"]),
    pattern: z.enum(PATTERN_IDS),
    /**
     * Named slots for the chosen pattern template.
     * Keys are slot names (e.g. "frontend", "api", "database").
     * Values are ServiceSlot objects.
     */
    slots: z.record(z.string(), ServiceSlotSchema),
    /**
     * Additional edges for hybrid/unclassifiable repos.
     * Flagged in the UI as requiring manual review.
     */
    customEdges: z.array(CustomEdgeSchema),
    metadata: ServicePlanMetadataSchema,
  })
  .refine(
    (plan) => {
      // Catalog allowlist gate (Decision 17): every serviceId must be in SERVICE_IDS
      const ids = Object.values(plan.slots).map((s) => s.serviceId);
      return ids.every((id) => (SERVICE_IDS as readonly string[]).includes(id));
    },
    {
      message:
        "ServicePlan contains one or more serviceIds not in the catalog allowlist",
    }
  )
  .refine(
    (plan) => {
      // Max 12 distinct services (flaw 3 bound)
      const unique = new Set(Object.values(plan.slots).map((s) => s.serviceId));
      return unique.size <= 12;
    },
    { message: "ServicePlan may not contain more than 12 distinct services" }
  );

export type ServicePlan = z.infer<typeof ServicePlanSchema>;
