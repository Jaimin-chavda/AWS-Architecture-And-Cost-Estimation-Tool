/**
 * topologyParity.test.ts — Diagram, cost and template agree on one topology.
 *
 * For synthetic trait-product plans: every Stage 1 mapping is rendered in
 * the diagram, priced (or explicitly noted free) in cost, and every mapped
 * service with a CFT spec gets a template resource — with no invented
 * resources. Quantities follow readTopology (tasks × AZ, DB ×2 Multi-AZ,
 * NAT per AZ).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import type { ServicePlan, ServiceId } from "../schema.ts";
import { applyInfraPolicy } from "../infraPolicy.ts";
import { buildDiagramElements } from "../diagram.ts";
import { validatePlanDiagram } from "../diagramValidator.ts";
import { computeCostRows } from "../cost.ts";
import {
  generateSingleCftYaml,
  CFT_SERVICE_RESOURCE_MAP,
} from "../cftExport.ts";
import { readTopology } from "../topology.ts";
import type { WorkloadTraits, ComputeModel } from "../workloadTraits.ts";

type DbChoice = "none" | "relational" | "document";

const MODELS: ComputeModel[] = ["container", "serverless", "none"];
const DBS: DbChoice[] = ["none", "relational", "document"];
const INTEGS = [0, 1] as const;

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
    case "none":
      return null;
  }
}

function syntheticPlan(
  model: ComputeModel,
  db: DbChoice,
  integ: 0 | 1
): { plan: ServicePlan; traits: WorkloadTraits } {
  const services: ServiceId[] = [];
  const compute = computeService(model);
  if (compute) services.push(compute);
  const dbSvc = dbService(db);
  if (dbSvc) services.push(dbSvc);

  const egressTargets = integ === 1 ? ["Stripe"] : [];
  const plan: ServicePlan = {
    inputKind: "description",
    components: services.map((s) => ({
      id: `svc-${s.toLowerCase()}`,
      type: (s === "RDS" || s === "DocumentDB" ? "database" : "backend") as
        | "backend"
        | "database",
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
      thirdPartyIntegrations: [],
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
    servesRequests: model !== "none",
    batchOnly: false,
    staticOnly: false,
    computeModel: model,
    hasRelationalDb: db === "relational",
    hasDocumentDb: db === "document",
    hasKvStore: false,
    hasSecrets: false,
    egressTargets,
    evidence: {},
  };
  return { plan, traits };
}

describe("topology parity — diagram, cost and template agree", () => {
  it("mappings render, price and provision from one topology", async () => {
    for (const model of MODELS) {
      for (const db of DBS) {
        for (const integ of INTEGS) {
          const tag = `[${model}/${db}/integ=${integ}]`;
          const { plan, traits } = syntheticPlan(model, db, integ);
          const gated = applyInfraPolicy(plan, traits);
          const topo = readTopology(gated);

          // Diagram: every mapping renders; validator holds.
          const elements = buildDiagramElements(gated);
          const rendered = new Set(
            elements.nodes
              .filter(
                (n) =>
                  !n.componentId.startsWith("ext-") &&
                  n.componentId !== "users"
              )
              .map((n) => n.serviceId)
          );
          for (const m of gated.awsMappings) {
            assert.ok(
              rendered.has(m.serviceId),
              `${tag} mapping ${m.serviceId} rendered in diagram`
            );
          }
          const check = validatePlanDiagram(gated);
          assert.strictEqual(
            check.pass,
            true,
            `${tag} validator clean: ${check.failures.join("; ")}`
          );

          // Cost: every mapping priced or explicitly free; every priced
          // row traces back to a mapping (diagram node).
          const cost = await computeCostRows(gated);
          const covered = new Set([
            ...cost.rows.map((r) => r.serviceId),
            ...cost.unpricedRows.map((r) => r.serviceId),
          ]);
          for (const m of gated.awsMappings) {
            assert.ok(
              covered.has(m.serviceId),
              `${tag} mapping ${m.serviceId} priced or noted free`
            );
          }
          const mappedIds = new Set(
            gated.awsMappings.map((m) => m.serviceId)
          );
          for (const r of cost.rows) {
            assert.ok(
              mappedIds.has(r.serviceId as ServiceId),
              `${tag} priced row ${r.serviceId} has a diagram node`
            );
          }

          // Topology quantities: tasks × AZ, Multi-AZ ×2, NAT per AZ.
          if (mappedIds.has("ECS")) {
            const row = cost.rows.find((r) => r.serviceId === "ECS")!;
            const expected =
              (360 * Math.max(topo.computeTasks, 2) * topo.availabilityZones) / 2;
            assert.strictEqual(
              row.quantity,
              expected,
              `${tag} ECS tasks scale across AZs`
            );
          }
          if (mappedIds.has("NATGateway")) {
            const row = cost.rows.find((r) => r.serviceId === "NATGateway")!;
            assert.strictEqual(
              row.quantity,
              720 * topo.availabilityZones,
              `${tag} NAT hours scale per AZ`
            );
          }
          if (db === "relational") {
            const row = cost.rows.find((r) => r.serviceId === "RDS")!;
            assert.strictEqual(
              row.quantity,
              1440,
              `${tag} Multi-AZ RDS doubles instance hours`
            );
          }

          // Template: every mapped service with a CFT spec provisions its
          // primary resource; no resource invents an unmapped service.
          // An empty mapping set degrades to the S3 floor (never a guess).
          const yaml = generateSingleCftYaml(gated);
          const doc = parse(yaml) as any;
          const types = new Set(
            Object.values(doc.Resources ?? {}).map((r: any) => r.Type)
          );
          if (gated.awsMappings.length === 0) {
            assert.ok(
              types.has("AWS::S3::Bucket"),
              `${tag} empty plan degrades to S3 floor`
            );
            continue;
          }
          const allowed = new Set<string>();
          for (const m of gated.awsMappings) {
            if (m.external === true) continue;
            const spec = CFT_SERVICE_RESOURCE_MAP[m.serviceId];
            if (!spec) continue;
            allowed.add(spec.primaryType);
            for (const t of spec.relatedTypes ?? []) allowed.add(t);
            if (m.serviceId === "NATGateway") continue;
            assert.ok(
              types.has(spec.primaryType),
              `${tag} template provisions ${spec.primaryType} for ${m.serviceId}`
            );
          }
          for (const t of types) {
            assert.ok(
              allowed.has(t as string),
              `${tag} template resource ${t} traces to a mapped service`
            );
          }
        }
      }
    }
  });
});
