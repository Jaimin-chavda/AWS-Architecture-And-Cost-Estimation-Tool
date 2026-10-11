/**
 * productionReadiness.ts — Production Readiness Enforcer
 *
 * Runs after RuleEngine and before diagram generation.
 * Enforces production-grade architecture defaults regardless of pattern.
 * Pure function, no side effects, no network.
 */

import type {
  ServicePlan,
  DeploymentModel,
  ThirdPartyIntegration,
  ServiceId,
  ConfidenceTier,
  MappingCategory,
  ComponentType,
} from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";
import type { WorkloadTraits } from "./workloadTraits.ts";
import { matchIntegration } from "./integrationRegistry.ts";

// ---------------------------------------------------------------------------
// Third-Party Signature Table (items 20-28)
// ---------------------------------------------------------------------------

export interface ThirdPartySignature {
  packagePatterns: RegExp[];
  integration: Omit<ThirdPartyIntegration, "protocol"> & { protocol: "HTTPS" | "SMTP" | "SDK" | "TCP" };
}

/**
 * Maps npm/pip/maven/go/cargo package names to outbound third-party integrations.
 * Each entry produces a ThirdPartyIntegration in the DeploymentModel.
 */
export const THIRD_PARTY_SIGNATURES: ThirdPartySignature[] = [
  // Database
  {
    packagePatterns: [/^mongoose$/, /^mongodb$/, /^pymongo$/, /^mongodb-driver/, /^go-mongo-driver/, /^mongo-go-driver/],
    integration: { name: "MongoDB Atlas", purpose: "Managed MongoDB database", protocol: "HTTPS", category: "database" },
  },
  // Firebase (special-cased to emit 3 integrations)
  {
    packagePatterns: [/^firebase$/, /^firebase-admin$/, /^firebase-functions$/, /^@angular\/fire$/, /^flutterfire/],
    integration: { name: "Firebase Firestore", purpose: "Realtime document database", protocol: "SDK", category: "database" },
  },
  {
    packagePatterns: [/^firebase-auth$/, /^@firebase\/auth$/, /^firebase-admin$/],
    integration: { name: "Firebase Auth", purpose: "Authentication and user management", protocol: "SDK", category: "auth" },
  },
  {
    packagePatterns: [/^firebase-storage$/, /^@firebase\/storage$/],
    integration: { name: "Firebase Storage", purpose: "Object storage for user content", protocol: "SDK", category: "storage" },
  },
  // Payment
  {
    packagePatterns: [/^razorpay$/, /^razorpay-node$/, /^razorpay-python$/],
    integration: { name: "Razorpay", purpose: "Payment gateway", protocol: "HTTPS", category: "payment" },
  },
  {
    packagePatterns: [/^stripe$/, /^@stripe\/stripe-js$/, /^stripe-python$/, /^stripe-go$/],
    integration: { name: "Stripe", purpose: "Payment processing", protocol: "HTTPS", category: "payment" },
  },
  // Email
  {
    packagePatterns: [/^nodemailer$/, /^aws-ses$/, /^@aws-sdk\/client-ses$/, /^boto3.*ses/],
    integration: { name: "Amazon SES", purpose: "Transactional email via SMTP", protocol: "SMTP", category: "email" },
  },
  {
    packagePatterns: [/^@sendgrid\/mail$/, /^sendgrid$/, /^sendgrid-python$/, /^sendgrid-go$/],
    integration: { name: "SendGrid", purpose: "Email API", protocol: "HTTPS", category: "email" },
  },
  // Auth
  {
    packagePatterns: [/^jsonwebtoken$/, /^passport$/, /^oauth$/, /^bcrypt$/, /^next-auth$/, /^@auth\/core$/],
    integration: { name: "JWT/OAuth Provider", purpose: "Authentication tokens and OAuth flows", protocol: "HTTPS", category: "auth" },
  },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function hasPackage(profile: ProjectProfile | undefined, patterns: RegExp[]): boolean {
  if (!profile) return false;
  const allDeps = [
    ...profile.frameworks.map((f) => f.name),
    ...profile.databases.map((d) => d.name),
    ...profile.languages.map((l) => l.name),
    ...profile.infrastructure.map((i) => i.name),
  ].join(" ").toLowerCase();
  // Anchored patterns (/^firebase$/) never match the joined string, so test
  // each whitespace-separated token as well as the full string.
  const tokens = allDeps.split(/[\s,;]+/).filter(Boolean);
  return patterns.some((re) => re.test(allDeps) || tokens.some((t) => re.test(t)));
}

function detectComputeTier(
  combined: string,
  fileNames: string[],
  profile?: ProjectProfile
): "ECS_FARGATE" | "EC2" | "LAMBDA" | "NONE" {
  const hasDockerfile = fileNames.some((f) => /dockerfile/i.test(f));
  const hasDockerCompose = fileNames.some((f) => /docker-compose/i.test(f));

  // Firebase SDK → NONE (serverless, no compute)
  if (hasPackage(profile, [/^firebase$/, /^firebase-admin$/])) {
    return "NONE";
  }

  // Dockerfile → ECS_FARGATE (containerized)
  if (hasDockerfile || hasDockerCompose) {
    return "ECS_FARGATE";
  }

  // Backend frameworks → ECS_FARGATE
  const backendFrameworks = [
    "express", "fastify", "koa", "nestjs", "hono",
    "django", "flask", "fastapi", "starlette",
    "spring boot", "spring webflux", "quarkus", "micronaut",
    "rails", "sinatra", "laravel", "symfony",
    "gin", "echo", "fiber", "chi", "gorilla mux",
    "axum", "actix", "rocket", "asp.net",
  ];
  const text = combined.toLowerCase();
  for (const fw of backendFrameworks) {
    if (text.includes(fw)) {
      return "ECS_FARGATE";
    }
  }

  // Lambda indicators
  if (text.includes("lambda") || text.includes("serverless") || text.includes("aws-lambda")) {
    return "LAMBDA";
  }

  // Default fallback
  return "EC2";
}

function detectDatabaseEngine(combined: string, profile?: ProjectProfile): string | null {
  const text = combined.toLowerCase();

  // Connection strings
  if (/postgres(ql)?:\/\//i.test(text)) return "postgres";
  if (/mysql|mariadb:\/\//i.test(text)) return "mysql";
  if (/sqlite/i.test(text)) return "sqlite";

  // Package evidence
  if (hasPackage(profile, [/^pg$/, /^postgres$/, /^pg-promise$/, /^psycopg2/, /^pgx$/, /^jackc\/pgx/])) return "postgres";
  if (hasPackage(profile, [/^mysql$/, /^mysql2$/, /^mariadb$/, /^pymysql$/, /^go-sql-driver\/mysql/])) return "mysql";
  if (hasPackage(profile, [/^sqlite3$/, /^better-sqlite3$/, /^mattn\/go-sqlite3/, /^modernc\.org\/sqlite/])) return "sqlite";
  if (hasPackage(profile, [/^mongoose$/, /^mongodb$/, /^pymongo$/, /^motor$/, /^mongo-go-driver/])) return "mongodb";

  // Framework defaults
  if (/django|rails|laravel|spring boot/.test(text)) return "postgres";

  return null;
}

function detectAuthLibraries(combined: string, profile?: ProjectProfile): boolean {
  const text = combined.toLowerCase();
  const authKeywords = ["jsonwebtoken", "passport", "oauth", "bcrypt", "next-auth", "@auth/core", "keycloak", "auth0", "okta"];
  for (const kw of authKeywords) {
    if (text.includes(kw)) return true;
  }
  return hasPackage(profile, [/^jsonwebtoken$/, /^passport$/, /^oauth$/, /^bcrypt$/, /^next-auth$/, /^@auth\/core$/]);
}

function mapDatabaseToAws(engine: string | null): string {
  switch (engine) {
    case "postgres": return "RDS_POSTGRES";
    case "mysql": return "RDS_MYSQL";
    case "sqlite": return "RDS_POSTGRES"; // SQLite migrated to Postgres
    case "mongodb": return "MONGODB_ATLAS";
    default: return "RDS_POSTGRES";
  }
}

function scanThirdPartyIntegrations(combined: string, profile?: ProjectProfile): ThirdPartyIntegration[] {
  const integrations: ThirdPartyIntegration[] = [];
  const seen = new Set<string>();

  for (const sig of THIRD_PARTY_SIGNATURES) {
    if (hasPackage(profile, sig.packagePatterns)) {
      const key = `${sig.integration.name}|${sig.integration.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        integrations.push(sig.integration);
      }
    }
  }

  // Special-case: Firebase always emits 3 integrations if any firebase package found
  if (hasPackage(profile, [/^firebase$/, /^firebase-admin$/])) {
    const firebaseIntegrations: ThirdPartyIntegration[] = [
      { name: "Firebase Firestore", purpose: "Realtime document database", protocol: "SDK", category: "database" },
      { name: "Firebase Auth", purpose: "Authentication and user management", protocol: "SDK", category: "auth" },
      { name: "Firebase Storage", purpose: "Object storage for user content", protocol: "SDK", category: "storage" },
    ];
    for (const fi of firebaseIntegrations) {
      const key = `${fi.name}|${fi.category}`;
      if (!seen.has(key)) {
        seen.add(key);
        integrations.push(fi);
      }
    }
  }

  return integrations;
}

// ---------------------------------------------------------------------------
// Main enforcement function (item 8)
// ---------------------------------------------------------------------------

export interface ProductionSignals {
  hasDockerfile: boolean;
  hasDockerCompose: boolean;
  computeTier: "ECS_FARGATE" | "EC2" | "LAMBDA" | "NONE";
  databaseEngine: string | null;
  hasDatabase: boolean;
  hasAuthLibs: boolean;
  thirdPartyIntegrations: ThirdPartyIntegration[];
}

export function extractProductionSignals(
  combined: string,
  fileNames: string[],
  profile?: ProjectProfile
): ProductionSignals {
  const hasDockerfile = fileNames.some((f) => /dockerfile/i.test(f));
  const hasDockerCompose = fileNames.some((f) => /docker-compose/i.test(f));
  const computeTier = detectComputeTier(combined, fileNames, profile);
  const databaseEngine = detectDatabaseEngine(combined, profile);
  const hasDatabase = Boolean(databaseEngine) || (profile?.databases.length ?? 0) > 0;
  const hasAuthLibs = detectAuthLibraries(combined, profile);
  const thirdPartyIntegrations = scanThirdPartyIntegrations(combined, profile);

  return {
    hasDockerfile,
    hasDockerCompose,
    computeTier,
    databaseEngine,
    hasDatabase,
    hasAuthLibs,
    thirdPartyIntegrations,
  };
}

/**
 * Enforces production readiness defaults on the ServicePlan.
 * Runs after RuleEngine produces the baseline plan.
 *
 * Service injection lives in infraPolicy.ts: this function sets
 * deployment-model flags only, gated by workload traits when provided
 * (nothing is injected here unconditionally). Mutates the plan in place
 * and returns it.
 */
export function enforceProductionReadiness(
  plan: ServicePlan,
  signals: ProductionSignals,
  traits?: WorkloadTraits
): ServicePlan {
  // Availability zones: 2 for request-serving backend compute, else 1.
  // Without traits (legacy callers), preserve the previous default of 2.
  const servesCompute =
    !traits || (traits.servesRequests && traits.computeModel !== "none");
  const targetAz = servesCompute ? 2 : 1;

  // Rule 17: Force database.multiAz = true for relational DBs
  const dbEngine = signals.databaseEngine;
  const forceMultiAz = ["postgres", "mysql", "sqlite"].includes(dbEngine ?? "");

  // Load balancer: ECS/EC2 tiers that actually serve requests.
  const tierWantsLb =
    signals.computeTier === "ECS_FARGATE" || signals.computeTier === "EC2";
  const hasLoadBalancer = tierWantsLb && servesCompute;
  const noLoadBalancer = !hasLoadBalancer;

  // Secrets: trait-gated (credential material or sensitive-role egress).
  // Without traits, fall back to the previous database-or-auth heuristic.
  const needsSecretsManager = traits
    ? traits.hasSecrets
    : signals.hasDatabase || signals.hasAuthLibs;

  // NAT: external egress with backend compute. Without traits, preserve the
  // previous third-party-integration heuristic (including Firebase-only).
  const isFirebaseOnly = signals.computeTier === "NONE" && signals.thirdPartyIntegrations.some((i) => i.name.startsWith("Firebase"));
  const needsNatGateway = traits
    ? traits.egressTargets.length > 0 && traits.computeModel !== "none"
    : (signals.thirdPartyIntegrations.length > 0 && signals.computeTier !== "NONE") || isFirebaseOnly;

  // Rule 18: Replace database with production equivalents
  const mappedDatabase = mapDatabaseToAws(dbEngine);

  // Update all deployment models
  for (const dm of plan.deploymentModel) {
    dm.availabilityZones = targetAz;
    dm.hasLoadBalancer = hasLoadBalancer && !noLoadBalancer;
    dm.secretsManager = needsSecretsManager;
    dm.natGateway = needsNatGateway;
    dm.thirdPartyIntegrations = signals.thirdPartyIntegrations;
    dm.computeTier = signals.computeTier;

    // Database-specific config
    const isDbComponent = ["database", "cache"].includes(plan.components.find((c) => c.id === dm.componentId)?.type ?? "");
    if (isDbComponent) {
      dm.database = { multiAz: forceMultiAz };
    }
  }

  // Also add Secrets Manager, NAT Gateway, ALB as explicit awsMappings if not present
  const ensureMapping = (serviceId: ServiceId, evidence: string, confidence: ConfidenceTier = "medium", category: MappingCategory = "recommendation", external?: boolean) => {
    const existing = plan.awsMappings.find((m) => m.serviceId === serviceId);
    if (!existing) {
      const componentId = `svc-${serviceId.toLowerCase()}`;
      plan.awsMappings.push({
        componentId,
        serviceId,
        confidence,
        evidence,
        fromPattern: false,
        category,
        external,
      });
      // Add corresponding component if missing
      if (!plan.components.some((c) => c.id === componentId)) {
        plan.components.push({
          id: componentId,
          type: serviceTypeFromId(serviceId),
          technology: serviceId,
          evidence: [evidence],
          confidence,
          status: "inferred",
        });
      }
    }
  };

  // Service injection is owned by infraPolicy.ts (predicate-gated, with
  // "policy:" evidence). This function only records flags; explicit
  // third-party integrations below stay because each cites detected
  // package evidence, not an unconditional default.

  // Ensure database mapping uses production-grade equivalent
  if (signals.hasDatabase) {
    // Find existing RDS mapping and update its serviceId to production equivalent
    const rdsMapping = plan.awsMappings.find((m) => m.serviceId === "RDS" || m.serviceId === "Aurora");
    if (rdsMapping && mappedDatabase !== "RDS_POSTGRES" && mappedDatabase !== "RDS_MYSQL") {
      // Keep RDS but note the engine in evidence
      rdsMapping.evidence = `${rdsMapping.evidence}; engine: ${mappedDatabase}`;
    }
  }

  // Add third-party integrations as external service mappings.
  // Hosting comes from the registry only: third-party hosted stores stay
  // external (Outbound tier) instead of rendering as in-VPC AWS resources.
  for (const integration of signals.thirdPartyIntegrations) {
    const extServiceId = getExternalServiceId(integration);
    if (extServiceId && !plan.awsMappings.some((m) => m.serviceId === extServiceId)) {
      const hosting = matchIntegration(integration.name)?.hosting;
      ensureMapping(extServiceId, `Third-party: ${integration.name} (${integration.purpose}) via ${integration.protocol}`, "medium", "repository-evidence", hosting === "third-party" ? true : undefined);
    }
  }

  // Update metadata with production readiness flags
  (plan.metadata as any).productionReadiness = {
    availabilityZones: targetAz,
    hasLoadBalancer: hasLoadBalancer && !noLoadBalancer,
    secretsManager: needsSecretsManager,
    natGateway: needsNatGateway,
    databaseMultiAz: forceMultiAz,
    computeTier: signals.computeTier,
    databaseEngine: mappedDatabase,
    thirdPartyIntegrations: signals.thirdPartyIntegrations,
  };

  return plan;
}

function getExternalServiceId(integration: ThirdPartyIntegration): ServiceId | null {
  // Map third-party integrations to AWS external service equivalents
  switch (integration.category) {
    case "database":
      if (integration.name.includes("MongoDB")) return "DocumentDB"; // Atlas equivalent
      return null; // Firebase handled specially
    case "payment":
      return "SES"; // No direct AWS equivalent, but could use SES for notifications
    case "email":
      if (integration.name === "Amazon SES") return "SES";
      return "SES"; // SendGrid equivalent
    case "auth":
      return "Cognito"; // JWT/OAuth provider equivalent
    case "storage":
      return "S3"; // Firebase Storage equivalent
    default:
      return null;
  }
}

function serviceTypeFromId(serviceId: ServiceId): ComponentType {
  const map: Partial<Record<ServiceId, ComponentType>> = {
    SecretsManager: "auth",
    NATGateway: "proxy",
    ALB: "api",
    SES: "messaging",
    Cognito: "auth",
    S3: "object-storage",
    DocumentDB: "database",
  };
  return map[serviceId] ?? "external-service";
}