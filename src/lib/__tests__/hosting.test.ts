/**
 * hosting.test.ts — Step 2: database hosting is read from the registry
 * `hosting` field only.
 *
 * - aws-managed stores render in the data subnet, earn no NAT by themselves.
 * - third-party stores render as external nodes in the Outbound tier, earn
 *   NAT with compute, and chain compute -> NAT -> external.
 * - Cost reports externals as $0 rows; CFT emits no AWS resource for them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTechLabel } from "../integrationRegistry.ts";
import { analyzeProject } from "../repoAnalyzer.ts";
import { runRuleEngine, type RuleInput } from "../ruleEngine.ts";
import { buildDiagramElements, CID } from "../diagram.ts";
import { validatePlanDiagram } from "../diagramValidator.ts";
import { computeCostRows } from "../cost.ts";
import { generateSingleCftYaml } from "../cftExport.ts";
import type { RepoSignals } from "../repoFetcher.ts";
import type { ServicePlan } from "../schema.ts";

function makeSignals(
  files: Array<{ path: string; kind: "manifest" | "container_ci" | "source" | "readme"; content: string }>
): RepoSignals {
  return {
    repoName: "acme/hosting-check",
    defaultBranch: "main",
    keyFiles: files.map((f) => ({
      path: f.path,
      kind: f.kind,
      content: f.content,
      sizeBytes: Buffer.byteLength(f.content, "utf8"),
      truncated: false,
    })),
    truncated: false,
    parseErrors: [],
    readmeLength: 0,
    sdkEvidence: [],
  };
}

function ruleInput(signals: RepoSignals): RuleInput {
  return {
    description: "",
    fileContent: signals.keyFiles
      .filter((f) => f.kind !== "readme")
      .map((f) => `### ${f.path}\n${f.content ?? ""}`)
      .join("\n\n"),
    fileNames: signals.keyFiles.map((f) => f.path),
    inputKind: "github_url",
    grounding: "repo",
    truncated: false,
    parseErrors: [],
    profile: analyzeProject(signals),
  };
}

describe("hosting comes from the registry only", () => {
  it("matchTechLabel resolves hosting without naming technologies in logic", () => {
    assert.strictEqual(matchTechLabel("mongoose")?.hosting, "third-party");
    assert.strictEqual(matchTechLabel("PostgreSQL")?.hosting, "aws-managed");
    assert.strictEqual(matchTechLabel("ioredis")?.hosting, "aws-managed");
    assert.strictEqual(matchTechLabel("some-unknown-thing-xyz"), null);
  });

  it("client-library document store renders external with NAT chain", () => {
    const signals = makeSignals([
      {
        path: "package.json",
        kind: "manifest",
        content: JSON.stringify({ dependencies: { mongoose: "^8.0.0", express: "^4.0.0" } }),
      },
      {
        path: "Dockerfile",
        kind: "container_ci",
        content: "FROM node:20\nCMD [\"node\", \"server.js\"]",
      },
      {
        path: "db.js",
        kind: "source",
        content: "const mongoose = require('mongoose');\nmongoose.connect(process.env.MONGODB_URI);",
      },
    ]);
    const plan = runRuleEngine(ruleInput(signals));
    const doc = plan.awsMappings.find((m) => m.serviceId === "DocumentDB");
    assert.ok(doc, "DocumentDB mapped");
    assert.strictEqual(doc.external, true, "third-party hosted store flagged external");

    const elements = buildDiagramElements(plan);
    const node = elements.nodes.find((n) => n.serviceId === "DocumentDB");
    assert.ok(node, "DocumentDB node rendered");
    assert.strictEqual(node.parent, CID.external, "external store in Outbound tier");
    assert.ok(
      elements.nodes.some((n) => n.serviceId === "NATGateway"),
      "NAT present for external egress with compute"
    );
    const nat = elements.nodes.find((n) => n.serviceId === "NATGateway")!;
    assert.ok(nat.parent.startsWith("container-public-"), "NAT in public subnet");
    const computeId = elements.nodes.find((n) => n.serviceId === "ECS")?.id;
    assert.ok(computeId, "compute present");
    assert.ok(
      elements.routedEdges.some((e) => e.sourceId === computeId && e.targetId === nat.id),
      "compute -> NAT edge drawn"
    );
    assert.ok(
      elements.routedEdges.some((e) => e.sourceId === nat.id && e.targetId === node.id),
      "NAT -> external edge drawn"
    );
    const check = validatePlanDiagram(plan);
    assert.strictEqual(check.pass, true, `validator clean: ${check.failures.join("; ")}`);
  });

  it("compose-defined document store stays in the data subnet without NAT", () => {
    const signals = makeSignals([
      {
        path: "package.json",
        kind: "manifest",
        content: JSON.stringify({ dependencies: { express: "^4.0.0" } }),
      },
      {
        path: "docker-compose.yml",
        kind: "container_ci",
        content: "services:\n  api:\n    build: .\n  mongo:\n    image: mongo:7\n",
      },
    ]);
    const plan = runRuleEngine(ruleInput(signals));
    const doc = plan.awsMappings.find((m) => m.serviceId === "DocumentDB");
    assert.ok(doc, "DocumentDB mapped");
    assert.strictEqual(doc.external, undefined, "self-hosted store not flagged external");

    const elements = buildDiagramElements(plan);
    const node = elements.nodes.find((n) => n.serviceId === "DocumentDB");
    assert.ok(node, "DocumentDB node rendered");
    assert.strictEqual(node.parent, CID.data, "aws-managed store in data subnet");
    assert.ok(
      !elements.nodes.some((n) => n.serviceId === "NATGateway"),
      "no NAT without external egress"
    );
  });

  it("cost reports externals as $0 rows and CFT emits no resource for them", async () => {
    const signals = makeSignals([
      {
        path: "package.json",
        kind: "manifest",
        content: JSON.stringify({ dependencies: { mongoose: "^8.0.0" } }),
      },
      {
        path: "db.js",
        kind: "source",
        content: "mongoose.connect(process.env.MONGODB_URI);",
      },
    ]);
    const plan: ServicePlan = runRuleEngine(ruleInput(signals));
    const doc = plan.awsMappings.find((m) => m.serviceId === "DocumentDB");
    assert.ok(doc?.external, "precondition: external mapping");

    const cost = await computeCostRows(plan);
    const row = cost.rows.find((r) => r.serviceId === "DocumentDB");
    assert.strictEqual(row, undefined, "no priced row for external store");
    const unpriced = cost.unpricedRows.find((r) => r.serviceId === "DocumentDB");
    assert.ok(unpriced, "external store listed as unpriced");
    assert.ok(/External/.test(unpriced.note), "note names external hosting");

    const yaml = generateSingleCftYaml(plan);
    assert.ok(!/DocumentDB|MongoDB|Atlas/i.test(yaml), "no AWS resource emitted for external store");
  });
});
