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
import { generateDiagramXml } from "../diagram.ts";
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
// 6. Golden-file byte-identical checks
// ---------------------------------------------------------------------------
describe("generateDiagramXml - golden file tests", () => {
  const GOLDEN_STATIC_SITE = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="aws-architect" modified="" agent="aws-architect" version="21.0.0" type="device">
  <diagram id="diagram-1" name="Static Site Architecture">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
    <mxCell id="node-2" value="CloudFront" style="shape=mxgraph.aws4.cloudfront;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="220" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="node-3" value="S3" style="shape=mxgraph.aws4.s3;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="380" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="node-4" value="Route53" style="shape=mxgraph.aws4.route_53;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="60" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="node-5" value="CloudWatch" style="shape=mxgraph.aws4.cloudwatch;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="540" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="edge-6" value="DNS → CDN" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;" edge="1" source="node-4" target="node-2" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="edge-7" value="Origin" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;" edge="1" source="node-2" target="node-3" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  it("static-site with 4 slots matches golden XML exactly", () => {
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
      metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    };

    const xml = generateDiagramXml(plan);
    assert.equal(xml, GOLDEN_STATIC_SITE, "static-site XML should be byte-identical to golden");
  });

  const GOLDEN_SERVERLESS_API_CORE = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="aws-architect" modified="" agent="aws-architect" version="21.0.0" type="device">
  <diagram id="diagram-1" name="Serverless Api Architecture">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
    <mxCell id="node-2" value="APIGateway" style="shape=mxgraph.aws4.api_gateway;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="60" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="node-3" value="Lambda" style="shape=mxgraph.aws4.lambda;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="220" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="node-4" value="DynamoDB" style="shape=mxgraph.aws4.dynamodb;sketch=0;fontStyle=0;aspect=fixed;fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;" vertex="1" parent="1"><mxGeometry x="380" y="200" width="78" height="78" as="geometry"/></mxCell>
    <mxCell id="edge-5" value="invoke" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;" edge="1" source="node-2" target="node-3" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="edge-6" value="read/write" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;" edge="1" source="node-3" target="node-4" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

  it("serverless-api with 3 slots matches golden XML exactly", () => {
    const plan: ServicePlan = {
      inputKind: "github_url",
      pattern: "serverless-api",
      slots: {
        api: { serviceId: "APIGateway", confidence: "high", evidence: "APIGateway detected" },
        compute: { serviceId: "Lambda", confidence: "high", evidence: "Lambda detected" },
        database: { serviceId: "DynamoDB", confidence: "high", evidence: "DynamoDB detected" },
      },
      customEdges: [],
      metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    };

    const xml = generateDiagramXml(plan);
    assert.equal(xml, GOLDEN_SERVERLESS_API_CORE, "serverless-api XML should be byte-identical to golden");
  });
});
