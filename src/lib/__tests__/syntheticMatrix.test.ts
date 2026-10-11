/**
 * syntheticMatrix.test.ts — STEP 8: tests on synthetic plans, not repos.
 *
 * Generates plans from the product of traits: computeModel (4) × database
 * (none, relational, document, kv) × frontend (none, static, client-only) ×
 * integrations (0, 1, many) × secrets (yes, no) = 288 combinations.
 *
 * For every combination: the trait-gated policy output matches the Step 4
 * rules, and the invariant validator passes on the built diagram.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ServicePlan,
  ServiceId,
  ThirdPartyIntegration,
} from "../schema.ts";
import { applyInfraPolicy } from "../infraPolicy.ts";
import { buildDiagramElements } from "../diagram.ts";
import { validateDiagram } from "../diagramValidator.ts";
import type { WorkloadTraits, ComputeModel } from "../workloadTraits.ts";

type DbChoice = "none" | "relational" | "document" | "kv";
type FrontendChoice = "none" | "static" | "client-only";
type IntegChoice = 0 | 1 | 3;

const COMPUTE_MODELS: ComputeModel[] = ["container", "vm", "serverless", "none"];
const DBS: DbChoice[] = ["none", "relational", "document", "kv"];
const FRONTENDS: FrontendChoice[] = ["none", "static", "client-only"];
const INTEGS: IntegChoice[] = [0, 1, 3];
const SECRETS = [false, true];

function computeService(model: ComputeModel): ServiceId | null {
  switch (model) {
    case "container":
      return "ECS";
    case "vm":
      return "EC2";
    case "serverless":
      return "Lambda";
    case "none":
      return null;
  }
}

function dbService(db: DbChoice): ServiceId | null {
  switch (db) {
    case "relational":
      return "RDS";
    case "document":
      return "DocumentDB";
    case "kv":
      return "ElastiCache";
    case "none":
      return null;
  }
}

function integrations(n: IntegChoice): ThirdPartyIntegration[] {
  const all: ThirdPartyIntegration[] = [
    { name: "Synthetic Pay", purpose: "Test payment egress", protocol: "HTTPS", category: "payment" },
    { name: "Synthetic Mail", purpose: "Test email egress", protocol: "SMTP", category: "email" },
    { name: "Synthetic Stats", purpose: "Test analytics egress", protocol: "HTTPS", category: "analytics" },
  ];
  return all.slice(0, n);
}

function syntheticPlan(
  model: ComputeModel,
  db: DbChoice,
  frontend: FrontendChoice,
  integ: IntegChoice
): { plan: ServicePlan; traits: WorkloadTraits } {
  const services: ServiceId[] = [];
  const compute = computeService(model);
  if (compute) services.push(compute);
  const dbSvc = dbService(db);
  if (dbSvc) services.push(dbSvc);
  if (frontend === "static") services.push("S3", "CloudFront");
  if (frontend === "client-only") services.push("CloudFront");

  const thirdParty = integrations(integ);
  const plan: ServicePlan = {
    inputKind: "description",
    components: services.map((s) => ({
      id: `svc-${s.toLowerCase()}`,
      type: (s === "RDS" || s === "DocumentDB" ? "database" : s === "ElastiCache" ? "cache" : "backend") as "backend" | "database" | "cache",
      technology: s,
      evidence: ["synthetic"],
      confidence: "high" as const,
      status: "detected" as const,
    })),
    relationships: [],
    deploymentModel: services.map((s) => ({
      componentId: `svc-${s.toLowerCase()}`,
      public: false,
      needsVpc: true,
      needsMultiAz: false,
      needsAutoscaling: false,
      source: "recommended" as const,
      availabilityZones: 1,
      hasLoadBalancer: false,
      secretsManager: false,
      natGateway: false,
      thirdPartyIntegrations: thirdParty,
    })),
    awsMappings: services.map((s) => ({
      componentId: `svc-${s.toLowerCase()}`,
      serviceId: s,
      confidence: "high" as const,
      evidence: "synthetic",
      fromPattern: false,
      category: "repository-evidence" as const,
    })),
    detectedPattern: "generic",
    terminalState: "OK",
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
    warnings: [],
  };

  const traits: WorkloadTraits = {
    servesRequests: model !== "none" && frontend !== "static",
    batchOnly: false,
    staticOnly: frontend === "static",
    computeModel: model,
    hasRelationalDb: db === "relational",
    hasDocumentDb: db === "document",
    hasKvStore: db === "kv",
    hasSecrets: false, // set per-case below
    egressTargets: thirdParty.map((t) => t.name),
    evidence: {},
  };
  return { plan, traits };
}

describe("STEP 8: synthetic trait-product matrix", () => {
  let combos = 0;
  let validatorFailures: string[] = [];
  for (const model of COMPUTE_MODELS) {
    for (const db of DBS) {
      for (const frontend of FRONTENDS) {
        for (const integ of INTEGS) {
          for (const secrets of SECRETS) {
            combos++;
            const { plan, traits } = syntheticPlan(model, db, frontend, integ);
            traits.hasSecrets = secrets;
            const gated = applyInfraPolicy(plan, traits);
            const ids = new Set(gated.awsMappings.map((m) => m.serviceId));

            // Policy outputs match the Step 4 rules.
            assert.strictEqual(
              ids.has("ALB"),
              traits.servesRequests && model !== "none",
              `ALB rule [${model}/${db}/${frontend}/${integ}/${secrets}]`
            );
            assert.strictEqual(
              ids.has("SecretsManager"),
              secrets,
              `secrets rule [${model}/${db}/${frontend}/${integ}/${secrets}]`
            );
            assert.strictEqual(
              ids.has("NATGateway"),
              integ > 0 && model !== "none",
              `NAT rule [${model}/${db}/${frontend}/${integ}/${secrets}]`
            );
            if (db === "relational") {
              const dbDm = gated.deploymentModel.find((d) => d.componentId === "svc-rds");
              assert.strictEqual(
                dbDm?.database?.multiAz,
                true,
                `multi-AZ rule [${model}/${db}/${frontend}/${integ}/${secrets}]`
              );
            }
            if (frontend === "static") {
              assert.ok(ids.has("S3") && ids.has("CloudFront"), `static origin [${model}]`);
            }
            for (const m of gated.awsMappings) {
              if (m.category === "recommendation") {
                assert.ok(
                  m.evidence.startsWith("policy:"),
                  `policy evidence [${model}/${db}/${frontend}/${integ}/${secrets}]`
                );
              }
            }

            // The invariant validator passes for every combination.
            const elements = buildDiagramElements(gated);
            const check = validateDiagram(gated, elements);
            if (!check.pass) {
              validatorFailures.push(
                `[${model}/${db}/${frontend}/${integ}/${secrets}]: ${check.failures.join("; ")}`
              );
            }
          }
        }
      }
    }
  }

  it("covers the full trait product (288 combinations)", () => {
    assert.strictEqual(combos, 4 * 4 * 3 * 3 * 2);
  });

  it("validator passes for every combination", () => {
    assert.deepStrictEqual(validatorFailures.slice(0, 5), []);
  });
});
