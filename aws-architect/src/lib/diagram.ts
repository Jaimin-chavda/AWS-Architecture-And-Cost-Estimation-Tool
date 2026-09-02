/**
 * diagram.ts
 *
 * Generates clean, professional, publication-quality AWS architecture diagrams
 * in .drawio (mxGraph XML) format matching official AWS architecture guidelines:
 *
 * Layout Structure:
 * 1. Title Banner: "<AppName> — AWS Architecture"
 * 2. Top Edge / Client Tier:
 *    - End Users / Clients
 *    - Route 53 DNS, CloudFront CDN, S3 Frontend Bucket
 *    - External SaaS / Wallets (e.g. MetaMask, Ethereum, Stripe)
 * 3. VPC Container ("VPC — <app>-vpc") with AWS VPC badge:
 *    - Public Subnet: Ingress tier (ALB, API Gateway)
 *    - Private Subnet — Compute: Application tier (ECS Fargate, Lambda)
 *    - Private Subnet — Data: Databases (DocumentDB / RDS / DynamoDB), Secrets Manager, Cognito, SQS, ElastiCache
 *    - Observability & IaC Column: SNS, CloudWatch, CloudFormation
 * 4. Distinct Colored Orthogonal Flow Arrows connecting all tiers seamlessly.
 */

import type {
  ServicePlan,
  ServiceId,
  DiscoveredComponent,
  AwsServiceMapping,
  ComponentRelationship,
} from "./schema.ts";
import type { SdkEvidence } from "./repoFetcher.ts";

// ---------------------------------------------------------------------------
// XML Helpers
// ---------------------------------------------------------------------------

function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function xmlAttr(s: string): string {
  return stripControlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// AWS 4 Icon Styles
// ---------------------------------------------------------------------------

interface AwsStyleConfig {
  shape: string;
  fillColor: string;
}

const AWS_STYLES: Record<string, AwsStyleConfig> = {
  Route53: { shape: "shape=mxgraph.aws4.route_53;", fillColor: "#8C4FFF" },
  CloudFront: { shape: "shape=mxgraph.aws4.cloudfront;", fillColor: "#8C4FFF" },
  S3: { shape: "shape=mxgraph.aws4.s3;", fillColor: "#7AA116" },
  ALB: { shape: "shape=mxgraph.aws4.application_load_balancer;", fillColor: "#8C4FFF" },
  APIGateway: { shape: "shape=mxgraph.aws4.api_gateway;", fillColor: "#E7157B" },
  ECS: { shape: "shape=mxgraph.aws4.ecs;", fillColor: "#FF9900" },
  Fargate: { shape: "shape=mxgraph.aws4.fargate;", fillColor: "#FF9900" },
  Lambda: { shape: "shape=mxgraph.aws4.lambda;", fillColor: "#FF9900" },
  EC2: { shape: "shape=mxgraph.aws4.ec2;", fillColor: "#FF9900" },
  EKS: { shape: "shape=mxgraph.aws4.eks;", fillColor: "#FF9900" },
  RDS: { shape: "shape=mxgraph.aws4.rds;", fillColor: "#335E99" },
  Aurora: { shape: "shape=mxgraph.aws4.aurora;", fillColor: "#335E99" },
  DocumentDB: { shape: "shape=mxgraph.aws4.documentdb;", fillColor: "#C925D1" },
  DynamoDB: { shape: "shape=mxgraph.aws4.dynamodb;", fillColor: "#335E99" },
  ElastiCache: { shape: "shape=mxgraph.aws4.elasticache;", fillColor: "#C925D1" },
  SecretsManager: { shape: "shape=mxgraph.aws4.secrets_manager;", fillColor: "#DD344C" },
  Cognito: { shape: "shape=mxgraph.aws4.cognito;", fillColor: "#DD344C" },
  SQS: { shape: "shape=mxgraph.aws4.sqs;", fillColor: "#E7157B" },
  SNS: { shape: "shape=mxgraph.aws4.sns;", fillColor: "#E7157B" },
  EventBridge: { shape: "shape=mxgraph.aws4.eventbridge;", fillColor: "#E7157B" },
  Kinesis: { shape: "shape=mxgraph.aws4.kinesis;", fillColor: "#8C4FFF" },
  CloudWatch: { shape: "shape=mxgraph.aws4.cloudwatch;", fillColor: "#E7157B" },
  CloudFormation: { shape: "shape=mxgraph.aws4.cloudformation;", fillColor: "#E7157B" },
  CodePipeline: { shape: "shape=mxgraph.aws4.codepipeline;", fillColor: "#E7157B" },
  ECR: { shape: "shape=mxgraph.aws4.ecr;", fillColor: "#FF9900" },
  WAF: { shape: "shape=mxgraph.aws4.waf;", fillColor: "#DD344C" },
  SageMaker: { shape: "shape=mxgraph.aws4.sagemaker;", fillColor: "#01A88D" },
  Rekognition: { shape: "shape=mxgraph.aws4.rekognition;", fillColor: "#01A88D" },
  Comprehend: { shape: "shape=mxgraph.aws4.comprehend;", fillColor: "#01A88D" },
  SES: { shape: "shape=mxgraph.aws4.ses;", fillColor: "#E7157B" },
  Amplify: { shape: "shape=mxgraph.aws4.amplify;", fillColor: "#FF9900" },
  User: { shape: "shape=mxgraph.aws4.user;", fillColor: "#232F3E" },
  Wallet: { shape: "shape=mxgraph.aws4.client;", fillColor: "#FF9900" },
  External: { shape: "shape=mxgraph.aws4.traditional_server;", fillColor: "#3B82F6" },
};

function getServiceStyle(serviceId: string): string {
  const conf = AWS_STYLES[serviceId] ?? { shape: "shape=mxgraph.aws4.generic_database;", fillColor: "#FF9900" };
  return (
    `sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=${conf.fillColor};` +
    `strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;` +
    `fontSize=11;fontStyle=0;aspect=fixed;${conf.shape}`
  );
}

// ---------------------------------------------------------------------------
// Diagram Generation
// ---------------------------------------------------------------------------

export function generateDiagramXml(
  plan: ServicePlan,
  _sdkEvidence?: SdkEvidence[] | null
): string {
  const appName =
    (plan.detectedPattern ?? "Cloud Application")
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");

  const title = `${appName} — AWS Architecture`;

  // Collect active mapped services
  const mappedServices = new Set(plan.awsMappings.map((m) => m.serviceId));

  // Determine external entities from relationships or tech
  const hasFrontend = mappedServices.has("CloudFront") || mappedServices.has("S3") || plan.components.some((c) => c.type === "frontend");
  const hasMetaMask = plan.components.some((c) => /meta.*mask|wallet|web3|ether/i.test(`${c.id} ${c.technology} ${c.evidence.join(" ")}`));
  const hasSepolia = plan.components.some((c) => /sepolia|ethereum|smart.*contract|solidity/i.test(`${c.id} ${c.technology} ${c.evidence.join(" ")}`));

  let cellId = 2;
  const cells: string[] = [];

  // Title Banner
  cells.push(
    `    <mxCell id="${cellId++}" value="${xmlAttr(title)}" ` +
      `style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=18;fontStyle=1;fontColor=#232F3E;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="250" y="20" width="550" height="35" as="geometry"/>` +
      `</mxCell>`
  );

  // -------------------------------------------------------------------------
  // 1. TOP TIER: Users, Edge, DNS, CDN & External SaaS
  // -------------------------------------------------------------------------
  const nodeIds: Record<string, number> = {};

  // End Users
  const userNodeId = cellId++;
  nodeIds["user"] = userNodeId;
  cells.push(
    `    <mxCell id="${userNodeId}" value="End Users / Clients" ` +
      `style="${getServiceStyle("User")}" vertex="1" parent="1">` +
      `<mxGeometry x="470" y="70" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // Browser Wallet / Client (if crypto / web3 or general client)
  let walletNodeId: number | null = null;
  if (hasMetaMask || hasSepolia) {
    walletNodeId = cellId++;
    nodeIds["wallet"] = walletNodeId;
    cells.push(
      `    <mxCell id="${walletNodeId}" value="MetaMask\n(Browser Wallet)" ` +
        `style="${getServiceStyle("Wallet")}" vertex="1" parent="1">` +
        `<mxGeometry x="640" y="70" width="50" height="50" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // Route 53
  const r53NodeId = cellId++;
  nodeIds["Route53"] = r53NodeId;
  cells.push(
    `    <mxCell id="${r53NodeId}" value="Route 53\n(DNS)" ` +
      `style="${getServiceStyle("Route53")}" vertex="1" parent="1">` +
      `<mxGeometry x="470" y="170" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // CloudFront CDN
  const cfNodeId = cellId++;
  nodeIds["CloudFront"] = cfNodeId;
  cells.push(
    `    <mxCell id="${cfNodeId}" value="CloudFront CDN" ` +
      `style="${getServiceStyle("CloudFront")}" vertex="1" parent="1">` +
      `<mxGeometry x="310" y="170" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // S3 (Frontend)
  const s3NodeId = cellId++;
  nodeIds["S3"] = s3NodeId;
  cells.push(
    `    <mxCell id="${s3NodeId}" value="S3\n(Frontend Assets)" ` +
      `style="${getServiceStyle("S3")}" vertex="1" parent="1">` +
      `<mxGeometry x="150" y="170" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // External Testnet / API (if blockchain / external API)
  let externalTestnetId: number | null = null;
  if (hasSepolia || hasMetaMask) {
    externalTestnetId = cellId++;
    nodeIds["external-api"] = externalTestnetId;
    cells.push(
      `    <mxCell id="${externalTestnetId}" value="Ethereum\nSepolia Testnet\n(External)" ` +
        `style="${getServiceStyle("External")}" vertex="1" parent="1">` +
        `<mxGeometry x="840" y="400" width="50" height="50" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // -------------------------------------------------------------------------
  // 2. VPC CONTAINER & SUBNETS
  // -------------------------------------------------------------------------
  const vpcContainerId = cellId++;
  const vpcName = `VPC — ${appName.toLowerCase().replace(/[^a-z0-9]/g, "-")}-vpc`;

  cells.push(
    `    <mxCell id="${vpcContainerId}" value="${xmlAttr(vpcName)}" ` +
      `style="rounded=0;whiteSpace=wrap;html=1;fillColor=#F8F9FA;strokeColor=#8C4FFF;strokeWidth=1.5;align=center;verticalAlign=top;fontStyle=1;fontSize=13;fontColor=#4D22B2;dashed=0;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="20" y="250" width="980" height="560" as="geometry"/>` +
      `</mxCell>`
  );

  // Small VPC icon inside VPC banner
  cells.push(
    `    <mxCell id="${cellId++}" value="" ` +
      `style="${getServiceStyle("VPC")}" vertex="1" parent="${vpcContainerId}">` +
      `<mxGeometry x="10" y="8" width="22" height="22" as="geometry"/>` +
      `</mxCell>`
  );

  // Public Subnet
  const publicSubnetId = cellId++;
  cells.push(
    `    <mxCell id="${publicSubnetId}" value="Public Subnet" ` +
      `style="rounded=0;whiteSpace=wrap;html=1;fillColor=#EBF4FA;strokeColor=#5B9BD5;strokeWidth=1.2;align=center;verticalAlign=top;fontStyle=1;fontSize=11;fontColor=#1E4D78;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="40" y="285" width="320" height="175" as="geometry"/>` +
      `</mxCell>`
  );

  // Ingress Nodes inside Public Subnet
  const albNodeId = cellId++;
  nodeIds["ALB"] = albNodeId;
  cells.push(
    `    <mxCell id="${albNodeId}" value="Application\nLoad Balancer" ` +
      `style="${getServiceStyle("ALB")}" vertex="1" parent="1">` +
      `<mxGeometry x="90" y="340" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const apiGwNodeId = cellId++;
  nodeIds["APIGateway"] = apiGwNodeId;
  cells.push(
    `    <mxCell id="${apiGwNodeId}" value="API Gateway" ` +
      `style="${getServiceStyle("APIGateway")}" vertex="1" parent="1">` +
      `<mxGeometry x="240" y="340" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // Private Subnet — Compute
  const computeSubnetId = cellId++;
  cells.push(
    `    <mxCell id="${computeSubnetId}" value="Private Subnet — Compute" ` +
      `style="rounded=0;whiteSpace=wrap;html=1;fillColor=#EBF4FA;strokeColor=#5B9BD5;strokeWidth=1.2;align=center;verticalAlign=top;fontStyle=1;fontSize=11;fontColor=#1E4D78;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="385" y="285" width="375" height="175" as="geometry"/>` +
      `</mxCell>`
  );

  // Compute Nodes inside Private Subnet — Compute
  const ecsNodeId = cellId++;
  nodeIds["ECS"] = ecsNodeId;
  cells.push(
    `    <mxCell id="${ecsNodeId}" value="ECS Fargate\n(App Backend)" ` +
      `style="${getServiceStyle("ECS")}" vertex="1" parent="1">` +
      `<mxGeometry x="435" y="340" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const lambdaNodeId = cellId++;
  nodeIds["Lambda"] = lambdaNodeId;
  cells.push(
    `    <mxCell id="${lambdaNodeId}" value="Lambda\n(Workers / Async Calls)" ` +
      `style="${getServiceStyle("Lambda")}" vertex="1" parent="1">` +
      `<mxGeometry x="610" y="340" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // Private Subnet — Data
  const dataSubnetId = cellId++;
  cells.push(
    `    <mxCell id="${dataSubnetId}" value="Private Subnet — Data" ` +
      `style="rounded=0;whiteSpace=wrap;html=1;fillColor=#EBF4FA;strokeColor=#5B9BD5;strokeWidth=1.2;align=center;verticalAlign=top;fontStyle=1;fontSize=11;fontColor=#1E4D78;" ` +
      `vertex="1" parent="1">` +
      `<mxGeometry x="40" y="490" width="720" height="175" as="geometry"/>` +
      `</mxCell>`
  );

  // Data Nodes inside Private Subnet — Data
  const dbService = mappedServices.has("DocumentDB") ? "DocumentDB" : mappedServices.has("DynamoDB") ? "DynamoDB" : "RDS";
  const dbLabel = dbService === "DocumentDB" ? "DocumentDB\n(MongoDB-compat)" : dbService === "DynamoDB" ? "DynamoDB\n(NoSQL Store)" : "RDS PostgreSQL\n(Managed DB)";

  const dbNodeId = cellId++;
  nodeIds["DB"] = dbNodeId;
  cells.push(
    `    <mxCell id="${dbNodeId}" value="${xmlAttr(dbLabel)}" ` +
      `style="${getServiceStyle(dbService)}" vertex="1" parent="1">` +
      `<mxGeometry x="110" y="550" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const secretsNodeId = cellId++;
  nodeIds["SecretsManager"] = secretsNodeId;
  cells.push(
    `    <mxCell id="${secretsNodeId}" value="Secrets Manager\n(JWT / Keys)" ` +
      `style="${getServiceStyle("SecretsManager")}" vertex="1" parent="1">` +
      `<mxGeometry x="270" y="550" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const cognitoNodeId = cellId++;
  nodeIds["Cognito"] = cognitoNodeId;
  cells.push(
    `    <mxCell id="${cognitoNodeId}" value="Cognito\n(Auth / JWT)" ` +
      `style="${getServiceStyle("Cognito")}" vertex="1" parent="1">` +
      `<mxGeometry x="435" y="550" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const sqsNodeId = cellId++;
  nodeIds["SQS"] = sqsNodeId;
  cells.push(
    `    <mxCell id="${sqsNodeId}" value="SQS\n(Task Queue)" ` +
      `style="${getServiceStyle("SQS")}" vertex="1" parent="1">` +
      `<mxGeometry x="610" y="550" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // -------------------------------------------------------------------------
  // 3. OBSERVABILITY & MANAGEMENT COLUMN (Right side)
  // -------------------------------------------------------------------------
  const snsNodeId = cellId++;
  nodeIds["SNS"] = snsNodeId;
  cells.push(
    `    <mxCell id="${snsNodeId}" value="SNS\n(Notifications)" ` +
      `style="${getServiceStyle("SNS")}" vertex="1" parent="1">` +
      `<mxGeometry x="785" y="440" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const cwNodeId = cellId++;
  nodeIds["CloudWatch"] = cwNodeId;
  cells.push(
    `    <mxCell id="${cwNodeId}" value="CloudWatch\n(Monitoring)" ` +
      `style="${getServiceStyle("CloudWatch")}" vertex="1" parent="1">` +
      `<mxGeometry x="785" y="570" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  const cfmNodeId = cellId++;
  nodeIds["CloudFormation"] = cfmNodeId;
  cells.push(
    `    <mxCell id="${cfmNodeId}" value="CloudFormation\n(IaC)" ` +
      `style="${getServiceStyle("CloudFormation")}" vertex="1" parent="1">` +
      `<mxGeometry x="925" y="570" width="50" height="50" as="geometry"/>` +
      `</mxCell>`
  );

  // -------------------------------------------------------------------------
  // 4. FLOW EDGES (Orthogonal, Colored & Crisp)
  // -------------------------------------------------------------------------
  const edgeList: Array<{
    source: number;
    target: number;
    color: string;
    dashed?: boolean;
    label?: string;
  }> = [
    // Users → Route 53
    { source: userNodeId, target: r53NodeId, color: "#FF9900", dashed: true },
    // Route 53 → CloudFront CDN
    { source: r53NodeId, target: cfNodeId, color: "#8C4FFF" },
    // CloudFront → S3 Frontend
    { source: cfNodeId, target: s3NodeId, color: "#335E99" },
    // S3 Frontend → ALB Ingress
    { source: s3NodeId, target: albNodeId, color: "#8C4FFF" },
    // ALB → API Gateway
    { source: albNodeId, target: apiGwNodeId, color: "#D13212" },
    // API Gateway → ECS Fargate
    { source: apiGwNodeId, target: ecsNodeId, color: "#D13212" },
    // ECS Fargate → Lambda
    { source: ecsNodeId, target: lambdaNodeId, color: "#D13212" },
    // ECS Fargate → DocumentDB / RDS
    { source: ecsNodeId, target: dbNodeId, color: "#D13212" },
    // ECS Fargate → Secrets Manager
    { source: ecsNodeId, target: secretsNodeId, color: "#D13212" },
    // ECS Fargate → Cognito
    { source: ecsNodeId, target: cognitoNodeId, color: "#D13212" },
    // ECS Fargate → SQS
    { source: ecsNodeId, target: sqsNodeId, color: "#D13212" },
    // Lambda ↔ SQS
    { source: lambdaNodeId, target: sqsNodeId, color: "#C925D1" },
    // ECS / Lambda → SNS Notifications
    { source: lambdaNodeId, target: snsNodeId, color: "#E7157B" },
    // SNS → CloudWatch
    { source: snsNodeId, target: cwNodeId, color: "#E7157B", dashed: true },
    // CloudFormation → VPC
    { source: cfmNodeId, target: vpcContainerId, color: "#E7157B", dashed: true },
  ];

  if (walletNodeId) {
    edgeList.push({ source: userNodeId, target: walletNodeId, color: "#FF9900", dashed: true });
    if (externalTestnetId) {
      edgeList.push({ source: walletNodeId, target: externalTestnetId, color: "#3B82F6", dashed: true });
      edgeList.push({ source: lambdaNodeId, target: externalTestnetId, color: "#3B82F6", dashed: true });
    }
  }

  for (const edge of edgeList) {
    const dashedAttr = edge.dashed ? "dashed=1;dashPattern=6 6;" : "dashed=0;";
    const edgeStyle =
      `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;` +
      `strokeColor=${edge.color};strokeWidth=2;fontSize=10;fontColor=#232F3E;${dashedAttr}`;

    cells.push(
      `    <mxCell id="${cellId++}" value="${xmlAttr(edge.label ?? "")}" ` +
        `style="${edgeStyle}" ` +
        `edge="1" source="${edge.source}" target="${edge.target}" parent="1">` +
        `<mxGeometry relative="1" as="geometry"/>` +
        `</mxCell>`
    );
  }

  const canvasW = 1040;
  const canvasH = 860;

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<mxfile host="aws-architect" modified="" agent="aws-architect" version="21.0.0" type="device">`,
    `  <diagram id="diagram-1" name="${xmlAttr(title)}">`,
    `    <mxGraphModel dx="1422" dy="860" grid="1" gridSize="10" guides="1" ` +
      `tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
      `pageWidth="${canvasW}" pageHeight="${canvasH}" math="0" shadow="0">`,
    `      <root>`,
    `        <mxCell id="0"/>`,
    `        <mxCell id="1" parent="0"/>`,
    ...cells,
    `      </root>`,
    `    </mxGraphModel>`,
    `  </diagram>`,
    `</mxfile>`,
  ].join("\n");
}