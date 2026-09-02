/**
 * diagram.test.ts — Stage 4: Golden-file XML tests for generateDiagramXml
 *
 * These tests verify:
 * 1. The output is valid XML (starts with <?xml, contains mxfile/mxGraphModel tags).
 * 2. Each pattern generates nodes for its services.
 * 3. Labels are XML-escaped correctly (special chars, control chars).
 * 4. Custom edges from relationships are appended.
 * 5. New schema structure (components + awsMappings) works correctly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateDiagramXml, computeLayout, bucketHeight } from "../diagram.ts";
import type { ServicePlan, AwsServiceMapping, DiscoveredComponent, ComponentRelationship } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helper: minimal ServicePlan factory (new schema)
// ---------------------------------------------------------------------------
function makePlan(overrides: Partial<ServicePlan>): ServicePlan {
  const components: DiscoveredComponent[] = [
    { id: "comp1", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
    { id: "comp2", type: "object-storage", technology: "S3", evidence: ["test"], confidence: "medium", status: "detected" },
    { id: "comp3", type: "proxy", technology: "CloudWatch", evidence: ["test"], confidence: "low", status: "inferred" },
  ];

  const awsMappings: AwsServiceMapping[] = [
    { componentId: "comp1", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
    { componentId: "comp2", serviceId: "S3", confidence: "medium", evidence: "test", fromPattern: false },
    { componentId: "comp3", serviceId: "CloudWatch", confidence: "low", evidence: "test", fromPattern: false },
  ];

  const relationships: ComponentRelationship[] = [];

  return {
    inputKind: "description",
    components,
    awsMappings,
    relationships,
    deploymentModel: [],
    detectedPattern: "generic",
    metadata: { grounding: "description", truncated: false, parseErrors: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Basic structure — all patterns (detectedPattern for UI label only)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - basic structure", () => {
  const patterns = [
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
      const plan = makePlan({ detectedPattern: pattern });
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
  it("includes node for each awsMapping service", () => {
    const plan = makePlan({
      detectedPattern: "serverless-api",
      components: [
        { id: "api", type: "api", technology: "APIGateway", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "compute", type: "backend", technology: "Lambda", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "db", type: "database", technology: "DynamoDB", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "api", serviceId: "APIGateway", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "compute", serviceId: "Lambda", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "db", serviceId: "DynamoDB", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);

    assert.ok(xml.includes("APIGateway"), "should contain APIGateway");
    assert.ok(xml.includes("Lambda"), "should contain Lambda");
    assert.ok(xml.includes("DynamoDB"), "should contain DynamoDB");
  });

  it("uses AWS icon shape style for known services", () => {
    const plan = makePlan({
      components: [
        { id: "compute", type: "backend", technology: "Lambda", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "compute", serviceId: "Lambda", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("mxgraph.aws4.lambda"), "should use AWS Lambda icon shape");
  });

  it("uses fallback style for unknown serviceId", () => {
    const plan = makePlan({
      components: [
        { id: "compute", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "compute", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("mxgraph.aws4.ec2"), "EC2 should have AWS icon");
  });
});

// ---------------------------------------------------------------------------
// 3. XML-escaping of labels
// ---------------------------------------------------------------------------
describe("generateDiagramXml - XML escaping", () => {
  it("escapes ampersands in service evidence", () => {
    const plan = makePlan({
      components: [
        { id: "compute", type: "backend", technology: "EC2", evidence: ["EC2 & more"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "compute", serviceId: "EC2", confidence: "high", evidence: "EC2 & more", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    const bareAmp = /&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml);
    assert.equal(bareAmp, false, "XML must not contain bare & characters");
  });

  it("strips control characters from labels", () => {
    const plan = makePlan({
      detectedPattern: "generic",
      components: [
        { id: "compute", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "compute", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [
        { from: "compute", to: "compute", type: "test\x01label" },
      ],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(!xml.includes("\x01"), "should strip control chars from edge labels");
    assert.ok(xml.includes("testlabel"), "label content should remain after stripping");
  });

  it("escapes < > \" in pattern title", () => {
    const plan = makePlan({ detectedPattern: "generic" });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('name="Generic Architecture"'), "pattern title should be capitalized");
  });
});

// ---------------------------------------------------------------------------
// 4. Custom edges (from relationships)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - relationships as edges", () => {
  it("appends relationship edges when both services are present", () => {
    const plan = makePlan({
      detectedPattern: "generic",
      components: [
        { id: "comp1", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "comp2", type: "object-storage", technology: "S3", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "comp1", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "comp2", serviceId: "S3", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [{ from: "comp1", to: "comp2", type: "custom-link" }],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("custom-link"), "should include relationship edge label");
  });

  it("silently skips relationship edges for unknown components", () => {
    const plan = makePlan({
      detectedPattern: "generic",
      components: [
        { id: "comp1", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "comp1", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
      ],
      relationships: [{ from: "unknown", to: "comp1", type: "ghost" }],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });
    const xml = generateDiagramXml(plan);
    assert.ok(!xml.includes("ghost"), "unknown component edge should be skipped");
  });
});

// ---------------------------------------------------------------------------
// 5. Many awsMappings (no overflow slots in new schema)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - many services", () => {
  it("handles many awsMappings without throwing", () => {
    const services = [
      "EC2", "S3", "RDS", "ALB", "CloudWatch", "Lambda", "SQS",
      "SNS", "EventBridge", "Kinesis", "DynamoDB", "ElastiCache",
    ];

    const components: DiscoveredComponent[] = services.map((s, i) => ({
      id: `comp${i}`,
      type: "backend" as const,
      technology: s,
      evidence: ["test"],
      confidence: "medium" as const,
      status: "detected" as const,
    }));

    const awsMappings: AwsServiceMapping[] = services.map((s, i) => ({
      componentId: `comp${i}`,
      serviceId: s,
      confidence: "medium" as const,
      evidence: "test",
      fromPattern: false,
    }));

    const plan: ServicePlan = {
      inputKind: "description",
      components,
      awsMappings,
      relationships: [],
      deploymentModel: [],
      detectedPattern: "generic",
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    };

    assert.doesNotThrow(() => generateDiagramXml(plan));
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("Lambda"), "extra service should appear in XML");
    assert.ok(xml.includes("SQS"), "extra service should appear in XML");
  });
});

// ---------------------------------------------------------------------------
// Fix 8: Solid vs Dashed edge verification
// ---------------------------------------------------------------------------
describe("Fix 8 — Evidence-justified edges (solid vs dashed)", () => {
  it("(a) Repo with explicit SDK usage Lambda→S3 generates a solid edge between them", () => {
    const plan = makePlan({
      detectedPattern: "serverless-api",
      components: [
        { id: "api", type: "api", technology: "APIGateway", evidence: ["api gateway"], confidence: "high", status: "detected" },
        { id: "compute", type: "backend", technology: "Lambda", evidence: ["src/handler.py imports boto3"], confidence: "high", status: "detected" },
        { id: "storage", type: "object-storage", technology: "S3", evidence: ["s3 storage"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "api", serviceId: "APIGateway", confidence: "high", evidence: "api gateway", fromPattern: false },
        { componentId: "compute", serviceId: "Lambda", confidence: "high", evidence: "src/handler.py imports boto3", fromPattern: false },
        { componentId: "storage", serviceId: "S3", confidence: "high", evidence: "s3 storage", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
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
    assert.ok(
      xml.includes('style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;strokeColor=#232F3E;strokeWidth=1.5;"'),
      "Should have solid edge for verified Lambda->S3 SDK connection"
    );
  });

  it("(b) Pattern-only connection with no cross-service evidence generates a dashed edge", () => {
    const plan = makePlan({
      detectedPattern: "static-site",
      components: [
        { id: "dns", type: "api", technology: "Route53", evidence: ["Route53 detected"], confidence: "medium", status: "detected" },
        { id: "cdn", type: "frontend", technology: "CloudFront", evidence: ["CloudFront detected"], confidence: "medium", status: "detected" },
        { id: "storage", type: "object-storage", technology: "S3", evidence: ["S3 detected"], confidence: "medium", status: "detected" },
      ],
      awsMappings: [
        { componentId: "dns", serviceId: "Route53", confidence: "medium", evidence: "Route53 detected", fromPattern: false },
        { componentId: "cdn", serviceId: "CloudFront", confidence: "medium", evidence: "CloudFront detected", fromPattern: false },
        { componentId: "storage", serviceId: "S3", confidence: "medium", evidence: "S3 detected", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
      metadata: { grounding: "description", truncated: false, parseErrors: [] },
    });

    const xml = generateDiagramXml(plan, []);
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
// 6. Structural checks (dynamic grid/subnet layout)
// ---------------------------------------------------------------------------
describe("generateDiagramXml - subnet container structure", () => {
  it("static-site plan renders edge banner + VPC with data subnet containers", () => {
    const plan: ServicePlan = {
      inputKind: "github_url",
      detectedPattern: "static-site",
      components: [
        { id: "cdn", type: "frontend", technology: "CloudFront", evidence: ["CloudFront detected"], confidence: "high", status: "detected" },
        { id: "storage", type: "object-storage", technology: "S3", evidence: ["S3 detected"], confidence: "high", status: "detected" },
        { id: "dns", type: "api", technology: "Route53", evidence: ["Route53 detected"], confidence: "medium", status: "detected" },
        { id: "monitoring", type: "proxy", technology: "CloudWatch", evidence: ["CloudWatch baseline"], confidence: "medium", status: "inferred" },
      ],
      awsMappings: [
        { componentId: "cdn", serviceId: "CloudFront", confidence: "high", evidence: "CloudFront detected", fromPattern: false },
        { componentId: "storage", serviceId: "S3", confidence: "high", evidence: "S3 detected", fromPattern: false },
        { componentId: "dns", serviceId: "Route53", confidence: "medium", evidence: "Route53 detected", fromPattern: false },
        { componentId: "monitoring", serviceId: "CloudWatch", confidence: "medium", evidence: "CloudWatch baseline", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
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
      detectedPattern: "serverless-api",
      components: [
        { id: "api", type: "api", technology: "APIGateway", evidence: ["APIGateway detected"], confidence: "high", status: "detected" },
        { id: "compute", type: "backend", technology: "Lambda", evidence: ["Lambda detected"], confidence: "high", status: "detected" },
        { id: "database", type: "database", technology: "DynamoDB", evidence: ["DynamoDB detected"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "api", serviceId: "APIGateway", confidence: "high", evidence: "APIGateway detected", fromPattern: false },
        { componentId: "compute", serviceId: "Lambda", confidence: "high", evidence: "Lambda detected", fromPattern: false },
        { componentId: "database", serviceId: "DynamoDB", confidence: "high", evidence: "DynamoDB detected", fromPattern: false },
      ],
      relationships: [],
      deploymentModel: [],
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
describe("Fix B - dynamic container sizing", () => {
  it("grows DATA_SUBNET to 4 rows for 14 data-tier services (cols=4) without overlapping EDGE_ROW or VPC_BOX", () => {
    const dataIds = ["S3", "EBS", "EFS", "Glacier", "RDS", "Aurora", "DynamoDB", "ElastiCache", "Redshift", "DocumentDB", "SQS", "SNS", "EventBridge", "Kinesis"];
    const services: AwsServiceMapping[] = dataIds.map((id, i) => ({
      componentId: `d${i}`,
      serviceId: id,
      confidence: "medium" as const,
      evidence: "test",
      fromPattern: false,
    }));
    services.push({ componentId: "edge", serviceId: "Route53", confidence: "medium", evidence: "test", fromPattern: false });

    const layout = computeLayout(services);
    const data = layout.containers.data_subnet!;
    const edge = layout.containers.edge!;
    const vpc = layout.containers.vpc!;

    assert.ok(data, "data subnet should exist");
    assert.strictEqual(data.h, bucketHeight(4), "4 rows × CELL_H + label + gaps + pad");
    assert.ok(data.h >= 4 * 78, "must physically fit 4 rows of cells");
    assert.ok(data.y >= edge.y + edge.h, "DATA_SUBNET must not overlap the edge row");
    assert.ok(data.x >= vpc.x && data.y + data.h <= vpc.y + vpc.h, "DATA_SUBNET must sit inside VPC_BOX");
    const dataNodes = Object.values(layout.nodes).filter((n) => n.parent === "container-data_subnet");
    assert.strictEqual(dataNodes.length, 14);
  });

  it("shrinks containers back down for a single service per tier (no negative/zero dims)", () => {
    const services: AwsServiceMapping[] = [
      { componentId: "a", serviceId: "Route53", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "b", serviceId: "NATGateway", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "c", serviceId: "EC2", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "d", serviceId: "S3", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "e", serviceId: "SES", confidence: "medium", evidence: "test", fromPattern: false },
    ];

    const layout = computeLayout(services);
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
    const services: AwsServiceMapping[] = [
      { componentId: "a", serviceId: "Route53", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "b", serviceId: "EC2", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "c", serviceId: "Lambda", confidence: "medium", evidence: "test", fromPattern: false },
    ];

    const layout = computeLayout(services);
    assert.strictEqual(layout.containers.public_subnet, null, "empty public subnet → omitted");
    assert.strictEqual(layout.containers.data_subnet, null, "empty data subnet → omitted");
    assert.strictEqual(layout.containers.external, null, "empty external tier → omitted");
    assert.ok(layout.containers.edge, "edge banner present");
    assert.ok(layout.containers.vpc, "VPC present (compute subnet non-empty)");
    assert.ok(layout.containers.compute_subnet, "compute subnet present");
  });
});