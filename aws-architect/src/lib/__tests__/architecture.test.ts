/**
 * architecture.test.ts
 *
 * Tests for the central reasoning layer: ArchitectureModel validation/
 * normalization and the deterministic model → ServicePlan mapping.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/architecture.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateArchitectureModel,
  mapArchitectureModelToServicePlan,
} from "../architecture.ts";
import type { ArchitectureModel, ModelContext } from "../architecture.ts";
import { SERVICE_IDS, ServicePlanSchema } from "../schema.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CTX: ModelContext = {
  inputKind: "github_url",
  grounding: "repoFiles",
  truncated: false,
  parseErrors: [],
};

function serviceIds(plan: ServicePlan): string[] {
  return plan.awsMappings.map((m) => m.serviceId);
}

/** Minimal ArchitectureComponent — fills in the new optional-but-defaulted fields. */
function comp(
  id: string,
  name: string,
  type: ArchitectureModel["components"][number]["type"],
  technology: string,
  confidence: "high" | "medium" | "low" = "medium"
): ArchitectureModel["components"][number] {
  return { id, name, type, technology, confidence, evidence: [] };
}

function makeModel(overrides: Partial<ArchitectureModel> = {}): ArchitectureModel {
  return {
    appType: "full-stack-web",
    appName: "my-app",
    description: "A React frontend with an Express API and a Postgres database.",
    components: [
      comp("web", "Web UI", "frontend", "React"),
      comp("api", "API Server", "backend", "Express"),
      comp("db", "Database", "database", "PostgreSQL"),
    ],
    languages: ["TypeScript", "JavaScript"],
    frameworks: ["React", "Express"],
    databases: ["PostgreSQL"],
    apis: [],
    externalServices: [],
    dependencies: ["pg", "express"],
    buildConfig: [],
    relationships: [
      { from: "web", to: "api", type: "calls" },
      { from: "api", to: "db", type: "reads" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation + normalization
// ---------------------------------------------------------------------------

describe("validateArchitectureModel", () => {
  it("accepts a valid model and normalizes it", () => {
    const model = validateArchitectureModel(makeModel());
    assert.ok(model, "Valid model should pass validation");
    assert.strictEqual(model!.appType, "full-stack-web");
    assert.strictEqual(model!.components.length, 3);
  });

  it("rejects a model with an invalid appType", () => {
    const bad = makeModel({ appType: "not-a-pattern" as ArchitectureModel["appType"] });
    assert.strictEqual(validateArchitectureModel(bad), null);
  });

  it("rejects a model with an invalid component type", () => {
    const bad = makeModel({
      components: [
        comp("web", "Web UI", "not-a-type" as ArchitectureModel["components"][number]["type"], "React"),
      ],
    });
    assert.strictEqual(validateArchitectureModel(bad), null);
  });

  it("dedupes duplicate string arrays case-insensitively", () => {
    const model = validateArchitectureModel(
      makeModel({ languages: ["typescript", "TypeScript", "python", "typescript"] })
    );
    assert.deepStrictEqual(model!.languages, ["typescript", "python"]);
  });

  it("drops relationships that reference unknown component ids", () => {
    const model = validateArchitectureModel(
      makeModel({
        relationships: [
          { from: "web", to: "api", type: "calls" },
          { from: "ghost", to: "api", type: "calls" },
        ],
      })
    );
    assert.strictEqual(model!.relationships.length, 1);
    assert.strictEqual(model!.relationships[0].from, "web");
  });
});

// ---------------------------------------------------------------------------
// Deterministic service mapping
// ---------------------------------------------------------------------------

describe("mapArchitectureModelToServicePlan", () => {
  it("maps a static site to S3 + CloudFront under the static-site pattern", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "static-site",
        components: [comp("site", "Site", "frontend", "Gatsby")],
      }),
      CTX
    );
    assert.strictEqual(plan.detectedPattern, "static-site");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("S3"), "static site needs S3");
    assert.ok(ids.includes("CloudFront"), "static site needs CloudFront");
  });

  it("maps a serverless API (Lambda + DynamoDB) deterministically", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "serverless-api",
        components: [
          comp("fn", "Handlers", "backend", "AWS Lambda (Node.js)"),
          comp("db", "Table", "database", "DynamoDB"),
        ],
        databases: ["DynamoDB"],
      }),
      CTX
    );
    assert.strictEqual(plan.detectedPattern, "serverless-api");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda from serverless backend component");
    assert.ok(ids.includes("APIGateway"), "APIGateway from serverless pattern");
    assert.ok(ids.includes("DynamoDB"), "DynamoDB from database component");
    assert.ok(ids.includes("CloudWatch"), "CloudWatch for compute presence");
  });

  it("maps PostgreSQL to RDS and a plain backend to ECS", () => {
    const plan = mapArchitectureModelToServicePlan(makeModel(), CTX);
    const ids = serviceIds(plan);
    assert.ok(ids.includes("RDS"), "PostgreSQL → RDS");
    assert.ok(ids.includes("ECS"), "Express backend → managed container host");
  });

  it("maps Redis database component to ElastiCache", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        components: [
          comp("api", "API Server", "backend", "Express"),
          comp("cache", "Cache", "database", "Redis"),
        ],
        databases: ["Redis"],
      }),
      CTX
    );
    assert.ok(serviceIds(plan).includes("ElastiCache"), "Redis → ElastiCache");
  });

  it("turns component relationships into relationships between services", () => {
    const plan = mapArchitectureModelToServicePlan(makeModel(), CTX);
    assert.ok(plan.relationships.length >= 1, "relationships should be preserved");
    const hasApiToDb = plan.relationships.some(
      (e) => e.from === "api" && e.to === "db"
    );
    assert.ok(hasApiToDb, "api→db 'reads' relationship should surface as an edge");
  });

  it("does NOT map external SaaS components to AWS services", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        components: [
          comp("api", "API Server", "backend", "Express"),
          comp("pay", "Payments", "external_service", "Stripe"),
        ],
        externalServices: ["Stripe"],
      }),
      CTX
    );
    assert.ok(!serviceIds(plan).includes("Stripe"), "external SaaS must not become a service");
    // external_service components don't map to AWS services
  });

  it("keeps every serviceId on the catalog allowlist and never exceeds 12", () => {
    const model = validateArchitectureModel(makeModel())!;
    const plan = mapArchitectureModelToServicePlan(model, CTX);
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "mapped plan must satisfy the ServicePlan contract");
    const allowlist = new Set<string>(SERVICE_IDS);
    for (const id of serviceIds(plan)) {
      assert.ok(allowlist.has(id), `${id} must be on the catalog allowlist`);
    }
    assert.ok(new Set(serviceIds(plan)).size <= 12, "never exceed 12 distinct services");
  });

  it("returns a valid generic floor when no component maps to a service", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "generic",
        components: [
          comp("misc", "Misc", "other", "plain scripts"),
        ],
        databases: [],
        frameworks: [],
        languages: [],
        buildConfig: [],
        dependencies: [],
        externalServices: [],
        apis: [],
        relationships: [],
      }),
      CTX
    );
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, "floor plan must be schema-valid");
    assert.strictEqual(plan.detectedPattern, "generic");
    assert.ok(serviceIds(plan).includes("S3"), "generic floor includes S3");
  });

  it("maps a scheduler component to ECS + EventBridge (containerised context)", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "containerised-app",
        components: [
          comp("api", "API", "backend", "Express"),
          comp("job", "Daily Report", "scheduler", "custom cron job"),
        ],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    assert.ok(ids.includes("ECS"), "scheduler in container context → ECS");
    assert.ok(ids.includes("EventBridge"), "scheduler → EventBridge trigger");
  });

  it("maps a scheduler component to Lambda + EventBridge (serverless context)", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "serverless-api",
        components: [
          comp("fn", "Handler", "backend", "AWS Lambda"),
          comp("job", "Nightly Job", "scheduler", "AWS Lambda scheduled"),
        ],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda from scheduler in serverless context");
    assert.ok(ids.includes("EventBridge"), "EventBridge from scheduler");
  });

  it("ArchitectureComponent evidence and confidence survive round-trip validation", () => {
    const model = validateArchitectureModel(
      makeModel({
        components: [
          {
            id: "api",
            name: "API Server",
            type: "backend",
            technology: "Express",
            evidence: ["package.json → express", "src/app.ts → new express()"],
            confidence: "high",
          },
          comp("db", "Database", "database", "PostgreSQL"),
        ],
      })
    );
    assert.ok(model, "model should validate");
    const api = model!.components.find((c) => c.id === "api");
    assert.ok(api, "api component should exist");
    assert.deepStrictEqual(api!.evidence, ["package.json → express", "src/app.ts → new express()"]);
    assert.strictEqual(api!.confidence, "high");
  });

  it("full-stack with frontend + api + postgres + redis + worker + queue → 6 distinct components map to 6 AWS services", () => {
    // Scenario 2 from the task: 6 distinct components must NOT collapse
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "full-stack-web",
        components: [
          comp("fe",     "React Frontend",  "frontend",  "React"),
          comp("api",    "Express API",     "backend",   "Express"),
          comp("db",     "Postgres DB",     "database",  "PostgreSQL"),
          comp("cache",  "Redis Cache",     "cache",     "Redis"),
          comp("worker", "Background Worker","worker",   "custom"),
          comp("queue",  "Task Queue",      "queue",     "Bull/BullMQ"),
        ],
        databases: ["PostgreSQL", "Redis"],
      }),
      CTX
    );
    const ids = serviceIds(plan);
    // Each distinct component type must produce its own AWS service
    assert.ok(ids.includes("CloudFront"), `frontend → CloudFront; got ${ids.join(", ")}`);
    assert.ok(ids.includes("ECS"),        `backend/worker → ECS; got ${ids.join(", ")}`);
    assert.ok(ids.includes("RDS"),        `postgres → RDS; got ${ids.join(", ")}`);
    assert.ok(ids.includes("ElastiCache"),`redis cache → ElastiCache; got ${ids.join(", ")}`);
    assert.ok(ids.includes("SQS"),        `queue → SQS; got ${ids.join(", ")}`);
    // Plan must still pass schema validation
    const check = ServicePlanSchema.safeParse(plan);
    assert.ok(check.success, `Plan must satisfy ServicePlan schema: ${!check.success ? JSON.stringify(check.error.issues) : ""}`);
  });
});