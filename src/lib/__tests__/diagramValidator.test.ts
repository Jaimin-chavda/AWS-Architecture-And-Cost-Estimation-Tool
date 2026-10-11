/**
 * diagramValidator.test.ts — Step 6/7: the invariant validator runs in
 * npm test and fails diagrams it should fail, with cell ids attached.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDiagramElements, CID, type DiagramElements } from "../diagram.ts";
import { validateDiagram, validatePlanDiagram } from "../diagramValidator.ts";
import type { ServicePlan } from "../schema.ts";

function miniPlan(): ServicePlan {
  return {
    inputKind: "github_url",
    components: [
      { id: "cdn", type: "frontend", technology: "CloudFront", evidence: ["t"], confidence: "high", status: "detected" },
      { id: "api", type: "backend", technology: "ECS", evidence: ["t"], confidence: "high", status: "detected" },
      { id: "db", type: "database", technology: "RDS", evidence: ["t"], confidence: "high", status: "detected" },
    ],
    relationships: [{ from: "api", to: "db", type: "reads/writes" }],
    deploymentModel: [
      { componentId: "api", public: true, needsVpc: true, needsMultiAz: false, needsAutoscaling: false, source: "recommended", availabilityZones: 1, hasLoadBalancer: false, secretsManager: false, natGateway: false, thirdPartyIntegrations: [] },
    ],
    awsMappings: [
      { componentId: "cdn", serviceId: "CloudFront", confidence: "high", evidence: "t", fromPattern: false, category: "repository-evidence" },
      { componentId: "api", serviceId: "ECS", confidence: "high", evidence: "t", fromPattern: false, category: "repository-evidence" },
      { componentId: "db", serviceId: "RDS", confidence: "high", evidence: "t", fromPattern: false, category: "repository-evidence" },
    ],
    detectedPattern: "generic",
    terminalState: "OK",
    metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    warnings: [],
  };
}

describe("validator passes honest diagrams", () => {
  it("mini edge/compute/data plan validates clean", () => {
    const check = validatePlanDiagram(miniPlan());
    assert.strictEqual(check.pass, true, `expected clean: ${check.failures.join("; ")}`);
  });
});

describe("validator fails bad diagrams with cell ids", () => {
  function elementsWith(opts: {
    waypoints?: Array<{ x: number; y: number }>;
    labelOffset?: { x: number; y: number };
  }): DiagramElements {
    const elements = buildDiagramElements(miniPlan());
    const edge = elements.routedEdges.find(
      (e) =>
        elements.nodes.find((n) => n.id === e.sourceId)?.serviceId === "ECS" &&
        elements.nodes.find((n) => n.id === e.targetId)?.serviceId === "RDS"
    );
    assert.ok(edge, "precondition: compute -> data edge exists");
    if (opts.waypoints) edge.waypoints = opts.waypoints;
    if (opts.labelOffset) {
      edge.labelOffsetX = opts.labelOffset.x;
      edge.labelOffsetY = opts.labelOffset.y;
    }
    return elements;
  }

  it("fails an edge segment crossing a non-endpoint node, naming edge and node", () => {
    const elements = elementsWith({});
    const edge = elements.routedEdges[0];
    const victim = elements.nodes.find((n) => n.id !== edge.sourceId && n.id !== edge.targetId)!;
    // Drag the whole polyline through the victim's icon center.
    const placed = Object.values(elements.layout.nodes).find((e) => e.componentId === victim.componentId)!;
    const mid = { x: placed.x + 30, y: placed.y + 4 + 28 };
    edge.waypoints = [mid, mid];
    const check = validateDiagram(miniPlan(), elements);
    assert.strictEqual(check.pass, false, "crossing edge must fail");
    assert.ok(
      check.failures.some((f) => f.includes(`"${edge.id}"`) && f.includes(`"${victim.componentId}"`)),
      `failure names edge and node cells: ${check.failures.join("; ")}`
    );
  });

  it("fails an edge label overlapping a node label box", () => {
    const elements = elementsWith({});
    const edge = elements.routedEdges[0];
    const victim = elements.nodes.find((n) => n.id !== edge.sourceId && n.id !== edge.targetId)!;
    const victimPlaced = Object.values(elements.layout.nodes).find(
      (e) => e.componentId === victim.componentId
    )!;
    const victimLines = Math.max(1, victim.label.split("\n").length);
    const vc = {
      x: victimPlaced.x + 30,
      y: victimPlaced.y + 4 + 56 + 4 + (victimLines * 14) / 2,
    };
    // Keep the routed path; shove the label anchor onto the victim label
    // center via the recorded offset.
    const src = elements.nodes.find((n) => n.id === edge.sourceId)!;
    const dst = elements.nodes.find((n) => n.id === edge.targetId)!;
    const s = Object.values(elements.layout.nodes).find((e) => e.componentId === src.componentId)!;
    const t = Object.values(elements.layout.nodes).find((e) => e.componentId === dst.componentId)!;
    const pts = [
      { x: s.x + 30, y: s.y + 4 + 28 },
      ...edge.waypoints,
      { x: t.x + 30, y: t.y + 4 + 28 },
    ];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    }
    let acc = 0;
    let mid = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (acc + len >= total / 2) {
        const k = len === 0 ? 0 : (total / 2 - acc) / len;
        mid = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
        break;
      }
      acc += len;
    }
    edge.labelOffsetX = Math.round(vc.x - mid.x);
    edge.labelOffsetY = Math.round(vc.y - mid.y);
    const check = validateDiagram(miniPlan(), elements);
    assert.ok(
      check.failures.some((f) => f.includes("label overlaps") && f.includes(`"${edge.id}"`)),
      `label overlap must fail with edge id: ${check.failures.join("; ")}`
    );
  });

  it("fails a segment crossing an isolation container with no endpoint inside", () => {
    const elements = elementsWith({});
    const priv2 = Object.entries(elements.layout.containers).find(([id]) =>
      id.startsWith("container-private-2")
    );
    if (!priv2 || !priv2[1]) {
      // Single-AZ mini plan has no AZ-2; synthesize the container + crossing.
      elements.layout.containers["container-private-2"] = { x: 2000, y: 2000, w: 400, h: 300 };
      elements.layout.canvasW = Math.max(elements.layout.canvasW, 2500);
      elements.layout.canvasH = Math.max(elements.layout.canvasH, 2500);
    }
    const edge = elements.routedEdges[0];
    edge.waypoints = [
      { x: 2050, y: 1900 },
      { x: 2350, y: 2400 },
    ];
    const check = validateDiagram(miniPlan(), elements);
    assert.ok(
      check.failures.some((f) => f.includes("container-private-2") && f.includes(`"${edge.id}"`)),
      `container crossing must fail with ids: ${check.failures.join("; ")}`
    );
  });

  it("fails a labelled edge with no horizontal segment", () => {
    const elements = elementsWith({});
    const edge = elements.routedEdges.find((e) => e.label.trim().length > 0)!;
    const src = elements.nodes.find((n) => n.id === edge.sourceId)!;
    const dst = elements.nodes.find((n) => n.id === edge.targetId)!;
    const s = Object.values(elements.layout.nodes).find((e) => e.componentId === src.componentId)!;
    const t = Object.values(elements.layout.nodes).find((e) => e.componentId === dst.componentId)!;
    // Pure diagonal, no horizontal run.
    edge.waypoints = [{ x: Math.round((s.x + t.x) / 2), y: Math.round((s.y + t.y) / 2) }];
    const check = validateDiagram(miniPlan(), elements);
    assert.ok(
      check.failures.some((f) => f.includes(`"${edge.id}"`) && f.includes("horizontal")),
      `diagonal-only label must fail: ${check.failures.join("; ")}`
    );
  });

  it("fails a global-edge node rendered inside the VPC", () => {
    const plan = miniPlan();
    const elements = buildDiagramElements(plan);
    const cdn = elements.nodes.find((n) => n.serviceId === "CloudFront")!;
    const vpc = elements.layout.containers[CID.vpc]!;
    // Move the node geometry inside the VPC as well as its parent string.
    const placed = Object.values(elements.layout.nodes).find((e) => e.componentId === cdn.componentId)!;
    placed.x = Math.round(vpc.x + vpc.w / 2);
    placed.y = Math.round(vpc.y + vpc.h / 2);
    placed.parent = CID.vpc;
    cdn.parent = CID.vpc;
    const check = validateDiagram(plan, elements);
    assert.ok(
      check.failures.some((f) => f.includes("CloudFront") && f.includes("inside the VPC")),
      `scope violation must fail: ${check.failures.join("; ")}`
    );
  });
});
