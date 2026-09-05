/**
 * schema.ts
 *
 * Single source of truth for the ServicePlan contract.
 * New design: open component discovery, no pattern/slot constraints.
 * Patterns only participate in final AWS mapping as sanity-check lookup.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Catalog allowlist (~35 services)
// ---------------------------------------------------------------------------
export const SERVICE_IDS = [
  "EC2", "Lambda", "ECS", "EKS", "Fargate", "Lightsail", "Batch",
  "S3", "EBS", "EFS", "Glacier",
  "RDS", "DynamoDB", "ElastiCache", "Aurora", "Redshift", "DocumentDB",
  "CloudFront", "APIGateway", "ALB", "Route53", "VPC", "NATGateway", "WAF",
  "SQS", "SNS", "EventBridge", "Kinesis", "MSK",
  "Cognito", "SecretsManager",
  "CloudWatch", "CodePipeline", "ECR", "CloudFormation",
  "SageMaker", "Rekognition", "Comprehend",
  "OpenSearch",
  "SES", "Amplify",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

// ---------------------------------------------------------------------------
// Service categories
// ---------------------------------------------------------------------------
export const SERVICE_CATEGORIES: Record<ServiceId, string> = {
  EC2: "compute", Lambda: "compute", ECS: "compute", EKS: "compute",
  Fargate: "compute", Lightsail: "compute", Batch: "compute",
  S3: "storage", EBS: "storage", EFS: "storage", Glacier: "storage",
  RDS: "relational_db", Aurora: "relational_db",
  DynamoDB: "nosql_db", DocumentDB: "nosql_db",
  ElastiCache: "cache", Redshift: "warehouse",
  CloudFront: "networking", APIGateway: "networking", ALB: "networking",
  Route53: "networking", VPC: "networking", NATGateway: "networking", WAF: "security",
  SQS: "messaging", SNS: "messaging", EventBridge: "messaging", Kinesis: "messaging", MSK: "messaging",
  Cognito: "auth", SecretsManager: "security",
  CloudWatch: "observability", CodePipeline: "observability", ECR: "observability", CloudFormation: "observability",
  SageMaker: "ml", Rekognition: "ml", Comprehend: "ml",
  OpenSearch: "search",
  SES: "misc", Amplify: "misc",
};

// ---------------------------------------------------------------------------
// Component types (open-ended, no pattern limits)
// ---------------------------------------------------------------------------
export const COMPONENT_TYPES = [
  "frontend", "backend", "api", "worker", "scheduler", "database",
  "cache", "queue", "object-storage", "search", "auth",
  "websocket", "proxy", "external-service", "messaging",
] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Component status
// ---------------------------------------------------------------------------
export const COMPONENT_STATUS = ["detected", "inferred"] as const;
export type ComponentStatus = (typeof COMPONENT_STATUS)[number];

// ---------------------------------------------------------------------------
// Confidence tiers
// ---------------------------------------------------------------------------
export const CONFIDENCE_TIERS = ["high", "medium", "low"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

// ---------------------------------------------------------------------------
// Grounding modes
// ---------------------------------------------------------------------------
export const GROUNDING_VALUES = [
  "repo", "repoFiles", "description", "filenameOnly", "unfounded",
] as const;
export type Grounding = (typeof GROUNDING_VALUES)[number];

// ---------------------------------------------------------------------------
// Discovered Component (open schema, no slot limit)
// ---------------------------------------------------------------------------
export const DiscoveredComponentSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(COMPONENT_TYPES),
  technology: z.string().min(1).max(80),
  evidence: z.array(z.string().max(200)).max(5).default([]),
  confidence: z.enum(CONFIDENCE_TIERS),
  status: z.enum(COMPONENT_STATUS),
});
export type DiscoveredComponent = z.infer<typeof DiscoveredComponentSchema>;

// ---------------------------------------------------------------------------
// Component Relationship (open, no cap)
// ---------------------------------------------------------------------------
export const ComponentRelationshipSchema = z.object({
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  type: z.string().max(40).optional(),
  evidence: z.string().max(200).optional(),
});
export type ComponentRelationship = z.infer<typeof ComponentRelationshipSchema>;

// ---------------------------------------------------------------------------
// Deployment Model per component (inferred, not templated)
// ---------------------------------------------------------------------------
export const DeploymentModelSchema = z.object({
  componentId: z.string(),
  public: z.boolean(),
  needsVpc: z.boolean(),
  needsMultiAz: z.boolean(),
  needsAutoscaling: z.boolean(),
  /** "detected" = explicit config found (e.g. k8s replicas); "recommended" = heuristic */
  source: z.enum(["detected", "recommended"]),
  notes: z.string().max(200).optional(),
});
export type DeploymentModel = z.infer<typeof DeploymentModelSchema>;

export const MAPPING_CATEGORIES = [
  "repository-evidence",
  "deployment-requirement",
  "inference",
  "recommendation",
] as const;
export type MappingCategory = (typeof MAPPING_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Evidence Record (grounded evidence inventory item)
// ---------------------------------------------------------------------------
export const EvidenceRecordSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(["manifest", "iac", "code", "sdk", "readme", "path", "description"]),
  sourcePath: z.string().min(1).max(250),
  technology: z.string().min(1).max(100).optional(),
  detail: z.string().min(1).max(500),
  confidence: z.enum(CONFIDENCE_TIERS),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

// ---------------------------------------------------------------------------
// AWS Service Mapping (one per component, patterns as lookup only)
// ---------------------------------------------------------------------------
export const AwsServiceMappingSchema = z.object({
  componentId: z.string(),
  serviceId: z.enum(SERVICE_IDS),
  confidence: z.enum(CONFIDENCE_TIERS),
  evidence: z.string().max(200),
  /** If true, this mapping came from a pattern lookup table (sanity-check only) */
  fromPattern: z.boolean().default(false),
  category: z.enum(MAPPING_CATEGORIES).optional(),
});
export type AwsServiceMapping = z.infer<typeof AwsServiceMappingSchema>;

// ---------------------------------------------------------------------------
// Root ServicePlan (new design)
// ---------------------------------------------------------------------------
export const ServicePlanSchema = z.object({
  inputKind: z.enum(["github_url", "description"]),
  /** Open array — no max length, no pattern slots */
  components: z.array(DiscoveredComponentSchema),
  relationships: z.array(ComponentRelationshipSchema),
  deploymentModel: z.array(DeploymentModelSchema),
  awsMappings: z.array(AwsServiceMappingSchema),
  /** Pattern detection for UI label only — never constrains output */
  detectedPattern: z.string().optional(),
  proposalTitle: z.string().optional(),
  tradeOffDimension: z.string().optional(),
  tradeOffDescription: z.string().optional(),
  metadata: z.object({
    grounding: z.enum(GROUNDING_VALUES),
    truncated: z.boolean(),
    parseErrors: z.array(z.string()),
  }),
  proposals: z.array(z.any()).optional(),
});

export type ServicePlan = z.infer<typeof ServicePlanSchema> & {
  proposals?: ServicePlan[];
};