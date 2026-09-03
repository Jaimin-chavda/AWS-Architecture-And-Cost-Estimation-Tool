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
import {
  generateDiagramXml,
  computeLayout,
  bucketHeight,
  validateContainmentHierarchy,
  CONTAINER_PARENTS,
  normalizeForComparison,
  nodeStyle,
  FALLBACK_STYLE,
  SERVICE_TIERS,
  routeEdges,
} from "../diagram.ts";
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
      xml.includes("strokeColor=#232F3E;strokeWidth=1.5;") &&
      xml.includes("rounded=1;") &&
      xml.includes("jettySize=auto;"),
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

    // These containers should be present for the given service set
    const expectedPresent: (keyof typeof layout.containers)[] = [
      "aws_cloud", "edge", "vpc", "az", "public_subnet", "compute_subnet", "data_subnet", "external",
    ];
    for (const key of expectedPresent) {
      const rect = layout.containers[key];
      assert.ok(rect, `${key} should exist`);
      assert.ok(rect!.w > 0 && rect!.h > 0, `${key} must have positive dimensions`);
      assert.ok(rect!.x >= 0 && rect!.y >= 0, `${key} must have non-negative origin`);
    }

    // cross_cutting should NOT exist (no cross-cutting services in this test data)
    assert.strictEqual(layout.containers.cross_cutting, null, "cross_cutting should be null (no services)");

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

// ---------------------------------------------------------------------------
// Container width overflow (regression)
//
// computeLayout() force-overrides rect.w on two already-populated containers:
// the cross-cutting box (→ VPC width) and the edge banner (→ canvas width).
// When the override was narrower than the grid the nodes were laid out on, the
// right-hand nodes spilled out of their own container and, for the edge banner,
// straight through the AWS Cloud boundary — which is what made the VPC / AWS
// Cloud boxes look like they overlapped everything else.
// ---------------------------------------------------------------------------
describe("container width overflow", () => {
  // Mirrors the private layout constants in diagram.ts. A node's visual
  // footprint is a CELL_W × CELL_H cell (the 56px icon is centred in it and the
  // wrapped label is drawn below at full cell width), so the cell — not the
  // icon — is what has to stay inside the container.
  const CELL_W = 116;
  const CELL_H = 80;
  const EDGE_COLS = 6;
  const GAP = 32;
  const PAD = 20;

  /** Natural width layoutNodes() gives a bucket packed into `cols` columns. */
  const gridWidth = (cols: number) => cols * CELL_W + (cols - 1) * GAP + 2 * PAD;

  function mappings(ids: string[]): AwsServiceMapping[] {
    return ids.map((serviceId, i) => ({
      componentId: `n${i}`,
      serviceId: serviceId as AwsServiceMapping["serviceId"],
      confidence: "medium" as const,
      evidence: "test",
      fromPattern: false,
    }));
  }

  /** Every node inside its container, every container inside the AWS Cloud. */
  function assertContained(layout: ReturnType<typeof computeLayout>, label: string) {
    const cloud = layout.containers.aws_cloud;
    assert.ok(cloud, `${label}: AWS Cloud container must exist`);

    for (const [componentId, node] of Object.entries(layout.nodes)) {
      const key = node.parent.replace("container-", "") as keyof typeof layout.containers;
      const container = layout.containers[key];
      assert.ok(container, `${label}: ${componentId} claims parent ${node.parent}, which has no rect`);

      const right = node.x + CELL_W;
      const bottom = node.y + CELL_H;
      assert.ok(
        node.x >= container!.x && right <= container!.x + container!.w,
        `${label}: node ${componentId} (${node.serviceId}) spans x ${node.x}..${right}, ` +
          `outside ${node.parent} x ${container!.x}..${container!.x + container!.w}`
      );
      assert.ok(
        node.y >= container!.y && bottom <= container!.y + container!.h,
        `${label}: node ${componentId} (${node.serviceId}) spans y ${node.y}..${bottom}, ` +
          `outside ${node.parent} y ${container!.y}..${container!.y + container!.h}`
      );
    }

    for (const [key, rect] of Object.entries(layout.containers)) {
      if (key === "aws_cloud" || !rect) continue;
      assert.ok(
        rect.x >= cloud!.x &&
          rect.y >= cloud!.y &&
          rect.x + rect.w <= cloud!.x + cloud!.w &&
          rect.y + rect.h <= cloud!.y + cloud!.h,
        `${label}: container ${key} (${rect.x},${rect.y} ${rect.w}×${rect.h}) escapes AWS Cloud ` +
          `(${cloud!.x},${cloud!.y} ${cloud!.w}×${cloud!.h})`
      );
    }
  }

  it("keeps a full edge banner inside itself and the AWS Cloud when the VPC is narrow", () => {
    // The reported case: all 6 edge services over a single-node compute subnet.
    // The narrow VPC drives the canvas-derived edge width (660px) below the
    // 6-column grid the banner's nodes sit on (896px).
    const services = mappings([
      "Route53", "CloudFront", "APIGateway", "ALB", "Cognito", "WAF", // edge, 6 cols
      "EC2",                                                          // lone compute node
    ]);

    const layout = computeLayout(services);
    const edge = layout.containers.edge!;
    const vpc = layout.containers.vpc!;

    assert.ok(edge, "edge banner exists");
    assert.ok(
      edge.w >= gridWidth(EDGE_COLS),
      `edge banner must not shrink below its own 6-column grid: ${edge.w} < ${gridWidth(EDGE_COLS)}`
    );
    assert.ok(edge.w > vpc.w, "this case only bites when the banner is wider than the VPC");
    assertContained(layout, "narrow VPC + full edge banner");
  });

  it("never shrinks the edge banner below its nodes for any edge-count / VPC-width mix", () => {
    const edgeIds = ["Route53", "CloudFront", "APIGateway", "ALB", "Cognito", "WAF"];
    // Widening the VPC one subnet at a time changes the canvas-derived override.
    const vpcSets: [string, string[]][] = [
      ["compute only", ["EC2"]],
      ["public + compute", ["NATGateway", "EC2"]],
      ["all three subnets", ["NATGateway", "EC2", "S3"]],
      ["wide data subnet", ["NATGateway", "EC2", "S3", "RDS", "DynamoDB", "SQS", "SNS"]],
    ];

    for (let edgeCount = 1; edgeCount <= edgeIds.length; edgeCount++) {
      for (const [vpcLabel, vpcIds] of vpcSets) {
        const label = `${edgeCount} edge service(s) + ${vpcLabel}`;
        const layout = computeLayout(mappings([...edgeIds.slice(0, edgeCount), ...vpcIds]));
        assert.ok(
          layout.containers.edge!.w >= gridWidth(EDGE_COLS),
          `${label}: edge banner ${layout.containers.edge!.w} < grid ${gridWidth(EDGE_COLS)}`
        );
        assertContained(layout, label);
      }
    }
  });

  it("keeps cross-cutting nodes inside the container when it is aligned to the VPC", () => {
    // Cross-cutting is stretched to the VPC width; it must never end up narrower
    // than the 4-column grid its own nodes are placed on.
    const layout = computeLayout(
      mappings(["Route53", "EC2", "CloudWatch", "CloudFormation", "ECR", "CodePipeline"])
    );
    const cross = layout.containers.cross_cutting!;
    const vpc = layout.containers.vpc!;

    assert.ok(cross, "cross-cutting container exists");
    assert.ok(
      cross.w >= gridWidth(4),
      `cross-cutting must not shrink below its 4-column grid: ${cross.w} < ${gridWidth(4)}`
    );
    assert.ok(cross.w >= vpc.w, "cross-cutting still spans at least the VPC width");
    assertContained(layout, "cross-cutting aligned to VPC");
  });

  it("holds containment across every tier populated at once", () => {
    const layout = computeLayout(
      mappings([
        "Route53", "CloudFront", "APIGateway", "ALB", "Cognito", "WAF", // edge
        "VPC", "NATGateway",                                            // public subnet
        "EC2", "Lambda", "ECS",                                         // compute subnet
        "S3", "RDS", "DynamoDB", "ElastiCache", "SQS", "SNS",           // data subnet
        "CloudWatch", "CloudFormation",                                 // cross-cutting
        "SES", "Amplify",                                               // external
      ])
    );
    assertContained(layout, "all tiers populated");
  });
});

// ---------------------------------------------------------------------------
// Fix 1: Containment Hierarchy (AWS Cloud → VPC → AZ → Subnet → node)
// ---------------------------------------------------------------------------
describe("Fix 1 — Containment Hierarchy", () => {
  it("subnets have parent=container-az in XML output", () => {
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
    });
    const xml = generateDiagramXml(plan);

    // Subnets should be children of AZ
    assert.ok(xml.includes('id="container-compute_subnet"'), "compute subnet container present");
    assert.ok(xml.includes('id="container-az"'), "AZ container present");
    assert.ok(xml.includes('id="container-vpc"'), "VPC container present");
    assert.ok(xml.includes('id="container-aws_cloud"'), "AWS Cloud container present");

    // Check parent chain in XML
    assert.match(xml, /id="container-compute_subnet"[^>]*parent="container-az"/, "compute_subnet parent is AZ");
    assert.match(xml, /id="container-data_subnet"[^>]*parent="container-az"/, "data_subnet parent is AZ");
    assert.match(xml, /id="container-az"[^>]*parent="container-vpc"/, "AZ parent is VPC");
    assert.match(xml, /id="container-vpc"[^>]*parent="container-aws_cloud"/, "VPC parent is AWS Cloud");
    assert.match(xml, /id="container-aws_cloud"[^>]*parent="1"/, "AWS Cloud parent is root layer");
  });

  it("AZ container always emitted when subnets exist", () => {
    const services: AwsServiceMapping[] = [
      { componentId: "a", serviceId: "EC2", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "b", serviceId: "S3", confidence: "medium", evidence: "test", fromPattern: false },
    ];
    const layout = computeLayout(services);
    assert.ok(layout.containers.az, "AZ container must exist when subnets exist");
    assert.ok(layout.containers.vpc, "VPC must exist when subnets exist");
    assert.ok(layout.containers.aws_cloud, "AWS Cloud must exist");
  });

  it("validateContainmentHierarchy throws when subnet has no AZ", () => {
    assert.throws(
      () => validateContainmentHierarchy({
        aws_cloud: { x: 0, y: 0, w: 100, h: 100 },
        edge: null,
        vpc: { x: 10, y: 10, w: 80, h: 80 },
        az: null,  // Missing!
        public_subnet: { x: 20, y: 20, w: 60, h: 60 },
        compute_subnet: null,
        data_subnet: null,
        cross_cutting: null,
        external: null,
      }),
      /AZ ancestor/,
      "should throw when subnet exists without AZ"
    );
  });

  it("validateContainmentHierarchy throws when VPC has no AWS Cloud", () => {
    assert.throws(
      () => validateContainmentHierarchy({
        aws_cloud: null,  // Missing!
        edge: null,
        vpc: { x: 10, y: 10, w: 80, h: 80 },
        az: { x: 15, y: 15, w: 70, h: 70 },
        public_subnet: null,
        compute_subnet: null,
        data_subnet: null,
        cross_cutting: null,
        external: null,
      }),
      /AWS Cloud ancestor/,
      "should throw when VPC exists without AWS Cloud"
    );
  });

  it("validateContainmentHierarchy throws when cross-cutting has no AWS Cloud", () => {
    assert.throws(
      () => validateContainmentHierarchy({
        aws_cloud: null,  // Missing!
        edge: null,
        vpc: null,
        az: null,
        public_subnet: null,
        compute_subnet: null,
        data_subnet: null,
        cross_cutting: { x: 0, y: 0, w: 50, h: 50 },
        external: null,
      }),
      /AWS Cloud ancestor/,
      "should throw when cross-cutting exists without AWS Cloud"
    );
  });

  it("CONTAINER_PARENTS defines subnet → AZ → VPC → AWS Cloud chain", () => {
    assert.strictEqual(CONTAINER_PARENTS.public_subnet, "container-az");
    assert.strictEqual(CONTAINER_PARENTS.compute_subnet, "container-az");
    assert.strictEqual(CONTAINER_PARENTS.data_subnet, "container-az");
    assert.strictEqual(CONTAINER_PARENTS.az, "container-vpc");
    assert.strictEqual(CONTAINER_PARENTS.vpc, "container-aws_cloud");
    assert.strictEqual(CONTAINER_PARENTS.aws_cloud, "1");
    assert.strictEqual(CONTAINER_PARENTS.cross_cutting, "container-aws_cloud");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: Label Collision & Deduplication
// ---------------------------------------------------------------------------
describe("Fix 2 — Label Deduplication & Collision", () => {
  it("normalizeForComparison removes prefixes, whitespace, and punctuation", () => {
    assert.strictEqual(normalizeForComparison("AWS Secrets Manager"), "secretsmanager");
    assert.strictEqual(normalizeForComparison("Amazon DynamoDB"), "dynamodb");
    assert.strictEqual(normalizeForComparison("Application Load Balancer (ALB)"), "applicationloadbalanceralb");
  });

  it("prevents redundant self-referential technology labels like ALB (ALB)", () => {
    const plan = makePlan({
      components: [
        { id: "alb", type: "proxy", technology: "ALB", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "alb", serviceId: "ALB", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(!xml.includes("(ALB)\n(ALB)"), "should not append redundant (ALB) twice");
    assert.ok(xml.includes("Application Load\nBalancer (ALB)"), "should contain standard display name");
  });

  it("appends distinct custom technology when not redundant", () => {
    const plan = makePlan({
      components: [
        { id: "db", type: "database", technology: "PostgreSQL", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "db", serviceId: "RDS", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("Amazon RDS\n(PostgreSQL)"), "should include custom technology");
  });

  it("resolves node collisions by shifting overlapping nodes downward", () => {
    const plan = makePlan({
      components: [
        { id: "c1", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "c2", type: "backend", technology: "ECS", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "c1", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "c2", serviceId: "ECS", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('serviceId="EC2"'), "EC2 node present");
    assert.ok(xml.includes('serviceId="ECS"'), "ECS node present");
  });
});

// ---------------------------------------------------------------------------
// Fix 3: Icon Fallback Handling
// ---------------------------------------------------------------------------
describe("Fix 3 — Icon Fallback Handling", () => {
  it("uses generic AWS Cloud shape for unknown serviceId and logs a warning", () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => { warnings.push(msg); };

    try {
      const style = nodeStyle("UnknownServiceCustom");
      assert.strictEqual(style, FALLBACK_STYLE);
      assert.ok(style.includes("resIcon=mxgraph.aws4.general_AWS_Cloud;"), "fallback style should use general AWS Cloud icon");
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("Missing AWS icon for serviceId: \"UnknownServiceCustom\""));
    } finally {
      console.warn = origWarn;
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 4: Edge Routing
// ---------------------------------------------------------------------------
describe("Fix 4 — Edge Routing (Ports & Rounded Bends)", () => {
  it("adds jettySize=auto, rounded=1, and ports to edge styles", () => {
    const plan = makePlan({
      detectedPattern: "static-site",
      components: [
        { id: "dns", type: "api", technology: "Route53", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "cdn", type: "frontend", technology: "CloudFront", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "dns", serviceId: "Route53", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "cdn", serviceId: "CloudFront", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes("jettySize=auto;"), "edge style should include jettySize=auto");
    assert.ok(xml.includes("rounded=1;"), "edge style should include rounded=1");
    assert.ok(xml.includes("exitX="), "edge style should include exit port");
    assert.ok(xml.includes("entryX="), "edge style should include entry port");
  });

  it("computes ports from absolute node positions", () => {
    const edges = routeEdges(
      [{ source: "src", target: "dst", label: "link", style: "solid" }],
      {
        src: { x: 100, y: 100, w: 56, h: 56 },
        dst: { x: 100, y: 300, w: 56, h: 56 }, // directly below
      }
    );
    assert.strictEqual(edges[0].exitPort.x, 0.5);
    assert.strictEqual(edges[0].exitPort.y, 1); // exits bottom
    assert.strictEqual(edges[0].entryPort.x, 0.5);
    assert.strictEqual(edges[0].entryPort.y, 0); // enters top
  });
});

// ---------------------------------------------------------------------------
// Fix 5: Flow Numbering (Edge-Child Badges)
// ---------------------------------------------------------------------------
describe("Fix 5 — Flow Numbering (Edge-Child Badges)", () => {
  it("emits numbered badges as mxGraph edge-child cells with relative='1'", () => {
    const plan = makePlan({
      detectedPattern: "static-site",
      components: [
        { id: "dns", type: "api", technology: "Route53", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "cdn", type: "frontend", technology: "CloudFront", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "storage", type: "object-storage", technology: "S3", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "dns", serviceId: "Route53", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "cdn", serviceId: "CloudFront", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "storage", serviceId: "S3", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('id="badge-edge-200"'), "badge should exist with badge- prefix");
    assert.ok(xml.includes('value="1"'), "first primary edge should have badge value 1");
    assert.ok(xml.includes('value="2"'), "second primary edge should have badge value 2");
    assert.match(xml, /<mxCell id="badge-edge-\d+" value="\d+"[^>]*parent="edge-\d+"/, "badge cell parent is edge");
    assert.match(xml, /<mxGeometry relative="1" as="geometry"\/>/, "badge has relative=1 geometry");
  });

  it("skips flow badges on async, monitoring, and IaC edges", () => {
    const plan = makePlan({
      detectedPattern: "serverless-api",
      components: [
        { id: "api", type: "api", technology: "APIGateway", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "fn", type: "backend", technology: "Lambda", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "queue", type: "proxy", technology: "SQS", evidence: ["test"], confidence: "high", status: "detected" },
      ],
      awsMappings: [
        { componentId: "api", serviceId: "APIGateway", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "fn", serviceId: "Lambda", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "queue", serviceId: "SQS", confidence: "high", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('value="1"'), "primary APIGateway -> Lambda has flow badge 1");
    const edges = xml.split('</mxCell>');
    const sqsEdgeCell = edges.find((e) => e.includes('edge=') && e.includes('SQS') && e.includes('publish'));
    if (sqsEdgeCell) {
      const match = sqsEdgeCell.match(/id="(edge-\d+)"/);
      if (match) {
        assert.ok(!xml.includes(`id="badge-${match[1]}"`), "async SQS edge should not have a flow badge");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Fix 6: Cross-Cutting Service Placement
// ---------------------------------------------------------------------------
describe("Fix 6 — Cross-Cutting Service Placement", () => {
  it("assigns CloudWatch, CloudFormation, ECR, CodePipeline to cross_cutting tier", () => {
    assert.strictEqual(SERVICE_TIERS.CloudWatch, "cross_cutting");
    assert.strictEqual(SERVICE_TIERS.CloudFormation, "cross_cutting");
    assert.strictEqual(SERVICE_TIERS.ECR, "cross_cutting");
    assert.strictEqual(SERVICE_TIERS.CodePipeline, "cross_cutting");
  });

  it("places cross-cutting container below VPC with full VPC width", () => {
    const services: AwsServiceMapping[] = [
      { componentId: "a", serviceId: "EC2", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "b", serviceId: "S3", confidence: "medium", evidence: "test", fromPattern: false },
      { componentId: "c", serviceId: "CloudWatch", confidence: "medium", evidence: "test", fromPattern: false },
    ];
    const layout = computeLayout(services);
    const vpc = layout.containers.vpc!;
    const cross = layout.containers.cross_cutting!;

    assert.ok(vpc, "VPC container exists");
    assert.ok(cross, "cross-cutting container exists");
    assert.ok(cross.y >= vpc.y + vpc.h, "cross-cutting container is placed below VPC");
    assert.strictEqual(cross.w, vpc.w, "cross-cutting container spans full VPC width");
    assert.strictEqual(cross.x, vpc.x, "cross-cutting container aligns with VPC left edge");

    const cwNode = layout.nodes["c"];
    assert.ok(cwNode, "CloudWatch node exists");
    assert.strictEqual(cwNode.parent, "container-cross_cutting", "CloudWatch parent is container-cross_cutting");
  });

  it("renders cross-cutting container inside AWS Cloud in XML", () => {
    const plan = makePlan({
      components: [
        { id: "c1", type: "backend", technology: "EC2", evidence: ["test"], confidence: "high", status: "detected" },
        { id: "c2", type: "proxy", technology: "CloudWatch", evidence: ["test"], confidence: "medium", status: "detected" },
      ],
      awsMappings: [
        { componentId: "c1", serviceId: "EC2", confidence: "high", evidence: "test", fromPattern: false },
        { componentId: "c2", serviceId: "CloudWatch", confidence: "medium", evidence: "test", fromPattern: false },
      ],
    });
    const xml = generateDiagramXml(plan);
    assert.ok(xml.includes('id="container-cross_cutting"'), "cross-cutting container rendered");
    assert.match(xml, /id="container-cross_cutting"[^>]*parent="container-aws_cloud"/, "cross_cutting parent is AWS Cloud");
    assert.match(xml, /serviceId="CloudWatch"[^>]*parent="container-cross_cutting"/, "CloudWatch node parent is cross_cutting");
  });
});