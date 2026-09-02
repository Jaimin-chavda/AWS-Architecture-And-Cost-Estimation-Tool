/**
 * diagram.ts — Stage 4: ServicePlan → mxGraph XML (.drawio format)
 *
 * Generates clean, publication-ready AWS architecture diagrams in .drawio format.
 *
 * Layout Structure:
 * - Dynamic grid/subnet model: services are bucketed by tier (edge, public, compute, data, external)
 *   and packed into rows of fixed cell size.
 * - Sizing grows/shrinks dynamically with the row count (bucketHeight).
 * - Empty tiers/containers are omitted.
 * - Rendered services are derived strictly from plan.awsMappings.
 * - Edges use evidence-justified solid vs dashed inferred topology styles.
 *
 * Exported:
 *   generateDiagramXml(plan: ServicePlan, sdkEvidence?: SdkEvidence[] | null): string
 *   computeLayout(services: AwsServiceMapping[]): DiagramLayout
 *   bucketHeight(rows: number): number
 */

import type {
  ServicePlan,
  ServiceId,
  AwsServiceMapping,
  ComponentRelationship,
} from "./schema.ts";
import type { SdkEvidence } from "./repoFetcher.ts";

// ---------------------------------------------------------------------------
// XML Helpers
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00–0x1F except TAB/LF/CR) from a string */
function stripControlChars(s: string): string {
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
  WAF: "shape=mxgraph.aws4.waf;",
  // Messaging
  SQS: "shape=mxgraph.aws4.sqs;",
  SNS: "shape=mxgraph.aws4.sns;",
  EventBridge: "shape=mxgraph.aws4.eventbridge;",
  Kinesis: "shape=mxgraph.aws4.kinesis;",
  // Auth
  Cognito: "shape=mxgraph.aws4.cognito;",
  SecretsManager: "shape=mxgraph.aws4.secrets_manager;",
  // DevOps / Observability
  CloudWatch: "shape=mxgraph.aws4.cloudwatch;",
  CodePipeline: "shape=mxgraph.aws4.codepipeline;",
  ECR: "shape=mxgraph.aws4.ecr;",
  CloudFormation: "shape=mxgraph.aws4.cloudformation;",
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
    return (
      `${awsShape}` +
      "sketch=0;fontStyle=0;aspect=fixed;" +
      "fillColor=#FF9900;strokeColor=#232F3E;fontColor=#232F3E;"
    );
  }
  return FALLBACK_STYLE;
}

// ---------------------------------------------------------------------------
// Grid/subnet layout
// ---------------------------------------------------------------------------

const CELL_W = 78;
const CELL_H = 78;
const GAP = 16; // cell-to-cell gap inside a container
const VGAP = 24; // container-to-container vertical gap
const PAD = 12; // container interior padding
const LABEL_H = 20; // container label bar height
const MARGIN = 24; // canvas margin

const SUBNET_COLS = 4; // columns per VPC subnet
const EDGE_COLS = 8; // columns in the top edge banner
const EXTERNAL_COLS = 2; // columns in the external column

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tier = "edge" | "vpc_public" | "vpc_compute" | "vpc_data" | "external";

export const SERVICE_TIERS: Record<ServiceId, Tier> = {
  // Edge / public entry points (top banner)
  Route53: "edge",
  CloudFront: "edge",
  APIGateway: "edge",
  ALB: "edge",
  Cognito: "edge",
  WAF: "edge",
  // Network infrastructure (public subnet)
  VPC: "vpc_public",
  NATGateway: "vpc_public",
  // Compute (compute subnet)
  EC2: "vpc_compute",
  Lambda: "vpc_compute",
  ECS: "vpc_compute",
  EKS: "vpc_compute",
  Fargate: "vpc_compute",
  Lightsail: "vpc_compute",
  Batch: "vpc_compute",
  ECR: "vpc_compute",
  // Data / storage / async / observability / ml (data subnet)
  S3: "vpc_data",
  EBS: "vpc_data",
  EFS: "vpc_data",
  Glacier: "vpc_data",
  RDS: "vpc_data",
  Aurora: "vpc_data",
  DynamoDB: "vpc_data",
  ElastiCache: "vpc_data",
  Redshift: "vpc_data",
  DocumentDB: "vpc_data",
  SQS: "vpc_data",
  SNS: "vpc_data",
  EventBridge: "vpc_data",
  Kinesis: "vpc_data",
  CloudWatch: "vpc_data",
  CodePipeline: "vpc_data",
  CloudFormation: "vpc_data",
  SecretsManager: "vpc_data",
  SageMaker: "vpc_data",
  Rekognition: "vpc_data",
  Comprehend: "vpc_data",
  // External services (column beside the VPC)
  SES: "external",
  Amplify: "external",
};

export type ContainerKey =
  | "edge"
  | "vpc"
  | "public_subnet"
  | "compute_subnet"
  | "data_subnet"
  | "external";

const CONTAINER_LABELS: Record<ContainerKey, string> = {
  edge: "Edge & Public Services",
  vpc: "VPC",
  public_subnet: "Public Subnet",
  compute_subnet: "Compute Subnet",
  data_subnet: "Data Subnet",
  external: "External Services",
};

/** Container height for a given row count (label bar + rows + padding). */
export function bucketHeight(rows: number): number {
  if (rows <= 0) return 0;
  return LABEL_H + rows * CELL_H + (rows - 1) * GAP + PAD;
}

interface BucketEntry {
  componentId: string;
  serviceId: ServiceId;
}

interface PlacedNode {
  componentId: string;
  serviceId: ServiceId;
  x: number;
  y: number;
}

interface PlacedBucket {
  rect: Rect;
  nodes: PlacedNode[];
}

/** Packs a bucket into `cols` columns starting at (x, y); null when empty. */
function packGrid(
  entries: BucketEntry[],
  cols: number,
  x: number,
  y: number
): PlacedBucket | null {
  if (entries.length === 0) return null;
  const rows = Math.ceil(entries.length / cols);
  const w = cols * CELL_W + (cols - 1) * GAP;
  const h = bucketHeight(rows);
  const nodes: PlacedNode[] = entries.map((e, i) => ({
    componentId: e.componentId,
    serviceId: e.serviceId,
    x: x + PAD + (i % cols) * (CELL_W + GAP),
    y: y + LABEL_H + PAD + Math.floor(i / cols) * (CELL_H + GAP),
  }));
  return { rect: { x, y, w, h }, nodes };
}

export interface DiagramLayout {
  /** Rect for each container; null when that tier has no services. */
  containers: Record<ContainerKey, Rect | null>;
  /** Absolute node placement per componentId, with the id of its parent container. */
  nodes: Record<string, { x: number; y: number; parent: string; serviceId: ServiceId }>;
  canvasW: number;
  canvasH: number;
}

/**
 * Computes the full diagram geometry from plan.awsMappings.
 * Pure — no XML, no I/O — so the row-growth / shrink / omit behavior is unit-testable.
 */
export function computeLayout(services: AwsServiceMapping[]): DiagramLayout {
  const buckets: Record<Tier, BucketEntry[]> = {
    edge: [],
    vpc_public: [],
    vpc_compute: [],
    vpc_data: [],
    external: [],
  };
  for (const m of services) {
    const tier = SERVICE_TIERS[m.serviceId] ?? "vpc_data";
    buckets[tier].push({
      componentId: m.componentId,
      serviceId: m.serviceId,
    });
  }

  const containers: DiagramLayout["containers"] = {
    edge: null,
    vpc: null,
    public_subnet: null,
    compute_subnet: null,
    data_subnet: null,
    external: null,
  };
  const nodes: DiagramLayout["nodes"] = {};

  // Edge banner height is known up-front; width is resolved after VPC
  const edgeRows = buckets.edge.length > 0 ? Math.ceil(buckets.edge.length / EDGE_COLS) : 0;
  const edgeH = bucketHeight(edgeRows);
  const vpcY = MARGIN + (edgeRows > 0 ? edgeH + VGAP : 0);
  const vpcX = MARGIN;

  // 1. Public + compute subnets side by side at a fixed y.
  const publicPlaced = packGrid(buckets.vpc_public, SUBNET_COLS, vpcX, vpcY);
  const computePlaced = packGrid(
    buckets.vpc_compute,
    SUBNET_COLS,
    vpcX + (publicPlaced ? publicPlaced.rect.w + GAP : 0),
    vpcY
  );

  // 2. Data subnet below the tallest of the two.
  let dataPlaced: PlacedBucket | null = null;
  const topBottom = Math.max(
    publicPlaced ? publicPlaced.rect.y + publicPlaced.rect.h : 0,
    computePlaced ? computePlaced.rect.y + computePlaced.rect.h : 0
  );
  if (buckets.vpc_data.length > 0) {
    const dataY = topBottom > 0 ? topBottom + VGAP : vpcY;
    dataPlaced = packGrid(buckets.vpc_data, SUBNET_COLS, vpcX, dataY);
  }

  // 3. VPC box wraps the three subnets.
  const vpcEntries = [publicPlaced, computePlaced, dataPlaced].filter(
    (p): p is PlacedBucket => p !== null
  );
  let vpcRect: Rect | null = null;
  if (vpcEntries.length > 0) {
    const vpcW =
      Math.max(...vpcEntries.map((p) => p.rect.x + p.rect.w)) - vpcX + PAD;
    const vpcBottom = Math.max(...vpcEntries.map((p) => p.rect.y + p.rect.h));
    const vpcH = vpcBottom - vpcY + GAP;
    vpcRect = { x: vpcX, y: vpcY, w: vpcW, h: vpcH };
  }
  containers.vpc = vpcRect;
  if (publicPlaced) containers.public_subnet = publicPlaced.rect;
  if (computePlaced) containers.compute_subnet = computePlaced.rect;
  if (dataPlaced) containers.data_subnet = dataPlaced.rect;

  // 4. External column anchored to the right edge of the VPC box.
  let externalRect: Rect | null = null;
  if (buckets.external.length > 0) {
    const extX = vpcRect ? vpcRect.x + vpcRect.w + GAP : MARGIN;
    const extY = vpcRect ? vpcRect.y : MARGIN;
    const extPlaced = packGrid(buckets.external, EXTERNAL_COLS, extX, extY)!;
    if (vpcRect) extPlaced.rect.h = Math.max(vpcRect.h, extPlaced.rect.h);
    externalRect = extPlaced.rect;
    for (const n of extPlaced.nodes) {
      nodes[n.componentId] = { x: n.x, y: n.y, parent: "container-external", serviceId: n.serviceId };
    }
  }
  containers.external = externalRect;

  // 5. Canvas size from final container geometry.
  const rightExtent = Math.max(
    vpcRect ? vpcRect.x + vpcRect.w : 0,
    externalRect ? externalRect.x + externalRect.w : 0
  );
  const canvasW = Math.max(rightExtent + PAD + MARGIN, 500);

  // 6. Edge banner spans the full canvas width.
  if (buckets.edge.length > 0) {
    const edgeW = canvasW - 2 * MARGIN;
    const edgePlaced = packGrid(buckets.edge, EDGE_COLS, MARGIN, MARGIN)!;
    edgePlaced.rect.w = edgeW;
    containers.edge = edgePlaced.rect;
    for (const n of edgePlaced.nodes) {
      nodes[n.componentId] = { x: n.x, y: n.y, parent: "container-edge", serviceId: n.serviceId };
    }
  }

  // Attach subnet node placements.
  const subnetPlacements: Array<[PlacedBucket | null, ContainerKey]> = [
    [publicPlaced, "public_subnet"],
    [computePlaced, "compute_subnet"],
    [dataPlaced, "data_subnet"],
  ];
  for (const [placed, key] of subnetPlacements) {
    if (!placed) continue;
    for (const n of placed.nodes) {
      nodes[n.componentId] = { x: n.x, y: n.y, parent: `container-${key}`, serviceId: n.serviceId };
    }
  }

  const bottomExtent = Math.max(
    edgeH > 0 ? MARGIN + edgeH : 0,
    vpcRect ? vpcRect.y + vpcRect.h : 0,
    externalRect ? externalRect.y + externalRect.h : 0
  );
  const canvasH = Math.max(bottomExtent + MARGIN, 400);

  return { containers, nodes, canvasW, canvasH };
}

// ---------------------------------------------------------------------------
// Template edges by pattern (ServiceId → ServiceId)
// ---------------------------------------------------------------------------

const PATTERN_EDGES: Record<string, [ServiceId, ServiceId, string?][]> = {
  "static-site": [
    ["Route53", "CloudFront", "DNS → CDN"],
    ["CloudFront", "S3", "Origin"],
  ],
  "serverless-api": [
    ["APIGateway", "Lambda", "invoke"],
    ["Lambda", "DynamoDB", "read/write"],
    ["Lambda", "S3", "store"],
    ["Lambda", "SQS", "publish"],
    ["APIGateway", "Cognito", "authorize"],
  ],
  "containerised-app": [
    ["Route53", "ALB", "DNS"],
    ["ALB", "ECS", "route"],
    ["ALB", "Fargate", "route"],
    ["ALB", "EKS", "route"],
    ["ECS", "RDS", "query"],
    ["Fargate", "RDS", "query"],
    ["ECS", "Aurora", "query"],
    ["Fargate", "Aurora", "query"],
    ["ECS", "ElastiCache", "cache"],
    ["Fargate", "ElastiCache", "cache"],
    ["ECS", "S3", "store"],
    ["Fargate", "S3", "store"],
    ["ECR", "ECS", "pull image"],
    ["ECR", "Fargate", "pull image"],
  ],
  "event-driven": [
    ["SNS", "SQS", "fanout"],
    ["SQS", "Lambda", "trigger"],
    ["SQS", "ECS", "consume"],
    ["EventBridge", "Lambda", "trigger"],
    ["Kinesis", "Lambda", "process"],
  ],
  "ml-pipeline": [
    ["S3", "SageMaker", "training data"],
    ["SageMaker", "S3", "model artifacts"],
    ["SageMaker", "APIGateway", "endpoint"],
  ],
  "full-stack-web": [
    ["Route53", "CloudFront", "DNS"],
    ["CloudFront", "S3", "static assets"],
    ["CloudFront", "ALB", "dynamic requests"],
    ["ALB", "ECS", "route"],
    ["ALB", "EC2", "route"],
    ["ECS", "RDS", "read/write"],
    ["EC2", "RDS", "read/write"],
    ["ECS", "ElastiCache", "cache"],
  ],
  "data-pipeline": [
    ["Kinesis", "S3", "ingestion"],
    ["S3", "Redshift", "load"],
  ],
  generic: [
    ["Route53", "EC2", "route"],
    ["EC2", "RDS", "query"],
    ["EC2", "S3", "store"],
  ],
};

function isEdgeConfirmed(
  srcService: string,
  dstService: string,
  srcEvidence: string,
  dstEvidence: string,
  relationships: ComponentRelationship[],
  sdkEvidence?: SdkEvidence[] | null
): boolean {
  // 1. Explicit relationships from LLM or rule engine
  if (
    relationships.some(
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
    const hasDstSdk = sdkEvidence.some((ev) => {
      const hint = ev.serviceHint ?? ev.service ?? "";
      return (
        hint.toLowerCase() === dstService.toLowerCase() ||
        dstService.toLowerCase().includes(hint.toLowerCase())
      );
    });
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

const CONTAINER_STYLE =
  "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;fontStyle=1;fontSize=11;" +
  "fillColor=#FFF2CC;strokeColor=#232F3E;dashed=0;";

/**
 * Generates a complete .drawio XML document from a ServicePlan.
 *
 * An edge is solid (confirmed) ONLY if justified by SDK evidence, relationships,
 * or explicit cross-service references.
 * Layout-only template edges are drawn as dashed lines indicating "inferred topology".
 */
export function generateDiagramXml(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): string {
  const pattern = plan.detectedPattern ?? "generic";
  const patternTitle = xmlAttr(
    pattern
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
  );

  const layout = computeLayout(plan.awsMappings);

  // Build node list
  interface DiagramNode {
    id: string;
    componentId: string;
    serviceId: ServiceId;
    label: string;
    geo: { x: number; y: number; w: number; h: number };
    parent: string;
  }

  const nodes: DiagramNode[] = [];
  const compIdToNodeId: Record<string, string> = {};
  let nextId = 2; // mxGraph cells start at 2 (0=root, 1=layer)

  for (const mapping of plan.awsMappings) {
    const placement = layout.nodes[mapping.componentId];
    if (!placement) continue;

    const parent = placement.parent;
    const nodeId = `node-${nextId++}`;
    compIdToNodeId[mapping.componentId] = nodeId;

    // Child geometry is relative to parent container origin
    const containerRect =
      parent === "1"
        ? { x: 0, y: 0 }
        : layout.containers[parent.replace("container-", "") as ContainerKey];
    const baseX = containerRect ? containerRect.x : 0;
    const baseY = containerRect ? containerRect.y : 0;

    nodes.push({
      id: nodeId,
      componentId: mapping.componentId,
      serviceId: mapping.serviceId,
      label: mapping.serviceId,
      geo: {
        x: placement.x - baseX,
        y: placement.y - baseY,
        w: CELL_W,
        h: CELL_H,
      },
      parent,
    });
  }

  // Build edges
  interface DiagramEdge {
    source: string;
    target: string;
    label: string;
    style: "solid" | "dashed";
  }
  const edges: DiagramEdge[] = [];
  const edgeKeys = new Set<string>();

  // 1. Template edges from PATTERN_EDGES
  const templateEdgeDefs = PATTERN_EDGES[pattern] ?? PATTERN_EDGES.generic ?? [];
  for (const [srcService, dstService, label] of templateEdgeDefs) {
    const srcNodes = nodes.filter((n) => n.serviceId === srcService);
    const dstNodes = nodes.filter((n) => n.serviceId === dstService);

    for (const srcNode of srcNodes) {
      for (const dstNode of dstNodes) {
        if (srcNode.id === dstNode.id) continue;
        const key = `${srcNode.id}->${dstNode.id}`;
        if (edgeKeys.has(key)) continue;

        const srcMapping = plan.awsMappings.find((m) => m.componentId === srcNode.componentId);
        const dstMapping = plan.awsMappings.find((m) => m.componentId === dstNode.componentId);
        const srcEv = srcMapping?.evidence ?? "";
        const dstEv = dstMapping?.evidence ?? "";

        const confirmed = isEdgeConfirmed(
          srcService,
          dstService,
          srcEv,
          dstEv,
          plan.relationships ?? [],
          sdkEvidence
        );

        edges.push({
          source: srcNode.id,
          target: dstNode.id,
          label: confirmed
            ? (label ?? "")
            : label
            ? `${label} (inferred topology)`
            : "inferred topology",
          style: confirmed ? "solid" : "dashed",
        });
        edgeKeys.add(key);
      }
    }
  }

  // 2. Explicit relationships from plan.relationships
  for (const rel of plan.relationships ?? []) {
    const srcNodeId = compIdToNodeId[rel.from];
    const dstNodeId = compIdToNodeId[rel.to];
    if (srcNodeId && dstNodeId) {
      const key = `${srcNodeId}->${dstNodeId}`;
      if (edgeKeys.has(key)) {
        const existing = edges.find((e) => e.source === srcNodeId && e.target === dstNodeId);
        if (existing) {
          existing.style = "solid";
          if (rel.type) existing.label = rel.type;
        }
      } else {
        edges.push({
          source: srcNodeId,
          target: dstNodeId,
          label: rel.type ?? "",
          style: "solid",
        });
        edgeKeys.add(key);
      }
    }
  }

  // Render XML
  const cellsXml: string[] = [];

  // Containers (drawn first so they sit behind their children)
  const containerTierMap: Record<string, ContainerKey> = {
    "container-edge": "edge",
    "container-vpc": "vpc",
    "container-public_subnet": "public_subnet",
    "container-compute_subnet": "compute_subnet",
    "container-data_subnet": "data_subnet",
    "container-external": "external",
  };
  for (const [containerId, tier] of Object.entries(containerTierMap)) {
    const rect = layout.containers[tier];
    if (!rect) continue;
    const label = CONTAINER_LABELS[tier];
    cellsXml.push(
      `    <mxCell id="${containerId}" value="${xmlAttr(label)}" ` +
        `style="${CONTAINER_STYLE}" vertex="1" parent="1">` +
        `<mxGeometry x="${rect.x}" y="${rect.y}" ` +
        `width="${rect.w}" height="${rect.h}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // Nodes
  for (const node of nodes) {
    const style = nodeStyle(node.serviceId);
    const label = xmlAttr(node.label);
    cellsXml.push(
      `    <mxCell id="${node.id}" value="${label}" style="${xmlAttr(style)}" ` +
        `vertex="1" parent="${node.parent}">` +
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
      `pageWidth="${layout.canvasW}" pageHeight="${layout.canvasH}" math="0" shadow="0">`,
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
