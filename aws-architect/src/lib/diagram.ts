/**
 * diagram.ts — Stage 4 (BuildOrder step 3–4)
 *
 * Pure function: ServicePlan → mxGraph XML (.drawio format).
 *
 * Design decisions:
 * - No external dependencies; pure string generation.
 * - AWS icon styles use shape=mxgraph.aws4.* with a fallback to a plain rectangle.
 * - Labels are XML-escaped and control characters are stripped.
 * - Each of the 8 pattern templates has a fixed layout that places nodes in a
 *   meaningful left-to-right / top-to-bottom arrangement.
 * - Custom edges (from ServicePlan.customEdges) are appended after template edges.
 *
 * Exported:
 *   generateDiagramXml(plan: ServicePlan): string — the main entry point.
 */

import type { ServicePlan, PatternId } from "./schema.ts";

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00–0x1F except TAB/LF/CR) from a string */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Escapes a string for safe use inside an XML attribute value */
function xmlAttr(s: string): string {
  return stripControlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// AWS icon shape names (shape=mxgraph.aws4.*)
// Fallback: plain rectangle with AWS orange fill.
// ---------------------------------------------------------------------------

const AWS_ICON_STYLES: Partial<Record<string, string>> = {
  // Compute
  EC2: "shape=mxgraph.aws4.ec2;",
  Lambda: "shape=mxgraph.aws4.lambda;",
  ECS: "shape=mxgraph.aws4.ecs;",
  EKS: "shape=mxgraph.aws4.eks;",
  Fargate: "shape=mxgraph.aws4.fargate;",
  Lightsail: "shape=mxgraph.aws4.lightsail;",
  Batch: "shape=mxgraph.aws4.batch;",
  // Storage
  S3: "shape=mxgraph.aws4.s3;",
  EBS: "shape=mxgraph.aws4.ebs;",
  EFS: "shape=mxgraph.aws4.efs;",
  Glacier: "shape=mxgraph.aws4.glacier;",
  // Database
  RDS: "shape=mxgraph.aws4.rds;",
  DynamoDB: "shape=mxgraph.aws4.dynamodb;",
  ElastiCache: "shape=mxgraph.aws4.elasticache;",
  Aurora: "shape=mxgraph.aws4.aurora;",
  Redshift: "shape=mxgraph.aws4.redshift;",
  DocumentDB: "shape=mxgraph.aws4.documentdb;",
  // Networking
  CloudFront: "shape=mxgraph.aws4.cloudfront;",
  APIGateway: "shape=mxgraph.aws4.api_gateway;",
  ALB: "shape=mxgraph.aws4.application_load_balancer;",
  Route53: "shape=mxgraph.aws4.route_53;",
  VPC: "shape=mxgraph.aws4.vpc;",
  NATGateway: "shape=mxgraph.aws4.nat_gateway;",
  // Messaging
  SQS: "shape=mxgraph.aws4.sqs;",
  SNS: "shape=mxgraph.aws4.sns;",
  EventBridge: "shape=mxgraph.aws4.eventbridge;",
  Kinesis: "shape=mxgraph.aws4.kinesis;",
  // Auth
  Cognito: "shape=mxgraph.aws4.cognito;",
  // DevOps / Observability
  CloudWatch: "shape=mxgraph.aws4.cloudwatch;",
  CodePipeline: "shape=mxgraph.aws4.codepipeline;",
  ECR: "shape=mxgraph.aws4.ecr;",
  // AI / ML
  SageMaker: "shape=mxgraph.aws4.sagemaker;",
  Rekognition: "shape=mxgraph.aws4.rekognition;",
  Comprehend: "shape=mxgraph.aws4.comprehend;",
  // Misc
  SES: "shape=mxgraph.aws4.ses;",
  Amplify: "shape=mxgraph.aws4.amplify;",
};

const FALLBACK_STYLE =
  "rounded=1;whiteSpace=wrap;fillColor=#FF9900;fontColor=#232F3E;strokeColor=#232F3E;";

function nodeStyle(serviceId: string): string {
  const awsShape = AWS_ICON_STYLES[serviceId];
  if (awsShape) {
    // Full AWS icon style with standard sizing
    return (
      `${awsShape}` +
      "sketch=0;fontStyle=0;aspect=fixed;" +
      "fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;"
    );
  }
  return FALLBACK_STYLE;
}

// ---------------------------------------------------------------------------
// Geometry per pattern — [x, y, width, height] for each slot in order
// Slots map to the same order as PATTERN_SLOTS in ruleEngine.ts.
// ---------------------------------------------------------------------------

interface NodeGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NODE_W = 78;
const NODE_H = 78;

/** Returns node positions for each slot by pattern. Slot names → geometry. */
const PATTERN_LAYOUTS: Record<PatternId, Record<string, NodeGeometry>> = {
  "static-site": {
    dns:        { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    cdn:        { x: 220, y: 200, w: NODE_W, h: NODE_H },
    storage:    { x: 380, y: 200, w: NODE_W, h: NODE_H },
    monitoring: { x: 540, y: 200, w: NODE_W, h: NODE_H },
  },
  "serverless-api": {
    api:        { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    compute:    { x: 220, y: 200, w: NODE_W, h: NODE_H },
    database:   { x: 380, y: 200, w: NODE_W, h: NODE_H },
    storage:    { x: 380, y: 340, w: NODE_W, h: NODE_H },
    queue:      { x: 540, y: 200, w: NODE_W, h: NODE_H },
    auth:       { x: 220, y: 340, w: NODE_W, h: NODE_H },
    monitoring: { x: 540, y: 340, w: NODE_W, h: NODE_H },
  },
  "containerised-app": {
    load_balancer: { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    compute:       { x: 220, y: 200, w: NODE_W, h: NODE_H },
    registry:      { x: 220, y: 340, w: NODE_W, h: NODE_H },
    database:      { x: 380, y: 200, w: NODE_W, h: NODE_H },
    cache:         { x: 380, y: 340, w: NODE_W, h: NODE_H },
    storage:       { x: 540, y: 200, w: NODE_W, h: NODE_H },
    monitoring:    { x: 540, y: 340, w: NODE_W, h: NODE_H },
  },
  "event-driven": {
    producer:   { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    queue:      { x: 220, y: 200, w: NODE_W, h: NODE_H },
    consumer:   { x: 380, y: 200, w: NODE_W, h: NODE_H },
    compute:    { x: 540, y: 200, w: NODE_W, h: NODE_H },
    database:   { x: 380, y: 340, w: NODE_W, h: NODE_H },
    monitoring: { x: 540, y: 340, w: NODE_W, h: NODE_H },
  },
  "ml-pipeline": {
    storage:    { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    training:   { x: 220, y: 200, w: NODE_W, h: NODE_H },
    compute:    { x: 380, y: 200, w: NODE_W, h: NODE_H },
    api:        { x: 540, y: 200, w: NODE_W, h: NODE_H },
    monitoring: { x: 540, y: 340, w: NODE_W, h: NODE_H },
  },
  "full-stack-web": {
    cdn:        { x: 60,  y: 130, w: NODE_W, h: NODE_H },
    frontend:   { x: 60,  y: 270, w: NODE_W, h: NODE_H },
    api:        { x: 220, y: 200, w: NODE_W, h: NODE_H },
    compute:    { x: 380, y: 130, w: NODE_W, h: NODE_H },
    database:   { x: 380, y: 270, w: NODE_W, h: NODE_H },
    cache:      { x: 540, y: 200, w: NODE_W, h: NODE_H },
    storage:    { x: 540, y: 340, w: NODE_W, h: NODE_H },
    monitoring: { x: 700, y: 270, w: NODE_W, h: NODE_H },
  },
  "data-pipeline": {
    ingestion:  { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    processing: { x: 220, y: 200, w: NODE_W, h: NODE_H },
    storage:    { x: 380, y: 200, w: NODE_W, h: NODE_H },
    warehouse:  { x: 540, y: 200, w: NODE_W, h: NODE_H },
    monitoring: { x: 380, y: 340, w: NODE_W, h: NODE_H },
  },
  generic: {
    compute:    { x: 60,  y: 200, w: NODE_W, h: NODE_H },
    storage:    { x: 220, y: 200, w: NODE_W, h: NODE_H },
    database:   { x: 380, y: 200, w: NODE_W, h: NODE_H },
    networking: { x: 540, y: 200, w: NODE_W, h: NODE_H },
    monitoring: { x: 380, y: 340, w: NODE_W, h: NODE_H },
  },
};

/** Template edges for each pattern (slotName → slotName) */
const PATTERN_EDGES: Record<PatternId, [string, string, string?][]> = {
  "static-site": [
    ["dns", "cdn", "DNS → CDN"],
    ["cdn", "storage", "Origin"],
  ],
  "serverless-api": [
    ["api", "compute", "invoke"],
    ["compute", "database", "read/write"],
    ["compute", "storage", "store"],
    ["compute", "queue", "publish"],
    ["api", "auth", "authorize"],
  ],
  "containerised-app": [
    ["load_balancer", "compute", "route"],
    ["compute", "database", "query"],
    ["compute", "cache", "cache"],
    ["compute", "storage", "store"],
    ["registry", "compute", "pull image"],
  ],
  "event-driven": [
    ["producer", "queue", "publish"],
    ["queue", "consumer", "trigger"],
    ["consumer", "compute", "process"],
    ["compute", "database", "write"],
  ],
  "ml-pipeline": [
    ["storage", "training", "training data"],
    ["training", "compute", "deploy model"],
    ["compute", "api", "inference"],
  ],
  "full-stack-web": [
    ["cdn", "frontend", "static assets"],
    ["frontend", "api", "requests"],
    ["api", "compute", "execute"],
    ["compute", "database", "read/write"],
    ["compute", "cache", "cache"],
    ["compute", "storage", "assets"],
  ],
  "data-pipeline": [
    ["ingestion", "processing", "stream/batch"],
    ["processing", "storage", "store"],
    ["storage", "warehouse", "load"],
  ],
  generic: [
    ["networking", "compute", "route"],
    ["compute", "database", "query"],
    ["compute", "storage", "store"],
  ],
};

// ---------------------------------------------------------------------------
// Overflow node layout (for additional_N slots not in template)
// ---------------------------------------------------------------------------

function overflowGeometry(index: number): NodeGeometry {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: 60 + col * 160,
    y: 480 + row * 140,
    w: NODE_W,
    h: NODE_H,
  };
}

// ---------------------------------------------------------------------------
// mxGraph XML generation (Fix 8: evidence-backed solid vs dashed inferred edges)
// ---------------------------------------------------------------------------

import type { SdkEvidence } from "./repoFetcher.ts";

interface DiagramNode {
  id: string;
  label: string;
  serviceId: string;
  geo: NodeGeometry;
}

interface DiagramEdge {
  source: string;
  target: string;
  label: string;
  style: "solid" | "dashed";
}

function isEdgeConfirmed(
  srcService: string,
  dstService: string,
  srcEvidence: string,
  dstEvidence: string,
  customEdges: Array<{ from: string; to: string }>,
  sdkEvidence?: SdkEvidence[] | null
): boolean {
  // 1. Explicit customEdges from LLM or rule engine
  if (
    customEdges.some(
      (e) =>
        (e.from.toLowerCase() === srcService.toLowerCase() &&
          e.to.toLowerCase() === dstService.toLowerCase()) ||
        (e.from.toLowerCase() === dstService.toLowerCase() &&
          e.to.toLowerCase() === srcService.toLowerCase())
    )
  ) {
    return true;
  }

  // 2. sdkEvidence cross-service proof
  if (sdkEvidence && sdkEvidence.length > 0) {
    const hasDstSdk = sdkEvidence.some(
      (ev) =>
        ev.serviceHint.toLowerCase() === dstService.toLowerCase() ||
        dstService.toLowerCase().includes(ev.serviceHint.toLowerCase())
    );
    const computeServices = ["lambda", "ecs", "ec2", "fargate", "eks"];
    if (hasDstSdk && computeServices.includes(srcService.toLowerCase())) {
      return true;
    }
  }

  // 3. Explicit cross-service mention in evidence strings
  const lowerSrcEv = srcEvidence.toLowerCase();
  const lowerDstEv = dstEvidence.toLowerCase();
  if (
    lowerSrcEv.includes(dstService.toLowerCase()) ||
    lowerDstEv.includes(srcService.toLowerCase())
  ) {
    return true;
  }

  return false;
}

/**
 * Generates a complete .drawio XML document from a ServicePlan.
 *
 * An edge is solid (confirmed) ONLY if justified by SDK evidence, custom edges,
 * or explicit cross-service references.
 * Layout-only template edges are drawn as dashed lines indicating "inferred topology".
 */
export function generateDiagramXml(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): string {
  const { pattern, slots, customEdges } = plan;

  const layout = PATTERN_LAYOUTS[pattern] ?? PATTERN_LAYOUTS["generic"];
  const templateEdgeDefs = PATTERN_EDGES[pattern] ?? [];

  // Build node list
  const nodes: DiagramNode[] = [];
  const slotIdMap: Record<string, string> = {}; // slotName → nodeId
  let overflowIdx = 0;
  let nextId = 2; // mxGraph cells start at 2 (0=root, 1=layer)

  for (const [slotName, slot] of Object.entries(slots)) {
    const nodeId = `node-${nextId++}`;
    slotIdMap[slotName] = nodeId;

    const geo = layout[slotName] ?? overflowGeometry(overflowIdx++);

    nodes.push({
      id: nodeId,
      label: slot.serviceId,
      serviceId: slot.serviceId,
      geo,
    });
  }

  // Build template edges with solid vs dashed distinction
  const edges: DiagramEdge[] = [];
  for (const [srcSlot, dstSlot, label] of templateEdgeDefs) {
    if (slotIdMap[srcSlot] && slotIdMap[dstSlot]) {
      const srcService = slots[srcSlot]?.serviceId ?? "";
      const dstService = slots[dstSlot]?.serviceId ?? "";
      const srcEv = slots[srcSlot]?.evidence ?? "";
      const dstEv = slots[dstSlot]?.evidence ?? "";

      const confirmed = isEdgeConfirmed(
        srcService,
        dstService,
        srcEv,
        dstEv,
        customEdges,
        sdkEvidence
      );

      edges.push({
        source: slotIdMap[srcSlot],
        target: slotIdMap[dstSlot],
        label: confirmed
          ? (label ?? "")
          : label
          ? `${label} (inferred topology)`
          : "inferred topology",
        style: confirmed ? "solid" : "dashed",
      });
    }
  }

  // Append custom edges (serviceId-based, confirmed solid)
  const serviceIdNodeMap: Record<string, string> = {};
  for (const node of nodes) {
    serviceIdNodeMap[node.serviceId] = node.id;
  }

  for (const ce of customEdges) {
    const srcId = serviceIdNodeMap[ce.from];
    const dstId = serviceIdNodeMap[ce.to];
    if (srcId && dstId) {
      edges.push({
        source: srcId,
        target: dstId,
        label: ce.label ?? "",
        style: "solid",
      });
    }
  }

  // Render XML
  const patternTitle = xmlAttr(
    pattern
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
  );

  const cellsXml: string[] = [];

  // Nodes
  for (const node of nodes) {
    const style = nodeStyle(node.serviceId);
    const label = xmlAttr(node.label);
    cellsXml.push(
      `    <mxCell id="${node.id}" value="${label}" style="${xmlAttr(style)}" ` +
        `vertex="1" parent="1">` +
        `<mxGeometry x="${node.geo.x}" y="${node.geo.y}" ` +
        `width="${node.geo.w}" height="${node.geo.h}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // Edges (solid vs dashed style)
  let edgeId = nextId;
  for (const edge of edges) {
    const label = xmlAttr(edge.label);
    const edgeStyle =
      edge.style === "dashed"
        ? "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;dashed=1;dashPattern=8 8;strokeColor=#6B7280;strokeWidth=1;"
        : "edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;strokeColor=#232F3E;strokeWidth=1.5;";
    cellsXml.push(
      `    <mxCell id="edge-${edgeId++}" value="${label}" ` +
        `style="${edgeStyle}" ` +
        `edge="1" source="${edge.source}" target="${edge.target}" parent="1">` +
        `<mxGeometry relative="1" as="geometry"/>` +
        `</mxCell>`
    );
  }

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<mxfile host="aws-architect" modified="" agent="aws-architect" version="21.0.0" type="device">`,
    `  <diagram id="diagram-1" name="${patternTitle} Architecture">`,
    `    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" ` +
      `tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
      `pageWidth="1169" pageHeight="827" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    ...cellsXml,
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
  ].join("\n");
}
