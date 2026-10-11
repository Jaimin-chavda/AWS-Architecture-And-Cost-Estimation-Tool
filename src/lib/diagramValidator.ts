/**
 * diagramValidator.ts — additive placement table + diagram validator.
 *
 * STEP 1: SERVICE_SCOPE drives where each ServiceId belongs. Placement code
 * in diagram.ts is NOT rewired yet (locked tests pin the current tiers), so
 * this table is advisory until the layout rewrite lands. The validator below
 * already enforces the target invariants and reports current gaps.
 *
 * STEP 8: validateDiagram() fails when any target invariant is violated.
 * Run via: npm run test:diagram-validate (offline, synthetic plans).
 */

import type { ServiceId, ServicePlan } from "./schema.ts";
import {
  buildDiagramElements,
  nodeStyle,
  FALLBACK_STYLE,
  CELL_W,
  CELL_H,
  type DiagramElements,
} from "./diagram.ts";

export type ServiceScope =
  | "global-edge"
  | "regional"
  | "vpc-public"
  | "vpc-private"
  | "vpc-data"
  | "external";

export const SERVICE_SCOPE: Record<ServiceId, ServiceScope> = {
  // Compute — VPC private subnets
  EC2: "vpc-private",
  Lambda: "vpc-private",
  ECS: "vpc-private",
  EKS: "vpc-private",
  Fargate: "vpc-private",
  Lightsail: "vpc-private",
  Batch: "vpc-private",
  AppRunner: "vpc-private",
  ElasticBeanstalk: "vpc-private",
  Outposts: "vpc-private",
  Wavelength: "vpc-private",
  LocalZones: "vpc-private",
  ServerlessApplicationRepository: "vpc-private",
  EC2ImageBuilder: "vpc-private",
  SimSpaceWeaver: "vpc-private",

  // Storage — regional, outside the VPC (EBS/EFS/FSx are VPC-attached)
  S3: "regional",
  EBS: "vpc-data",
  EFS: "vpc-data",
  Glacier: "regional",
  FSx: "vpc-data",
  StorageGateway: "regional",
  Backup: "regional",
  Snowball: "regional",
  Snowcone: "regional",
  S3GlacierDeepArchive: "regional",

  // Databases, cache, warehouse — isolated data subnet
  RDS: "vpc-data",
  Aurora: "vpc-data",
  DynamoDB: "regional",
  ElastiCache: "vpc-data",
  Redshift: "vpc-data",
  DocumentDB: "vpc-data",
  Neptune: "vpc-data",
  Keyspaces: "vpc-data",
  Timestream: "vpc-data",
  MemoryDB: "vpc-data",
  QLDB: "vpc-data",

  // Networking & content delivery
  CloudFront: "global-edge",
  APIGateway: "regional",
  ALB: "vpc-public",
  NLB: "vpc-public",
  GLB: "vpc-public",
  Route53: "global-edge",
  VPC: "vpc-public",
  NATGateway: "vpc-public",
  DirectConnect: "vpc-public",
  TransitGateway: "vpc-public",
  GlobalAccelerator: "global-edge",
  PrivateLink: "vpc-public",
  AppMesh: "vpc-public",
  CloudMap: "vpc-public",
  VPCEndpoints: "vpc-public",
  SiteToSiteVPN: "vpc-public",
  ClientVPN: "vpc-public",

  // Messaging, integration & streaming — regional
  SQS: "regional",
  SNS: "regional",
  EventBridge: "regional",
  Kinesis: "regional",
  KinesisDataFirehose: "regional",
  KinesisDataStreams: "regional",
  KinesisDataAnalytics: "regional",
  MSK: "regional",
  MQ: "regional",
  AppSync: "regional",
  StepFunctions: "regional",
  ManagedAirflow: "regional",
  EventBridgePipes: "regional",
  EventBridgeScheduler: "regional",

  // Security, identity & compliance — regional
  WAF: "global-edge",
  Shield: "global-edge",
  IAM: "regional",
  Cognito: "regional",
  SecretsManager: "regional",
  KMS: "regional",
  GuardDuty: "regional",
  Inspector: "regional",
  Macie: "regional",
  SecurityHub: "regional",
  CertificateManager: "regional",
  DirectoryService: "regional",
  IAMIdentityCenter: "regional",
  NetworkFirewall: "regional",
  Artifact: "regional",
  AuditManager: "regional",
  Detective: "regional",
  CloudHSM: "regional",
  SystemsManager: "regional",
  ParameterStore: "regional",

  // Observability, management & governance — regional
  CloudWatch: "regional",
  CloudWatchLogs: "regional",
  CloudWatchSynthetics: "regional",
  CloudWatchEvidently: "regional",
  CloudWatchRUM: "regional",
  CloudTrail: "regional",
  XRay: "regional",
  Config: "regional",
  ServiceCatalog: "regional",
  ComputeOptimizer: "regional",
  TrustedAdvisor: "regional",
  HealthDashboard: "regional",
  Organizations: "regional",
  ControlTower: "regional",
  LicenseManager: "regional",
  WellArchitectedTool: "regional",

  // Developer tools & CI/CD — regional
  CodePipeline: "regional",
  CodeBuild: "regional",
  CodeDeploy: "regional",
  CodeCommit: "regional",
  CodeArtifact: "regional",
  CodeCatalyst: "regional",
  CloudFormation: "regional",
  CDK: "regional",
  ECR: "regional",
  Cloud9: "regional",
  FaultInjectionSimulator: "regional",

  // AI & ML — regional
  SageMaker: "regional",
  Rekognition: "regional",
  Comprehend: "regional",
  Transcribe: "regional",
  Translate: "regional",
  Polly: "regional",
  Textract: "regional",
  Kendra: "regional",
  Lex: "regional",
  Personalize: "regional",
  Forecast: "regional",
  Bedrock: "regional",
  Q: "regional",
  CodeWhisperer: "regional",

  // Analytics, search & data — regional except warehouse/search stores
  OpenSearch: "vpc-data",
  EMR: "regional",
  Athena: "regional",
  Glue: "regional",
  QuickSight: "regional",
  LakeFormation: "regional",
  DataPipeline: "regional",
  CleanRooms: "regional",
  MSKConnect: "regional",

  // Web, mobile & misc — regional except edge-hosted Amplify
  SES: "regional",
  Amplify: "global-edge",
  AppFlow: "regional",
  DeviceFarm: "regional",
  LocationService: "regional",
  Pinpoint: "regional",
  Connect: "regional",
  WorkSpaces: "regional",
  AppStream: "regional",

  // Migration & transfer — regional
  DMS: "regional",
  DataSync: "regional",
  TransferFamily: "regional",
  ApplicationDiscoveryService: "regional",
  MigrationHub: "regional",

  // IoT — regional
  IoTCore: "regional",
  Greengrass: "regional",
  IoTEvents: "regional",
  IoTAnalytics: "regional",
};

// Note: "external" is reserved for third-party outbound nodes, which are
// not ServiceIds, so no catalog entry maps to it. The table stays
// exhaustive over ServiceId.

export function scopeOf(serviceId: ServiceId): ServiceScope {
  const scope = SERVICE_SCOPE[serviceId];
  if (!scope) {
    // Fail loudly: a ServiceId without a scope row must break a test,
    // never default silently into the wrong container.
    throw new Error(
      `SERVICE_SCOPE has no row for ServiceId "${serviceId}" — add one, never a silent default`
    );
  }
  return scope;
}

export interface DiagramCheck {
  pass: boolean;
  failures: string[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COMPUTE_SERVICES: ReadonlySet<string> = new Set([
  "ECS",
  "Fargate",
  "EC2",
  "Lambda",
  "EKS",
  "Batch",
  "Lightsail",
  "AppRunner",
]);

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function insideRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function segmentsIntersect(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
): boolean {
  const d = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentHitsRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  r: Rect
): boolean {
  if (insideRect(p1, r) || insideRect(p2, r)) return true;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(p1, p2, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/**
 * Validates a built diagram against the target placement/edge/icon/viewBox
 * invariants. Pure function, no network. Fails (pass=false) when any hold:
 * S3/CloudFront/SecretsManager inside VPC; ALB/NAT outside VPC or not in a
 * public subnet; AZ count below availabilityZones; CloudFront→compute edge
 * while hasLoadBalancer; edge segment through a non-endpoint node; node
 * without icon; node or edge outside the viewBox.
 */
export function validateDiagram(plan: ServicePlan, elements: DiagramElements): DiagramCheck {
  const failures: string[] = [];
  const { layout, nodes, routedEdges } = elements;

  const vpc = layout.containers.vpc;
  const compRect = new Map<string, Rect>();
  for (const [compId, n] of Object.entries(layout.nodes)) {
    compRect.set(compId, { x: n.x, y: n.y, w: CELL_W, h: CELL_H });
  }
  const nodeIdRect = new Map<string, Rect>();
  for (const n of nodes) {
    const r = compRect.get(n.componentId) ?? compRect.get(`${n.componentId}_${n.serviceId}`);
    if (r) nodeIdRect.set(n.id, r);
  }

  // 1. Regional services must not sit inside the VPC container.
  if (vpc) {
    for (const n of nodes) {
      if (n.serviceId === "S3" || n.serviceId === "CloudFront" || n.serviceId === "SecretsManager") {
        const r = nodeIdRect.get(n.id);
        if (r && insideRect(center(r), vpc)) {
          failures.push(`${n.serviceId} node "${n.componentId}" is inside the VPC container (scope: ${scopeOf(n.serviceId)})`);
        }
      }
    }
  }

  // 2. ALB/NAT belong inside the VPC in a public subnet.
  for (const n of nodes) {
    if (n.serviceId === "ALB" || n.serviceId === "NATGateway") {
      const r = nodeIdRect.get(n.id);
      if (vpc && r && !insideRect(center(r), vpc)) {
        failures.push(`${n.serviceId} node "${n.componentId}" is outside the VPC container`);
      }
      if (n.parent !== "container-public_subnet") {
        failures.push(`${n.serviceId} node "${n.componentId}" is in "${n.parent}", not a public subnet`);
      }
    }
  }

  // 3. AZ / compute fan-out must honour availabilityZones.
  const expectedAz = Math.max(1, ...plan.deploymentModel.map((d) => d.availabilityZones ?? 1));
  const azCount = layout.containers.az ? 1 : 0;
  const computeNodes = nodes.filter((n) => COMPUTE_SERVICES.has(n.serviceId)).length;
  if (expectedAz >= 2 && azCount < 2) {
    failures.push(`availabilityZones is ${expectedAz} but only ${azCount} AZ container renders`);
  }
  if (expectedAz >= 2 && computeNodes < 2) {
    failures.push(`availabilityZones is ${expectedAz} but only ${computeNodes} compute node renders`);
  }

  // 4. CloudFront must never bypass the ALB to compute.
  const hasLb = plan.deploymentModel.some((d) => d.hasLoadBalancer);
  if (hasLb) {
    const svcByNode = new Map(nodes.map((n) => [n.id, n.serviceId] as const));
    for (const e of routedEdges) {
      if (svcByNode.get(e.sourceId) === "CloudFront" && COMPUTE_SERVICES.has(svcByNode.get(e.targetId) ?? "")) {
        failures.push(`CloudFront -> compute edge "${e.id}" exists while hasLoadBalancer is true`);
      }
    }
  }

  // 5. No edge segment may cross a non-endpoint node box.
  for (const e of routedEdges) {
    const src = nodeIdRect.get(e.sourceId);
    const dst = nodeIdRect.get(e.targetId);
    if (!src || !dst) continue;
    const pts = [center(src), ...e.waypoints, center(dst)];
    for (let i = 0; i < pts.length - 1; i++) {
      for (const n of nodes) {
        if (n.id === e.sourceId || n.id === e.targetId) continue;
        const r = nodeIdRect.get(n.id);
        if (r && segmentHitsRect(pts[i], pts[i + 1], r)) {
          failures.push(`edge "${e.id}" segment ${i} intersects node "${n.componentId}" (${n.serviceId})`);
          break;
        }
      }
    }
  }

  // 6. Every node needs a real icon, never a blank fallback box.
  for (const n of nodes) {
    if (nodeStyle(n.serviceId) === FALLBACK_STYLE) {
      failures.push(`node "${n.componentId}" (${n.serviceId}) has no icon`);
    }
  }

  // 7. Everything must lie inside the viewBox.
  const inView = (p: { x: number; y: number }) =>
    p.x >= 0 && p.x <= layout.canvasW && p.y >= 0 && p.y <= layout.canvasH;
  for (const [key, r] of Object.entries(layout.containers)) {
    if (!r) continue;
    if (!inView({ x: r.x, y: r.y }) || !inView({ x: r.x + r.w, y: r.y + r.h })) {
      failures.push(`container "${key}" lies outside the viewBox`);
    }
  }
  for (const n of nodes) {
    const r = nodeIdRect.get(n.id);
    if (r && (!inView({ x: r.x, y: r.y }) || !inView({ x: r.x + r.w, y: r.y + r.h }))) {
      failures.push(`node "${n.componentId}" lies outside the viewBox`);
    }
  }
  for (const e of routedEdges) {
    for (const w of e.waypoints) {
      if (!inView(w)) {
        failures.push(`edge "${e.id}" waypoint lies outside the viewBox`);
        break;
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

/** Convenience: build elements from a plan, then validate. */
export function validatePlanDiagram(plan: ServicePlan): DiagramCheck {
  return validateDiagram(plan, buildDiagramElements(plan));
}
