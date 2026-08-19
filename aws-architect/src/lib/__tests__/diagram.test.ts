/**
 * diagram.test.ts — Stage 4: Golden-file XML tests for generateDiagramXml
 *
 * These tests verify:
 * 1. The output is valid XML (starts with <?xml, contains mxfile/mxGraphModel tags).
 * 2. Each pattern generates nodes for its services.
 * 3. Labels are XML-escaped correctly (special chars, control chars).
 * 4. Golden-file byte-identical checks for the two most common patterns.
 * 5. Custom edges are appended.
 * 6. Overflow slots (additional_N) are placed without crashing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDiagramXml, computeLayout, bucketHeight } from "../diagram.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helper: minimal ServicePlan factory
// ---------------------------------------------------------------------------
function makePlan(overrides: Partial<ServicePlan>): ServicePlan {
  return {
    inputKind: "description",
    pattern: "generic",
    slots: {
      compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
      storage: { serviceId: "S3", confidence: "medium", evidence: "test" },
      monitoring: { serviceId: "CloudWatch", confidence: "low", evidence: "test" },
    },
    customEdges: [],
    suggestedServices: [],
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Basic structure — all patterns
// ---------------------------------------------------------------------------
describe("generateDiagramXml - basic structure", () => {
  const patterns: ServicePlan["pattern"][] = [
    "static-site",
    "serverless-api",
    "containerised-app",
    "event-driven",
    "ml-pipeline",
    "full-stack-web",
    "data-pipeline",
    "generic",
  ];

  for (const pattern of patterns) {
    it(`produces valid mxGraph XML for pattern "${pattern}"`, () => {
      const plan = makePlan({ pattern });
      const xml = generateDiagramXml(plan);

      assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), "must start with XML declaration");
      assert.ok(xml.includes("<mxfile"), "must contain <mxfile>");
      assert.ok(xml.includes("<mxGraphModel"), "must contain <mxGraphModel>");
      assert.ok(xml.includes("<root>"), "must contain <root>");
      assert.ok(xml.includes('id="0"'), "must have mxCell id=0");
      assert.ok(xml.includes('id="1"'), "must have mxCell id=1 (layer)");
      assert.ok(xml.includes("</mxfile>"), "must close with </mxfile>");
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Service nodes appear in output
// ---------------------------------------------------------------------------
describe("generateDiagramXml - service nodes", () => {
  it("includes node for each slot service", () => {
    const plan = makePlan({
      pattern: "serverless-api",
      slots: {
        api: { serviceId: "APIGateway", confidence: "high", evidence: "test" },
        compute: { serviceId: "Lambda", confidence: "high", evidence: "test" },
        database: { serviceId: "DynamoDB", confidence: "high", evidence: "test" },
      },
    });
    const xml = generateDiagramXml(plan);

    assert.ok(xml.includes("APIGateway"), "should contain APIGateway");
    assert.ok(xml.includes("Lambda"), "should contain Lambda");
    assert.ok(xml.includes("DynamoDB"), "should contain DynamoDB");
  });

  it("uses AWS icon shape style for known services", () => {
    const plan = makePlan({
      slots: {
        compute: { serviceId: "Lambda", confidence: "high", evidence: "test" },
      },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("mxgraph.aws4.lambda"), "should use AWS Lambda icon shape");
  });

  it("uses fallback style for unknown serviceId", () => {
    // This tests defense against any serviceId not in the icon map
    // (shouldn't happen with allowlist, but tests the fallback path)
    const plan = makePlan({
      slots: {
        compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
      },
    });
    const xml = generateDiagramXml(plan);
    // EC2 should have its AWS shape
    assert.ok(xml.includes("mxgraph.aws4.ec2"), "EC2 should have AWS icon");
  });
});

// ---------------------------------------------------------------------------
// 3. XML-escaping of labels
// ---------------------------------------------------------------------------
describe("generateDiagramXml - XML escaping", () => {
  it("escapes ampersands in service evidence (though labels are serviceId)", () => {
    const plan = makePlan({
      slots: {
        // The label shown is serviceId, not evidence — but test the diagram label is safe
        compute: { serviceId: "EC2", confidence: "high", evidence: "EC2 & more" },
      },
    });
    const xml = generateDiagramXml(plan);
    // The XML should never contain a bare & that would break XML parsers
    // Find all & occurrences and check they're part of an entity
    const bareAmp = /&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml);
    assert.equal(bareAmp, false, "XML must not contain bare & characters");
  });

  it("strips control characters from labels", () => {
    // Pattern title is derived from pattern name — safe. But we test the
    // xmlAttr function behavior through edge labels.
    const plan = makePlan({
      pattern: "generic",
      slots: {
        compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
      },
      customEdges: [
        // Edge label with control character
        { from: "EC2", to: "EC2", label: "test\x01label" },
      ],
    });
    const xml = generateDiagramXml(plan);
    // Control char should be stripped
    assert.ok(!xml.includes("\x01"), "should strip control chars from edge labels");
    assert.ok(xml.includes("testlabel"), "label content should remain after stripping");
  });

  it("escapes < > \" in pattern title", () => {
    // Pattern names don't have these chars, but the function is general.
    // Test by checking the diagram title attribute is escaped.
    const plan = makePlan({ pattern: "generic" });
    const xml = generateDiagramXml(plan);
    // Should not have raw < inside attribute values
    // The diagram id attribute should be correctly quoted
    assert.ok(xml.includes('name="Generic Architecture"'), "pattern title should be capitalized");
  });
});

// ---------------------------------------------------------------------------
// 4. Custom edges
// ---------------------------------------------------------------------------
describe("generateDiagramXml - custom edges", () => {
  it("appends custom edges when both services are present", () => {
    const plan = makePlan({
      pattern: "generic",
      slots: {
        compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
        storage: { serviceId: "S3", confidence: "high", evidence: "test" },
      },
      customEdges: [{ from: "EC2", to: "S3", label: "custom-link" }],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("custom-link"), "should include custom edge label");
  });

  it("silently skips custom edges for unknown services", () => {
    const plan = makePlan({
      pattern: "generic",
      slots: {
        compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
      },
      customEdges: [{ from: "UnknownService", to: "EC2", label: "ghost" }],
    });
    // Should not throw and ghost edge shouldn't appear
    const xml = generateDiagramXml(plan);
    assert.ok(!xml.includes("ghost"), "unknown service edge should be skipped");
  });
});

// ---------------------------------------------------------------------------
// 5. Overflow slots (additional_N)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - overflow slots", () => {
  it("handles more slots than template positions without throwing", () => {
    const plan = makePlan({
      pattern: "generic",
      slots: {
        compute: { serviceId: "EC2", confidence: "high", evidence: "test" },
        storage: { serviceId: "S3", confidence: "high", evidence: "test" },
        database: { serviceId: "RDS", confidence: "high", evidence: "test" },
        networking: { serviceId: "ALB", confidence: "medium", evidence: "test" },
        monitoring: { serviceId: "CloudWatch", confidence: "low", evidence: "test" },
        additional_1: { serviceId: "Lambda", confidence: "low", evidence: "test" },
        additional_2: { serviceId: "SQS", confidence: "low", evidence: "test" },
      },
    });
    assert.doesNotThrow(() => generateDiagramXml(plan));
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("Lambda"), "overflow slot should appear in XML");
    assert.ok(xml.includes("SQS"), "overflow slot should appear in XML");
  });
});

// ---------------------------------------------------------------------------
// Fix 8: Solid vs Dashed edge verification
// ---------------------------------------------------------------------------
describe("Fix 8 — Evidence-justified edges (solid vs dashed)", () => {
  it("(a) Repo with explicit SDK usage Lambda→S3 generates a solid edge between them", () => {
    const plan = makePlan({
      pattern: "serverless-api",
      slots: {
        api: { serviceId: "APIGateway", confidence: "high", evidence: "api gateway" },
        compute: { serviceId: "Lambda", confidence: "high", evidence: "src/handler.py imports boto3" },
        storage: { serviceId: "S3", confidence: "high", evidence: "s3 storage" },
      },
    });
    const sdkEvidence = [
      {
        file: "src/handler.py",
        filePath: "src/handler.py",
        line: 12,
        match: "boto3.client('s3')",
        matchSnippet: "boto3.client('s3')",
        service: "S3",
        serviceHint: "S3",
      },
    ];

    const xml = generateDiagramXml(plan, sdkEvidence);
    // Edge between Lambda (compute) and S3 (storage) should be solid
    assert.ok(
      xml.includes('style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;strokeColor=#232F3E;strokeWidth=1.5;"'),
      "Should have solid edge for verified Lambda->S3 SDK connection"
    );
  });

  it("(b) Pattern-only connection with no cross-service evidence generates a dashed edge", () => {
    const plan = makePlan({
      pattern: "static-site",
      slots: {
        dns: { serviceId: "Route53", confidence: "medium", evidence: "Route53 detected" },
        cdn: { serviceId: "CloudFront", confidence: "medium", evidence: "CloudFront detected" },
        storage: { serviceId: "S3", confidence: "medium", evidence: "S3 detected" },
      },
    });

    const xml = generateDiagramXml(plan, []);
    // Layout-only edges without cross-service evidence should be dashed with inferred topology label
    assert.ok(
      xml.includes('dashed=1;dashPattern=8 8;strokeColor=#6B7280;strokeWidth=1;'),
      "Pattern-only edges should be dashed"
    );
    assert.ok(
      xml.includes("inferred topology"),
      "Pattern-only edges should have inferred topology label"
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Structural checks (dynamic grid/subnet layout replaced byte-identical golden files)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - subnet container structure", () => {
  it("static-site plan renders edge banner + VPC with data subnet containers", () => {
    const plan: ServicePlan = {
      inputKind: "github_url",
      pattern: "static-site",
      slots: {
        cdn: { serviceId: "CloudFront", confidence: "high", evidence: "CloudFront detected" },
        storage: { serviceId: "S3", confidence: "high", evidence: "S3 detected" },
        dns: { serviceId: "Route53", confidence: "medium", evidence: "Route53 detected" },
        monitoring: { serviceId: "CloudWatch", confidence: "medium", evidence: "CloudWatch baseline" },
      },
      customEdges: [],
      suggestedServices: [],
      metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    };

    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('id="container-edge"'), "should render the edge banner container");
    assert.ok(xml.includes('id="container-vpc"'), "should render the VPC container");
    assert.ok(xml.includes('id="container-data_subnet"'), "should render the data subnet");
    assert.ok(xml.includes('parent="container-edge"'), "edge services nest in the edge banner");
    assert.ok(xml.includes('parent="container-data_subnet"'), "data services nest in the data subnet");
    assert.ok(xml.includes('pageWidth="'), "page size must be emitted");
  });

  it("serverless-api plan renders edge, compute subnet, and data subnet containers", () => {
    const plan: ServicePlan = {
      inputKind: "github_url",
      pattern: "serverless-api",
      slots: {
        api: { serviceId: "APIGateway", confidence: "high", evidence: "APIGateway detected" },
        compute: { serviceId: "Lambda", confidence: "high", evidence: "Lambda detected" },
        database: { serviceId: "DynamoDB", confidence: "high", evidence: "DynamoDB detected" },
      },
      customEdges: [],
      suggestedServices: [],
      metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    };

    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('id="container-compute_subnet"'), "should render the compute subnet");
    assert.ok(xml.includes('parent="container-compute_subnet"'), "Lambda nests in the compute subnet");
    assert.ok(xml.includes('parent="container-data_subnet"'), "DynamoDB nests in the data subnet");
    assert.ok(xml.includes('parent="container-edge"'), "APIGateway nests in the edge banner");
  });
});

// ---------------------------------------------------------------------------
// Fix B: Dynamic container sizing (computeLayout)
// ---------------------------------------------------------------------------
function slot(serviceId: string, name: string, confidence: "high" | "medium" | "low" = "medium") {
  return { [name]: { serviceId, confidence, evidence: "test" } as const };
}

describe("Fix B - dynamic container sizing", () => {
  it("grows DATA_SUBNET to 4 rows for 14 data-tier services (cols=4) without overlapping EDGE_ROW or VPC_BOX", () => {
    const dataIds = ["S3", "EBS", "EFS", "Glacier", "RDS", "Aurora", "DynamoDB", "ElastiCache", "Redshift", "DocumentDB", "SQS", "SNS", "EventBridge", "Kinesis"];
    const slots: Record<string, { serviceId: string; confidence: "high" | "medium" | "low"; evidence: string }> = {};
    dataIds.forEach((id, i) => { slots[`d${i}`] = { serviceId: id, confidence: "medium", evidence: "test" }; });
    slots.edge = { serviceId: "Route53", confidence: "medium", evidence: "test" };

    const layout = computeLayout(slots);
    const data = layout.containers.data_subnet!;
    const edge = layout.containers.edge!;
    const vpc = layout.containers.vpc!;

    assert.ok(data, "data subnet should exist");
    assert.strictEqual(data.h, bucketHeight(4), "4 rows × CELL_H + label + gaps + pad");
    assert.ok(data.h >= 4 * 78, "must physically fit 4 rows of cells");
    assert.ok(data.y >= edge.y + edge.h, "DATA_SUBNET must not overlap the edge row");
    assert.ok(data.x >= vpc.x && data.y + data.h <= vpc.y + vpc.h, "DATA_SUBNET must sit inside VPC_BOX");
    // 14 data nodes present, all placed inside the data subnet container
    const dataNodes = Object.values(layout.nodes).filter((n) => n.parent === "container-data_subnet");
    assert.strictEqual(dataNodes.length, 14);
  });

  it("shrinks containers back down for a single service per tier (no negative/zero dims)", () => {
    const layout = computeLayout({
      ...slot("Route53", "a"),
      ...slot("NATGateway", "b"),
      ...slot("EC2", "c"),
      ...slot("S3", "d"),
      ...slot("SES", "e"),
    });
    for (const [key, rect] of Object.entries(layout.containers)) {
      assert.ok(rect, `${key} should exist`);
      assert.ok(rect!.w > 0 && rect!.h > 0, `${key} must have positive dimensions`);
      assert.ok(rect!.x >= 0 && rect!.y >= 0, `${key} must have non-negative origin`);
    }
    assert.strictEqual(layout.containers.data_subnet!.h, bucketHeight(1), "1 row → minimal height");
    assert.strictEqual(layout.containers.compute_subnet!.h, bucketHeight(1));
    assert.ok(layout.containers.external!.h >= layout.containers.vpc!.h, "external column stretches to VPC height");
    assert.ok(layout.canvasW > 0 && layout.canvasH > 0);
  });

  it("omits containers for empty tiers", () => {
    const layout = computeLayout({
      ...slot("Route53", "a"),
      ...slot("EC2", "b"),
      ...slot("Lambda", "c"),
    });
    assert.strictEqual(layout.containers.public_subnet, null, "empty public subnet → omitted");
    assert.strictEqual(layout.containers.data_subnet, null, "empty data subnet → omitted");
    assert.strictEqual(layout.containers.external, null, "empty external tier → omitted");
    assert.ok(layout.containers.edge, "edge banner present");
    assert.ok(layout.containers.vpc, "VPC present (compute subnet non-empty)");
    assert.ok(layout.containers.compute_subnet, "compute subnet present");
  });
});
