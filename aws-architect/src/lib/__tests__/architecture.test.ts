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
  return Object.values(plan.slots).map((s) => s.serviceId);
}

function makeModel(overrides: Partial<ArchitectureModel> = {}): ArchitectureModel {
  return {
    appType: "full-stack-web",
    appName: "my-app",
    description: "A React frontend with an Express API and a Postgres database.",
    components: [
      { id: "web", name: "Web UI", type: "frontend", technology: "React" },
      { id: "api", name: "API Server", type: "backend", technology: "Express" },
      { id: "db", name: "Database", type: "database", technology: "PostgreSQL" },
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
        { id: "web", name: "Web UI", type: "not-a-type" as ArchitectureModel["components"][number]["type"], technology: "React" },
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
        components: [{ id: "site", name: "Site", type: "frontend", technology: "Gatsby" }],
      }),
      CTX
    );
    assert.strictEqual(plan.pattern, "static-site");
    const ids = serviceIds(plan);
    assert.ok(ids.includes("S3"), "static site needs S3");
    assert.ok(ids.includes("CloudFront"), "static site needs CloudFront");
  });

  it("maps a serverless API (Lambda + DynamoDB) deterministically", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        appType: "serverless-api",
        components: [
          { id: "fn", name: "Handlers", type: "backend", technology: "AWS Lambda (Node.js)" },
          { id: "db", name: "Table", type: "database", technology: "DynamoDB" },
        ],
        databases: ["DynamoDB"],
      }),
      CTX
    );
    assert.strictEqual(plan.pattern, "serverless-api");
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
          { id: "api", name: "API Server", type: "backend", technology: "Express" },
          { id: "cache", name: "Cache", type: "database", technology: "Redis" },
        ],
        databases: ["Redis"],
      }),
      CTX
    );
    assert.ok(serviceIds(plan).includes("ElastiCache"), "Redis → ElastiCache");
  });

  it("turns component relationships into customEdges between services", () => {
    const plan = mapArchitectureModelToServicePlan(makeModel(), CTX);
    assert.ok(plan.customEdges.length >= 1, "relationships should produce custom edges");
    const hasApiToDb = plan.customEdges.some(
      (e) => e.to === "RDS" && e.label === "reads"
    );
    assert.ok(hasApiToDb, "api→db 'reads' relationship should surface as an edge");
  });

  it("does NOT map external SaaS components to AWS services", () => {
    const plan = mapArchitectureModelToServicePlan(
      makeModel({
        components: [
          { id: "api", name: "API Server", type: "backend", technology: "Express" },
          { id: "pay", name: "Payments", type: "external_service", technology: "Stripe" },
        ],
        externalServices: ["Stripe"],
      }),
      CTX
    );
    assert.ok(!serviceIds(plan).includes("Stripe"), "external SaaS must not become a service");
    assert.ok(!serviceIds(plan).includes("APIGateway"), "external_service component must not map to AWS");
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
          { id: "misc", name: "Misc", type: "other", technology: "plain scripts" },
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
    assert.strictEqual(plan.pattern, "generic");
    assert.ok(serviceIds(plan).includes("S3"), "generic floor includes S3");
  });
});