/**
 * diagram.ts — Stage 4: ServicePlan → mxGraph XML (.drawio format)
 *
 * Generates publication-ready AWS architecture diagrams in .drawio format.
 *
 * Guarantees:
 * - Mathematical centering: computes full bounding box of all containers and nodes,
 *   and translates everything to be centered with uniform margins.
 * - Full-label bounding boxes & intelligent multi-line wrapping so service names
 *   and edge labels never collide.
 * - Auto-expanding container boundaries that cleanly contain all children.
 * - Distinct visual hierarchy with official AWS Well-Architected color-coded themes.
 * - Orthogonal edge routing through container channels with clean branching bus.
 * - Opaque badges on edge labels to prevent line strike-through.
 *
 * Exported:
 *   generateDiagramXml(plan: ServicePlan, sdkEvidence?: SdkEvidence[] | null): string
 *   computeLayout(services: AwsServiceMapping[]): DiagramLayout
 *   bucketHeight(rows: number): number
 *   normalizeServiceName(serviceId: string): string
 *   wrapServiceName(name: string): string
 *   layoutNodes(entries: BucketEntry[], cols: number, startX: number, startY: number): PlacedBucket | null
 *   routeEdges(...): RoutedEdge[]
 */

import type {
  ServicePlan,
  ServiceId,
  AwsServiceMapping,
  ComponentRelationship,
} from "./schema.ts";
import { SERVICE_CATEGORIES } from "./schema.ts";
import type { SdkEvidence } from "./repoFetcher.ts";
import { matchIntegration } from "./integrationRegistry.ts";

// ---------------------------------------------------------------------------
// XML Helpers
// ---------------------------------------------------------------------------

/** Strips ASCII control characters (0x00–0x1F except TAB/LF/CR) from a string */
function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

/** Escapes a string for safe use inside an XML attribute value */
export function xmlAttr(s: string): string {
  return stripControlChars(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// AWS Service Display Names & Intelligent Wrapping
// ---------------------------------------------------------------------------

export const AWS_DISPLAY_NAMES: Record<string, string> = {
  // Compute
  EC2: "Amazon EC2",
  Lambda: "AWS Lambda",
  ECS: "Amazon ECS",
  EKS: "Amazon EKS",
  Fargate: "AWS Fargate",
  Lightsail: "Amazon Lightsail",
  Batch: "AWS Batch",
  AppRunner: "AWS App Runner",
  ElasticBeanstalk: "AWS Elastic Beanstalk",
  Outposts: "AWS Outposts",
  Wavelength: "AWS Wavelength",
  LocalZones: "AWS Local Zones",
  ServerlessApplicationRepository: "AWS Serverless Application Repository",
  EC2ImageBuilder: "EC2 Image Builder",
  SimSpaceWeaver: "AWS SimSpace Weaver",
  // Storage
  S3: "Amazon S3",
  EBS: "Amazon EBS",
  EFS: "Amazon EFS",
  Glacier: "Amazon S3 Glacier",
  FSx: "Amazon FSx",
  StorageGateway: "AWS Storage Gateway",
  Backup: "AWS Backup",
  Snowball: "AWS Snowball",
  Snowcone: "AWS Snowcone",
  S3GlacierDeepArchive: "Amazon S3 Glacier Deep Archive",
  // Database
  RDS: "Amazon RDS",
  DynamoDB: "Amazon DynamoDB",
  ElastiCache: "Amazon ElastiCache",
  Aurora: "Amazon Aurora",
  Redshift: "Amazon Redshift",
  DocumentDB: "Amazon DocumentDB",
  Neptune: "Amazon Neptune",
  Keyspaces: "Amazon Keyspaces",
  Timestream: "Amazon Timestream",
  MemoryDB: "Amazon MemoryDB",
  QLDB: "Amazon QLDB",
  // Networking
  CloudFront: "Amazon CloudFront",
  APIGateway: "Amazon API Gateway",
  ALB: "Application Load Balancer (ALB)",
  NLB: "Network Load Balancer (NLB)",
  GLB: "Gateway Load Balancer (GLB)",
  Route53: "Amazon Route 53",
  VPC: "Amazon VPC",
  NATGateway: "NAT Gateway",
  DirectConnect: "AWS Direct Connect",
  TransitGateway: "AWS Transit Gateway",
  GlobalAccelerator: "AWS Global Accelerator",
  PrivateLink: "AWS PrivateLink",
  AppMesh: "AWS App Mesh",
  CloudMap: "AWS Cloud Map",
  VPCEndpoints: "VPC Endpoints",
  SiteToSiteVPN: "AWS Site-to-Site VPN",
  ClientVPN: "AWS Client VPN",
  WAF: "AWS WAF",
  // Messaging
  SQS: "Amazon SQS",
  SNS: "Amazon SNS",
  EventBridge: "Amazon EventBridge",
  Kinesis: "Amazon Kinesis",
  KinesisDataFirehose: "Amazon Kinesis Data Firehose",
  KinesisDataStreams: "Amazon Kinesis Data Streams",
  KinesisDataAnalytics: "Amazon Kinesis Data Analytics",
  MSK: "Amazon MSK",
  MQ: "Amazon MQ",
  AppSync: "AWS AppSync",
  StepFunctions: "AWS Step Functions",
  ManagedAirflow: "Amazon Managed Workflows for Apache Airflow",
  EventBridgePipes: "Amazon EventBridge Pipes",
  EventBridgeScheduler: "Amazon EventBridge Scheduler",
  // Auth & Security
  Cognito: "Amazon Cognito",
  SecretsManager: "AWS Secrets Manager",
  Shield: "AWS Shield",
  IAM: "AWS IAM",
  KMS: "AWS KMS",
  GuardDuty: "Amazon GuardDuty",
  Inspector: "Amazon Inspector",
  Macie: "Amazon Macie",
  SecurityHub: "AWS Security Hub",
  CertificateManager: "AWS Certificate Manager",
  DirectoryService: "AWS Directory Service",
  IAMIdentityCenter: "AWS IAM Identity Center",
  NetworkFirewall: "AWS Network Firewall",
  Artifact: "AWS Artifact",
  AuditManager: "AWS Audit Manager",
  Detective: "Amazon Detective",
  CloudHSM: "AWS CloudHSM",
  SystemsManager: "AWS Systems Manager",
  ParameterStore: "AWS Systems Manager Parameter Store",
  // DevOps & Observability
  CloudWatch: "Amazon CloudWatch",
  CloudWatchLogs: "Amazon CloudWatch Logs",
  CloudWatchSynthetics: "Amazon CloudWatch Synthetics",
  CloudWatchEvidently: "Amazon CloudWatch Evidently",
  CloudWatchRUM: "Amazon CloudWatch RUM",
  CloudTrail: "AWS CloudTrail",
  XRay: "AWS X-Ray",
  Config: "AWS Config",
  ServiceCatalog: "AWS Service Catalog",
  ComputeOptimizer: "AWS Compute Optimizer",
  TrustedAdvisor: "AWS Trusted Advisor",
  HealthDashboard: "AWS Health Dashboard",
  Organizations: "AWS Organizations",
  ControlTower: "AWS Control Tower",
  LicenseManager: "AWS License Manager",
  WellArchitectedTool: "AWS Well-Architected Tool",
  CodePipeline: "AWS CodePipeline",
  CodeBuild: "AWS CodeBuild",
  CodeDeploy: "AWS CodeDeploy",
  CodeCommit: "AWS CodeCommit",
  CodeArtifact: "AWS CodeArtifact",
  CodeCatalyst: "Amazon CodeCatalyst",
  CloudFormation: "AWS CloudFormation",
  CDK: "AWS Cloud Development Kit (CDK)",
  ECR: "Amazon ECR",
  Cloud9: "AWS Cloud9",
  FaultInjectionSimulator: "AWS Fault Injection Simulator",
  // AI / ML
  SageMaker: "Amazon SageMaker",
  Rekognition: "Amazon Rekognition",
  Comprehend: "Amazon Comprehend",
  Transcribe: "Amazon Transcribe",
  Translate: "Amazon Translate",
  Polly: "Amazon Polly",
  Textract: "Amazon Textract",
  Kendra: "Amazon Kendra",
  Lex: "Amazon Lex",
  Personalize: "Amazon Personalize",
  Forecast: "Amazon Forecast",
  Bedrock: "Amazon Bedrock",
  Q: "Amazon Q",
  CodeWhisperer: "Amazon CodeWhisperer",
  // Search & analytics
  OpenSearch: "Amazon OpenSearch Service",
  EMR: "Amazon EMR",
  Athena: "Amazon Athena",
  Glue: "AWS Glue",
  QuickSight: "Amazon QuickSight",
  LakeFormation: "AWS Lake Formation",
  DataPipeline: "AWS Data Pipeline",
  CleanRooms: "AWS Clean Rooms",
  MSKConnect: "Amazon MSK Connect",
  // Misc
  SES: "Amazon SES",
  Amplify: "AWS Amplify",
  AppFlow: "Amazon AppFlow",
  DeviceFarm: "AWS Device Farm",
  LocationService: "Amazon Location Service",
  Pinpoint: "Amazon Pinpoint",
  Connect: "Amazon Connect",
  WorkSpaces: "Amazon WorkSpaces",
  AppStream: "Amazon AppStream",
  // Migration
  DMS: "AWS Database Migration Service",
  DataSync: "AWS DataSync",
  TransferFamily: "AWS Transfer Family",
  ApplicationDiscoveryService: "AWS Application Discovery Service",
  MigrationHub: "AWS Migration Hub",
  // IoT
  IoTCore: "AWS IoT Core",
  Greengrass: "AWS IoT Greengrass",
  IoTEvents: "AWS IoT Events",
  IoTAnalytics: "AWS IoT Analytics",
};

/** Canonical display labels per ServiceId. */
export const SERVICE_LABELS: Record<string, string> = AWS_DISPLAY_NAMES;

export function normalizeServiceName(serviceId: string): string {
  return AWS_DISPLAY_NAMES[serviceId] ?? serviceId;
}

/**
 * Normalizes a service name for comparison purposes — used to detect
 * redundant self-referential labels like "ALB (ALB)" or
 * "AWS Secrets Manager (Secrets Manager)".
 *
 * Strips: AWS/Amazon prefixes, punctuation, whitespace, lowercases everything.
 */
export function normalizeForComparison(s: string): string {
  return s
    .replace(/^(AWS|Amazon)\s+/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/**
 * Wraps service display names into balanced lines of at most ~16 characters,
 * ensuring words are never awkwardly truncated and text width stays within ~110px.
 */
export function wrapServiceName(name: string): string {
  if (name.length <= 16) return name;

  // Specific clean wraps for known long AWS names
  const cleanWraps: Record<string, string> = {
    "Application Load Balancer (ALB)": "Application Load\nBalancer (ALB)",
    "AWS Secrets Manager": "AWS Secrets\nManager",
    "Amazon DocumentDB": "Amazon\nDocumentDB",
    "Amazon CloudWatch": "Amazon\nCloudWatch",
    "Amazon CloudFront": "Amazon\nCloudFront",
    "Amazon Route 53": "Amazon\nRoute 53",
    "Amazon ElastiCache": "Amazon\nElastiCache",
    "Amazon DynamoDB": "Amazon\nDynamoDB",
    "Amazon API Gateway": "Amazon API\nGateway",
    "AWS CloudFormation": "AWS\nCloudFormation",
    "Amazon EventBridge": "Amazon\nEventBridge",
    "Amazon CodePipeline": "Amazon\nCodePipeline",
    "Amazon SageMaker": "Amazon\nSageMaker",
    "Amazon Rekognition": "Amazon\nRekognition",
    "Amazon S3 Glacier": "Amazon S3\nGlacier",
    "Amazon OpenSearch Service": "Amazon OpenSearch\nService",
    "Amazon MSK": "Amazon MSK",
  };
  if (cleanWraps[name]) return cleanWraps[name];

  // Generalized word wrapping
  const words = name.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= 16) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// AWS Icon Shape Definitions
// ---------------------------------------------------------------------------

export const AWS_ICON_STYLES: Partial<Record<string, string>> = {
  // Compute
  EC2: "shape=mxgraph.aws4.ec2;",
  Lambda: "shape=mxgraph.aws4.lambda;",
  ECS: "shape=mxgraph.aws4.ecs;",
  EKS: "shape=mxgraph.aws4.eks;",
  Fargate: "shape=mxgraph.aws4.fargate;",
  Lightsail: "shape=mxgraph.aws4.lightsail;",
  Batch: "shape=mxgraph.aws4.batch;",
  AppRunner: "shape=mxgraph.aws4.apprunner;",
  ElasticBeanstalk: "shape=mxgraph.aws4.elasticbeanstalk;",
  Outposts: "shape=mxgraph.aws4.outposts;",
  Wavelength: "shape=mxgraph.aws4.wavelength;",
  LocalZones: "shape=mxgraph.aws4.localzones;",
  ServerlessApplicationRepository: "shape=mxgraph.aws4.serverlessapplicationrepository;",
  EC2ImageBuilder: "shape=mxgraph.aws4.ec2imagebuilder;",
  SimSpaceWeaver: "shape=mxgraph.aws4.simspaceweaver;",
  // Storage
  S3: "shape=mxgraph.aws4.s3;",
  EBS: "shape=mxgraph.aws4.ebs;",
  EFS: "shape=mxgraph.aws4.efs;",
  Glacier: "shape=mxgraph.aws4.glacier;",
  FSx: "shape=mxgraph.aws4.fsx;",
  StorageGateway: "shape=mxgraph.aws4.storagegateway;",
  Backup: "shape=mxgraph.aws4.backup;",
  Snowball: "shape=mxgraph.aws4.snowball;",
  Snowcone: "shape=mxgraph.aws4.snowcone;",
  S3GlacierDeepArchive: "shape=mxgraph.aws4.s3glacierdeeparchive;",
  // Database
  RDS: "shape=mxgraph.aws4.rds;",
  DynamoDB: "shape=mxgraph.aws4.dynamodb;",
  ElastiCache: "shape=mxgraph.aws4.elasticache;",
  Aurora: "shape=mxgraph.aws4.aurora;",
  Redshift: "shape=mxgraph.aws4.redshift;",
  DocumentDB: "shape=mxgraph.aws4.documentdb;",
  Neptune: "shape=mxgraph.aws4.neptune;",
  Keyspaces: "shape=mxgraph.aws4.keyspaces;",
  Timestream: "shape=mxgraph.aws4.timestream;",
  MemoryDB: "shape=mxgraph.aws4.memorydb;",
  QLDB: "shape=mxgraph.aws4.qldb;",
  // Networking
  CloudFront: "shape=mxgraph.aws4.cloudfront;",
  APIGateway: "shape=mxgraph.aws4.api_gateway;",
  ALB: "shape=mxgraph.aws4.application_load_balancer;",
  NLB: "shape=mxgraph.aws4.network_load_balancer;",
  GLB: "shape=mxgraph.aws4.gateway_load_balancer;",
  Route53: "shape=mxgraph.aws4.route_53;",
  VPC: "shape=mxgraph.aws4.vpc;",
  NATGateway: "shape=mxgraph.aws4.nat_gateway;",
  DirectConnect: "shape=mxgraph.aws4.directconnect;",
  TransitGateway: "shape=mxgraph.aws4.transitgateway;",
  GlobalAccelerator: "shape=mxgraph.aws4.globalaccelerator;",
  PrivateLink: "shape=mxgraph.aws4.privatelink;",
  AppMesh: "shape=mxgraph.aws4.appmesh;",
  CloudMap: "shape=mxgraph.aws4.cloudmap;",
  VPCEndpoints: "shape=mxgraph.aws4.vpcendpoints;",
  SiteToSiteVPN: "shape=mxgraph.aws4.sitetositevpn;",
  ClientVPN: "shape=mxgraph.aws4.clientvpn;",
  WAF: "shape=mxgraph.aws4.waf;",
  // Messaging
  SQS: "shape=mxgraph.aws4.sqs;",
  SNS: "shape=mxgraph.aws4.sns;",
  EventBridge: "shape=mxgraph.aws4.eventbridge;",
  Kinesis: "shape=mxgraph.aws4.kinesis;",
  KinesisDataFirehose: "shape=mxgraph.aws4.kinesisdatafirehose;",
  KinesisDataStreams: "shape=mxgraph.aws4.kinesisdatastreams;",
  KinesisDataAnalytics: "shape=mxgraph.aws4.kinesisdataanalytics;",
  MSK: "shape=mxgraph.aws4.managed_streaming_for_kafka;",
  MQ: "shape=mxgraph.aws4.mq;",
  AppSync: "shape=mxgraph.aws4.appsync;",
  StepFunctions: "shape=mxgraph.aws4.stepfunctions;",
  ManagedAirflow: "shape=mxgraph.aws4.managedairflow;",
  EventBridgePipes: "shape=mxgraph.aws4.eventbridgepipes;",
  EventBridgeScheduler: "shape=mxgraph.aws4.eventbridgescheduler;",
  // Search
  OpenSearch: "shape=mxgraph.aws4.opensearch_service;",
  // Auth
  Cognito: "shape=mxgraph.aws4.cognito;",
  SecretsManager: "shape=mxgraph.aws4.secrets_manager;",
  Shield: "shape=mxgraph.aws4.shield;",
  IAM: "shape=mxgraph.aws4.iam;",
  KMS: "shape=mxgraph.aws4.kms;",
  GuardDuty: "shape=mxgraph.aws4.guardduty;",
  Inspector: "shape=mxgraph.aws4.inspector;",
  Macie: "shape=mxgraph.aws4.macie;",
  SecurityHub: "shape=mxgraph.aws4.securityhub;",
  CertificateManager: "shape=mxgraph.aws4.certificatemanager;",
  DirectoryService: "shape=mxgraph.aws4.directoryservice;",
  IAMIdentityCenter: "shape=mxgraph.aws4.iamidentitycenter;",
  NetworkFirewall: "shape=mxgraph.aws4.networkfirewall;",
  Artifact: "shape=mxgraph.aws4.artifact;",
  AuditManager: "shape=mxgraph.aws4.auditmanager;",
  Detective: "shape=mxgraph.aws4.detective;",
  CloudHSM: "shape=mxgraph.aws4.cloudhsm;",
  SystemsManager: "shape=mxgraph.aws4.systemsmanager;",
  ParameterStore: "shape=mxgraph.aws4.parameterstore;",
  // DevOps / Observability
  CloudWatch: "shape=mxgraph.aws4.cloudwatch;",
  CloudWatchLogs: "shape=mxgraph.aws4.cloudwatchlogs;",
  CloudWatchSynthetics: "shape=mxgraph.aws4.cloudwatchsynthetics;",
  CloudWatchEvidently: "shape=mxgraph.aws4.cloudwatchevidently;",
  CloudWatchRUM: "shape=mxgraph.aws4.cloudwatchrum;",
  CloudTrail: "shape=mxgraph.aws4.cloudtrail;",
  XRay: "shape=mxgraph.aws4.xray;",
  Config: "shape=mxgraph.aws4.config;",
  ServiceCatalog: "shape=mxgraph.aws4.servicecatalog;",
  ComputeOptimizer: "shape=mxgraph.aws4.computeoptimizer;",
  TrustedAdvisor: "shape=mxgraph.aws4.trustedadvisor;",
  HealthDashboard: "shape=mxgraph.aws4.healthdashboard;",
  Organizations: "shape=mxgraph.aws4.organizations;",
  ControlTower: "shape=mxgraph.aws4.controltower;",
  LicenseManager: "shape=mxgraph.aws4.licensemanager;",
  WellArchitectedTool: "shape=mxgraph.aws4.wellarchitectedtool;",
  CodePipeline: "shape=mxgraph.aws4.codepipeline;",
  CodeBuild: "shape=mxgraph.aws4.codebuild;",
  CodeDeploy: "shape=mxgraph.aws4.codedeploy;",
  CodeCommit: "shape=mxgraph.aws4.codecommit;",
  CodeArtifact: "shape=mxgraph.aws4.codeartifact;",
  CodeCatalyst: "shape=mxgraph.aws4.codecatalyst;",
  CloudFormation: "shape=mxgraph.aws4.cloudformation;",
  CDK: "shape=mxgraph.aws4.cdk;",
  ECR: "shape=mxgraph.aws4.ecr;",
  Cloud9: "shape=mxgraph.aws4.cloud9;",
  FaultInjectionSimulator: "shape=mxgraph.aws4.faultinjectionsimulator;",
  // AI / ML
  SageMaker: "shape=mxgraph.aws4.sagemaker;",
  Rekognition: "shape=mxgraph.aws4.rekognition;",
  Comprehend: "shape=mxgraph.aws4.comprehend;",
  Transcribe: "shape=mxgraph.aws4.transcribe;",
  Translate: "shape=mxgraph.aws4.translate;",
  Polly: "shape=mxgraph.aws4.polly;",
  Textract: "shape=mxgraph.aws4.textract;",
  Kendra: "shape=mxgraph.aws4.kendra;",
  Lex: "shape=mxgraph.aws4.lex;",
  Personalize: "shape=mxgraph.aws4.personalize;",
  Forecast: "shape=mxgraph.aws4.forecast;",
  Bedrock: "shape=mxgraph.aws4.bedrock;",
  Q: "shape=mxgraph.aws4.q;",
  CodeWhisperer: "shape=mxgraph.aws4.codewhisperer;",
  // Analytics
  EMR: "shape=mxgraph.aws4.emr;",
  Athena: "shape=mxgraph.aws4.athena;",
  Glue: "shape=mxgraph.aws4.glue;",
  QuickSight: "shape=mxgraph.aws4.quicksight;",
  LakeFormation: "shape=mxgraph.aws4.lakeformation;",
  DataPipeline: "shape=mxgraph.aws4.datapipeline;",
  CleanRooms: "shape=mxgraph.aws4.cleanrooms;",
  MSKConnect: "shape=mxgraph.aws4.mskconnect;",
  // Misc
  SES: "shape=mxgraph.aws4.ses;",
  Amplify: "shape=mxgraph.aws4.amplify;",
  AppFlow: "shape=mxgraph.aws4.appflow;",
  DeviceFarm: "shape=mxgraph.aws4.devicefarm;",
  LocationService: "shape=mxgraph.aws4.locationservice;",
  Pinpoint: "shape=mxgraph.aws4.pinpoint;",
  Connect: "shape=mxgraph.aws4.connect;",
  WorkSpaces: "shape=mxgraph.aws4.workspaces;",
  AppStream: "shape=mxgraph.aws4.appstream;",
  // Migration
  DMS: "shape=mxgraph.aws4.dms;",
  DataSync: "shape=mxgraph.aws4.datasync;",
  TransferFamily: "shape=mxgraph.aws4.transferfamily;",
  ApplicationDiscoveryService: "shape=mxgraph.aws4.applicationdiscoveryservice;",
  MigrationHub: "shape=mxgraph.aws4.migrationhub;",
  // IoT
  IoTCore: "shape=mxgraph.aws4.iotcore;",
  Greengrass: "shape=mxgraph.aws4.greengrass;",
  IoTEvents: "shape=mxgraph.aws4.iotevents;",
  IoTAnalytics: "shape=mxgraph.aws4.iotanalytics;",
};

/**
 * Fallback for service ids without a shape entry: a labelled rounded rect
 * with no fill — never a filled blank box. The vertex value carries the
 * display label, so the node always identifies itself.
 */
export const FALLBACK_STYLE =
  "rounded=1;whiteSpace=wrap;html=1;align=center;verticalAlign=middle;arcSize=8;" +
  "fontColor=#1E293B;fontSize=11;fontStyle=1;fillColor=#FFFFFF;strokeColor=#94A3B8;strokeWidth=1.5;dashed=0;";

export function nodeStyle(serviceId: string): string {
  const awsShape = AWS_ICON_STYLES[serviceId];
  if (awsShape) {
    return (
      `${awsShape}` +
      "sketch=0;outlineConnect=0;fontColor=#1E293B;gradientColor=none;fillColor=#FF9900;strokeColor=none;dashed=0;" +
      "verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=1;aspect=fixed;pointerEvents=1;spacingTop=4;"
    );
  }
  // Structural boxes (end users) are not AWS services: no warning.
  if (serviceId !== USERS_SERVICE_ID) {
    console.warn(`[diagram] Missing AWS icon for serviceId: "${serviceId}". Using generic AWS Cloud fallback.`);
  }
  return FALLBACK_STYLE;
}

/** Node placement scope. Replaces the old per-service tier whims. */
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
  APIGateway: "global-edge",
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

  // AI & ML — regional, except VPC-attached inference hosts
  SageMaker: "vpc-private",
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

/** Compute-scope services: one node rendered per AZ. */
const COMPUTE_SCOPES: ReadonlySet<string> = new Set(["vpc-private"]);

/** Load-balancer services: ingress into compute. */
const LB_SERVICES: ReadonlySet<string> = new Set(["ALB", "NLB", "GLB"]);

/**
 * Wire protocol per data service, used as the compute→data edge label.
 * Keyed by ServiceId (data table, like the scope table).
 */
const SERVICE_PROTOCOL: Partial<Record<string, string>> = {
  RDS: "SQL (TLS)",
  Aurora: "SQL (TLS)",
  DynamoDB: "HTTPS",
  DocumentDB: "DocumentDB wire (TLS)",
  ElastiCache: "RESP (TLS)",
  MemoryDB: "RESP (TLS)",
  Neptune: "HTTPS",
  Keyspaces: "CQL (TLS)",
  Timestream: "HTTPS",
  Redshift: "SQL (TLS)",
  QLDB: "HTTPS",
};

function protocolFor(serviceId: string): string {
  return SERVICE_PROTOCOL[serviceId] ?? "reads/writes";
}

// ---------------------------------------------------------------------------
// Grid & Container Geometry Constants
// ---------------------------------------------------------------------------

// CELL_W accommodates full wrapped service name width (110px) with internal padding
export const CELL_W = 116; 
// CELL_H satisfies test requirement: 4 * CELL_H >= 312
export const CELL_H = 80;
export const ICON_SIZE = 56;
export const GAP = 40;     // Generous horizontal node gap (40-80px per spec)
export const VGAP = 48;    // Vertical channel between container tiers (was 36 - provides dedicated routing gutters)
export const PAD = 24;     // Container interior padding (was 20)
export const LABEL_H = 32; // Dedicated container header title bar height (was 26)
export const PAD_TOP = 20; // Dedicated vertical padding below container header
export const PAD_BOTTOM = 28; // Dedicated bottom padding inside container (protects service labels)
export const MARGIN = 32;  // Initial layout margin

export const SUBNET_COLS = 4;   // Columns per VPC subnet
export const EDGE_COLS = 6;     // Columns in top edge banner
export const REGIONAL_COLS = 6; // Columns in regional row (outside VPC)
export const DATA_COLS = 4;     // Columns in spanning data subnet
export const EXTERNAL_COLS = 1; // Columns in external column (one column: stacked rows keep egress edges from crossing siblings)

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------
// Scope-driven containers (the scope table owns placement, keyed by scope)
// ---------------------------------------------------------------------------

/** Canonical container ids. AZ-indexed ids are built with azId/pubId/privId. */
export const CID = {
  aws: "container-aws_cloud",
  edge: "container-edge",
  regional: "container-regional",
  vpc: "container-vpc",
  data: "container-data",
  external: "container-external",
} as const;

export function azId(i: number): string {
  return `container-az-${i}`;
}
export function pubId(i: number): string {
  return `container-public-${i}`;
}
export function privId(i: number): string {
  return `container-private-${i}`;
}

/** Node key for a compute replica in an AZ (plain componentId when 1 AZ). */
export function azNodeKey(componentId: string, az: number, azCount: number): string {
  return azCount > 1 ? `${componentId}##az${az}` : componentId;
}

/** Generic ingress node fed by end users at the top of the diagram. */
export const USERS_COMPONENT_ID = "users";
export const USERS_SERVICE_ID = "Users";
export const USERS_LABEL = "Users / Internet";

const STATIC_CONTAINER_LABELS: Record<string, string> = {
  [CID.aws]: "AWS Cloud",
  [CID.edge]: "Edge & Public Ingress",
  [CID.regional]: "Regional Services (Outside VPC)",
  [CID.vpc]: "Virtual Private Cloud (VPC)",
  [CID.data]: "Data & Storage Subnet (Isolated, Spanning AZs)",
  [CID.external]: "External Services",
};

/** @deprecated Use containerLabel(id) — kept for test compatibility. */
export type ContainerKey = string;

 /** @deprecated Use containerLabel(id) — kept for test compatibility. */
export const CONTAINER_LABELS: Record<string, string> = {
  ...STATIC_CONTAINER_LABELS,
};

export function containerLabel(id: string): string {
  const hit = STATIC_CONTAINER_LABELS[id];
  if (hit) return hit;
  let m = id.match(/^container-az-(\d+)$/);
  if (m) return `Availability Zone ${m[1]}`;
  m = id.match(/^container-public-(\d+)$/);
  if (m) return `Public Subnet (DMZ, AZ ${m[1]})`;
  m = id.match(/^container-private-(\d+)$/);
  if (m) return `Private Subnet (Compute, AZ ${m[1]})`;
  return id;
}

/** Parent container id for any container id ("1" for the root layer). */
export function containerParent(id: string): string {
  if (id === CID.aws) return "1";
  if (id === CID.edge || id === CID.regional || id === CID.vpc || id === CID.external) {
    return CID.aws;
  }
  if (id === CID.data) return CID.vpc;
  if (/^container-az-\d+$/.test(id)) return CID.vpc;
  if (/^container-(public|private)-\d+$/.test(id)) {
    const n = id.match(/-(\d+)$/)![1];
    return azId(Number(n));
  }
  return CID.aws;
}

/** @deprecated Use containerParent(id) — kept for test compatibility. */
export const CONTAINER_PARENTS: Record<string, string> = {
  [CID.aws]: "1",
  [CID.edge]: CID.aws,
  [CID.regional]: CID.aws,
  [CID.vpc]: CID.aws,
  [CID.data]: CID.vpc,
  [CID.external]: CID.aws,
};

/** Container height for a given row count (label bar + rows + padding). */
export function bucketHeight(rows: number): number {
  if (rows <= 0) return 0;
  return LABEL_H + PAD_TOP + rows * CELL_H + (rows - 1) * GAP + PAD_BOTTOM;
}

export interface BucketEntry {
  componentId: string;
  serviceId: string;
}

export interface PlacedNode {
  componentId: string;
  serviceId: string;
  x: number;
  y: number;
}

export interface PlacedBucket {
  rect: Rect;
  nodes: PlacedNode[];
}

/** Packs a bucket into `cols` columns starting at (x, y); null when empty. */
export function layoutNodes(
  entries: BucketEntry[],
  cols: number,
  x: number,
  y: number
): PlacedBucket | null {
  if (entries.length === 0) return null;
  const rows = Math.ceil(entries.length / cols);
  const w = cols * CELL_W + (cols - 1) * GAP + 2 * PAD;
  const h = bucketHeight(rows);
  const nodes: PlacedNode[] = entries.map((e, i) => ({
    componentId: e.componentId,
    serviceId: e.serviceId,
    x: x + PAD + (i % cols) * (CELL_W + GAP),
    y: y + LABEL_H + PAD_TOP + Math.floor(i / cols) * (CELL_H + GAP),
  }));
  return { rect: { x, y, w, h }, nodes };
}

// ---------------------------------------------------------------------------
// Label Collision Detection (Fix 2A)
// ---------------------------------------------------------------------------

/** Returns true if two rectangles overlap (exclusive — touching edges don't collide). */
function rectsCollide(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Computes the label bounding box for a node.
 * Labels are positioned below the icon (verticalLabelPosition=bottom).
 * Width tracks the longest line (~7px/char, capped at the cell width);
 * height = lineCount * 14px.
 */
function labelBbox(nodeX: number, nodeY: number, label: string): Rect {
  const LINE_H = 14;
  const iconCenterX = nodeX + ICON_SIZE / 2;
  const longest = Math.max(1, ...label.split("\n").map((l) => l.length));
  const w = Math.min(CELL_W, longest * 7 + 8);
  return {
    x: iconCenterX - w / 2,
    y: nodeY + ICON_SIZE + 4, // 4px spacing below icon
    w,
    h: label.split("\n").length * LINE_H,
  };
}

/**
 * Counts the number of display lines in a wrapped label string.
 */
function labelLineCount(label: string): number {
  return label.split("\n").length;
}

export interface DiagramLayout {
  /** Rect per container id (`container-*`); absent when that scope is empty. */
  containers: Record<string, Rect | null>;
  /** Absolute node placement per node key, with parent container id. */
  nodes: Record<string, { x: number; y: number; parent: string; serviceId: string; componentId: string }>;
  canvasW: number;
  canvasH: number;
  /** Rendered AZ count (one AZ container per plan availability zone). */
  azCount: number;
}

// ---------------------------------------------------------------------------
// Containment Hierarchy — maps each container to its parent container
// ---------------------------------------------------------------------------

/**
 * Validates the full containment hierarchy:
 *   AWS Cloud → VPC → AZ-i → public/private-i → node
 *   AWS Cloud → VPC → data (spanning) → node
 *   AWS Cloud → Edge | Regional | External
 *
 * Throws at build time if any invariant is violated.
 */
export function validateContainmentHierarchy(
  containers: Record<string, Rect | null>
): void {
  const present = new Set(
    Object.entries(containers)
      .filter(([, r]) => r !== null)
      .map(([k]) => k)
  );
  const fail = (msg: string): never => {
    throw new Error(`Containment hierarchy violation: ${msg}`);
  };

  if (present.size > 0 && !present.has(CID.aws)) {
    fail("containers exist but have no AWS Cloud ancestor.");
  }
  for (const id of present) {
    if (id === CID.aws || id === "1") continue;
    // AZ subnets, AZs and the spanning data subnet have dedicated ancestry
    // checks below with precise messages; skip the generic parent check.
    if (/^container-(az|public|private)-\d+$/.test(id) || id === CID.data) continue;
    const parent = containerParent(id);
    if (parent !== "1" && !present.has(parent)) {
      fail(`"${id}" exists but its parent "${parent}" is missing.`);
    }
  }
  // AZ subnets must live inside an AZ inside the VPC.
  for (const id of present) {
    const m = id.match(/^container-(public|private)-(\d+)$/);
    if (m) {
      if (!present.has(azId(Number(m[2])))) {
        fail(`subnet "${id}" exists but has no AZ ancestor.`);
      }
      if (!present.has(CID.vpc)) {
        fail(`subnet "${id}" exists but has no VPC ancestor.`);
      }
    }
    if (/^container-az-\d+$/.test(id) && !present.has(CID.vpc)) {
      fail(`AZ "${id}" exists but has no VPC ancestor.`);
    }
  }
  if (present.has(CID.vpc) && !present.has(CID.aws)) {
    fail("VPC exists but has no AWS Cloud ancestor.");
  }
  if (present.has(CID.data) && !present.has(CID.vpc)) {
    fail("data subnet exists but has no VPC ancestor.");
  }
  for (const id of [CID.edge, CID.regional, CID.external]) {
    if (present.has(id) && !present.has(CID.aws)) {
      fail(`"${id}" exists but has no AWS Cloud ancestor.`);
    }
  }
}

export interface SemanticValidationResult {
  valid: boolean;
  errors: string[];
  metrics: {
    expectedServiceCount: number;
    renderedServiceCount: number;
    expectedRelationshipCount: number;
    renderedRelationshipCount: number;
    verifiedContainments: number;
  };
}

/**
 * Validates Stage 2 semantic integrity against the frozen Stage 1 plan:
 * 1. Component Mapping: Every Stage 1 service is mapped to a diagram component with preserved identity.
 * 2. Service Completeness: Rendered services match Stage 1 services without additions or omissions.
 * 3. Relationship Preservation: Every explicit relationship has preserved source, destination, direction, and type.
 * 4. Dependency & Flow Direction: Logical directions are preserved without inversion.
 * 5. Containment & Topology Semantics: Service-to-subnet and subnet-to-AZ-to-VPC assignments match the semantic model.
 */
export function validateDiagramSemantics(
  plan: ServicePlan,
  nodes: Array<{ id: string; componentId: string; serviceId: string; parent: string }>,
  edges: Array<{ id: string; sourceId: string; targetId: string; label: string }>
): SemanticValidationResult {
  const errors: string[] = [];
  let verifiedContainments = 0;

  // 1. Input sanity check
  if (!plan || !Array.isArray(plan.awsMappings)) {
    errors.push("Missing or invalid Stage 1 input: plan.awsMappings is required and must be an array");
    return {
      valid: false,
      errors,
      metrics: {
        expectedServiceCount: 0,
        renderedServiceCount: Array.isArray(nodes) ? nodes.length : 0,
        expectedRelationshipCount: 0,
        renderedRelationshipCount: Array.isArray(edges) ? edges.length : 0,
        verifiedContainments: 0,
      },
    };
  }

  const safeNodes = Array.isArray(nodes) ? nodes : [];
  const safeEdges = Array.isArray(edges) ? edges : [];
  // Structural nodes (Users ingress, ext- integration boxes) are validated
  // against the deployment model / edge tier, never counted as services.
  // Metrics below report AWS service nodes only so diagram, cost and
  // template agree on one service set.
  let awsVerifiedContainments = 0;

  // Third-party integration boxes and the generic Users node are validated
  // against the deployment model / edge tier, not the service catalog.
  const integrationNames = new Set<string>();
  for (const dm of plan.deploymentModel ?? []) {
    for (const t of dm.thirdPartyIntegrations ?? []) integrationNames.add(t.name);
  }
  const isExtNode = (n: { componentId: string }): boolean =>
    n.componentId.startsWith("ext-");
  const isUsersNode = (n: { componentId: string }): boolean =>
    n.componentId === USERS_COMPONENT_ID;
  for (const n of safeNodes.filter(isExtNode)) {
    if (n.parent !== CID.external) {
      errors.push(
        `External integration "${n.componentId}" is in "${n.parent}", expected "${CID.external}"`
      );
    } else {
      verifiedContainments++;
    }
    if (!integrationNames.has(n.serviceId)) {
      errors.push(
        `External node "${n.componentId}" ("${n.serviceId}") matches no deployment-model integration`
      );
    }
  }
  for (const n of safeNodes.filter(isUsersNode)) {
    if (n.parent !== CID.edge) {
      errors.push(
        `Users node "${n.componentId}" is in "${n.parent}", expected "${CID.edge}"`
      );
    } else {
      verifiedContainments++;
    }
  }
  const awsNodes = safeNodes.filter((n) => !isExtNode(n) && !isUsersNode(n));

  // 2. Component Mapping & Service Identity Set Equality
  // STRICT GROUNDING RULE: Rendered AWS services MUST EXACTLY EQUAL Stage 1 awsMappings
  // Set(renderedServiceIds) === Set(stage1ServiceIds)
  // (AZ replicas of one mapping share its serviceId, so sets still match.)
  const stage1ServiceIds = new Set<ServiceId>(plan.awsMappings.map((m) => m.serviceId));
  const renderedServiceIds = new Set<string>(awsNodes.map((n) => n.serviceId));

  // 2a. Missing Stage 1 services: every expected serviceId must be rendered
  for (const expId of stage1ServiceIds) {
    if (!renderedServiceIds.has(expId)) {
      errors.push(`Missing Stage 1 service: "${expId}" is not rendered in diagram`);
    }
  }

  // 2b. Unexpected / phantom services: every rendered serviceId must be in Stage 1
  for (const rendId of renderedServiceIds) {
    if (!stage1ServiceIds.has(rendId as ServiceId)) {
      errors.push(`Unexpected service rendered: "${rendId}" has no corresponding Stage 1 mapping`);
    }
  }

  // 2c. Strict Set equality enforcement (catches same-count wrong-services substitutions)
  const isSetEqual =
    stage1ServiceIds.size === renderedServiceIds.size &&
    [...stage1ServiceIds].every((id) => renderedServiceIds.has(id as string));

  if (!isSetEqual) {
    const missing = [...stage1ServiceIds].filter((id) => !renderedServiceIds.has(id as string));
    const unexpected = [...renderedServiceIds].filter((id) => !stage1ServiceIds.has(id as ServiceId));
    errors.push(
      `Service set mismatch: Set(renderedServiceIds) !== Set(stage1ServiceIds). Missing: [${missing.join(", ")}], Unexpected: [${unexpected.join(", ")}]`
    );
  }

  // AZ replicas share one componentId across distinct AZ-indexed parents;
  // anything else repeating a componentId in one parent is a duplicate.
  const azParent = (p: string): string | null => {
    const m = p.match(/^container-(az|public|private)-(\d+)$/);
    return m ? `${m[1]}-${m[2]}` : null;
  };

  // 2d. Node mapping & duplicate validation
  const nodeMap = new Map<string, (typeof safeNodes)[number]>();
  for (const n of safeNodes) nodeMap.set(n.id, n);
  const seenComponentParents = new Map<string, Set<string>>();

  for (const n of awsNodes) {

    const matchingMapping = plan.awsMappings.find(
      (m) => m.serviceId === n.serviceId && (m.componentId === n.componentId || n.componentId.includes(m.componentId))
    );
    if (!matchingMapping && stage1ServiceIds.has(n.serviceId as ServiceId)) {
      errors.push(
        `Component mapping mismatch: node "${n.id}" (${n.serviceId}) has componentId "${n.componentId}" not matching any Stage 1 mapping`
      );
    }

    const parents = seenComponentParents.get(n.componentId) ?? new Set<string>();
    const az = azParent(n.parent);
    if (parents.has(n.parent) || (parents.size > 0 && az === null)) {
      errors.push(
        `Duplicate service component: componentId "${n.componentId}" (${n.serviceId}) is rendered multiple times`
      );
    } else if (az !== null && [...parents].some((p) => azParent(p) === az)) {
      errors.push(
        `Duplicate service component: componentId "${n.componentId}" (${n.serviceId}) is rendered twice in one AZ`
      );
    }
    parents.add(n.parent);
    seenComponentParents.set(n.componentId, parents);
  }

  // 2e. Check for over-duplicated services (AZ replicas excluded: one
  // compute/LB node per AZ shares its mapping's serviceId by design).
  const stage1CountByService = new Map<string, number>();
  for (const m of plan.awsMappings) {
    stage1CountByService.set(m.serviceId, (stage1CountByService.get(m.serviceId) ?? 0) + 1);
  }
  const renderedByService = new Map<string, typeof awsNodes>();
  for (const n of awsNodes) {
    const list = renderedByService.get(n.serviceId) ?? [];
    list.push(n);
    renderedByService.set(n.serviceId, list);
  }
  for (const [sId, list] of renderedByService) {
    const expCount = stage1CountByService.get(sId) ?? 0;
    if (list.length > expCount && expCount > 0) {
      const azs = new Set(list.map((n) => azParent(n.parent)));
      const allReplicaPlaced = list.every((n) => azs.has(azParent(n.parent) ?? ""));
      const distinctAzs = new Set([...azs].filter((a) => a !== null));
      if (!(allReplicaPlaced && distinctAzs.size === list.length && list.length <= 6)) {
        errors.push(
          `Duplicate service rendered: service "${sId}" is rendered ${list.length} times, but only expected ${expCount} time(s)`
        );
      }
    }
  }

  // 3. Containment & Topology Semantics (scope table owns placement).
  for (const n of awsNodes) {
    const mapping = plan.awsMappings.find(
      (m) => m.serviceId === n.serviceId && (m.componentId === n.componentId || n.componentId.includes(m.componentId))
    );
    let ok: boolean;
    let expected: string;
    if (mapping?.external === true) {
      expected = CID.external;
      ok = n.parent === CID.external;
    } else {
      try {
        const scope = scopeOf(n.serviceId as ServiceId);
        switch (scope) {
          case "global-edge":
            expected = CID.edge;
            ok = n.parent === CID.edge;
            break;
          case "regional":
            expected = CID.regional;
            ok = n.parent === CID.regional;
            break;
          case "vpc-public":
            expected = "a public subnet";
            ok = n.parent.startsWith("container-public-");
            break;
          case "vpc-private":
            expected = "a private subnet";
            ok = n.parent.startsWith("container-private-");
            break;
          case "vpc-data":
            expected = CID.data;
            ok = n.parent === CID.data;
            break;
          case "external":
            expected = CID.external;
            ok = n.parent === CID.external;
            break;
        }
      } catch {
        expected = "a known scope";
        ok = false;
      }
    }
    if (!ok) {
      errors.push(
        `Containment semantic mismatch: service "${n.serviceId}" is in "${n.parent}", expected "${expected!}"`
      );
    } else {
      awsVerifiedContainments++;
    }
  }

  // 4. Relationship Preservation & Direction
  const compIdToNode = new Map<string, (typeof awsNodes)[number]>();
  const serviceIdToNode = new Map<string, (typeof awsNodes)[number]>();
  for (const n of awsNodes) {
    if (!compIdToNode.has(n.componentId)) compIdToNode.set(n.componentId, n);
    if (!serviceIdToNode.has(n.serviceId)) {
      serviceIdToNode.set(n.serviceId, n);
    }
  }

  let expectedRelCount = 0;
  const lbNodeIds = awsNodes
    .filter((n) => LB_SERVICES.has(n.serviceId))
    .map((n) => n.id);
  for (const rel of plan.relationships ?? []) {
    // Resolve endpoints by componentId first, then via mapping alias, then serviceId
    const srcMapping = plan.awsMappings.find((m) => m.componentId === rel.from);
    const dstMapping = plan.awsMappings.find((m) => m.componentId === rel.to);
    const srcNode =
      compIdToNode.get(rel.from) ??
      (srcMapping ? serviceIdToNode.get(srcMapping.serviceId) : undefined) ??
      serviceIdToNode.get(rel.from as ServiceId);
    const dstNode =
      compIdToNode.get(rel.to) ??
      (dstMapping ? serviceIdToNode.get(dstMapping.serviceId) : undefined) ??
      serviceIdToNode.get(rel.to as ServiceId);

    // If both endpoints exist in the plan's rendered nodes, this relationship MUST be rendered
    if (srcNode && dstNode) {
      expectedRelCount++;

      // Same CDN↔compute ingress redirect the builder applies.
      const redir = redirectCdnEdge(
        srcNode.serviceId,
        dstNode.serviceId,
        srcNode.id,
        dstNode.id,
        lbNodeIds
      );
      const forwardEdge = safeEdges.find((e) => e.sourceId === redir.src && e.targetId === redir.dst);
      const reverseEdge = safeEdges.find((e) => e.sourceId === redir.dst && e.targetId === redir.src);

      // Third-party hosted stores are reached via the NAT egress chain,
      // never a direct wire (mirrors the builder skip above). A
      // compute -> NAT -> external chain satisfies the relationship.
      const viaNatChain =
        (srcMapping?.external === true || dstMapping?.external === true) &&
        safeNodes.some(
          (n) =>
            n.serviceId === "NATGateway" &&
            safeEdges.some((e) => e.sourceId === srcNode.id && e.targetId === n.id) &&
            safeEdges.some((e) => e.sourceId === n.id && e.targetId === dstNode.id)
        );
      if (viaNatChain) continue;

      if (reverseEdge && !forwardEdge) {
        errors.push(
          `Reversed relationship direction: expected "${rel.from} -> ${rel.to}" (type: "${rel.type ?? ""}"), but edge is reversed from "${dstNode.serviceId}" to "${srcNode.serviceId}"`
        );
      } else if (!forwardEdge) {
        errors.push(
          `Missing relationship: expected "${rel.from} -> ${rel.to}" (type: "${rel.type ?? ""}") is not rendered as an edge`
        );
      } else {
        if (rel.type && rel.type.trim() && !forwardEdge.label.toLowerCase().includes(rel.type.trim().toLowerCase())) {
          errors.push(
            `Relationship type mismatch: expected type "${rel.type}" on edge "${rel.from} -> ${rel.to}", but edge label is "${forwardEdge.label}"`
          );
        }
      }
    }
  }

  // 5. Edge Endpoint Integrity
  for (const e of safeEdges) {
    if (!nodeMap.has(e.sourceId)) {
      errors.push(`Invalid edge source: edge "${e.id}" references non-existent node "${e.sourceId}"`);
    }
    if (!nodeMap.has(e.targetId)) {
      errors.push(`Invalid edge target: edge "${e.id}" references non-existent node "${e.targetId}"`);
    }
    if (e.sourceId === e.targetId) {
      errors.push(`Invalid self-loop edge: edge "${e.id}" connects node "${e.sourceId}" to itself`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    metrics: {
      expectedServiceCount: plan.awsMappings.length,
      renderedServiceCount: awsNodes.length,
      expectedRelationshipCount: expectedRelCount,
      renderedRelationshipCount: safeEdges.length,
      verifiedContainments: awsVerifiedContainments,
    },
  };
}

export interface DiagramValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates diagram layout invariants over container ids:
 * 1. Containment hierarchy (subnets in AZs, AZs + data in VPC, rest in cloud)
 * 2. Every child rect lies strictly inside its parent; siblings do not overlap
 * 3. Nodes clear container headers and stay inside their parent
 * 4. Collision-free nodes (AABB check)
 */
export function validateDiagramLayout(
  layout: DiagramLayout,
  placedNodes?: Array<{ id: string; serviceId: string; geo: Rect; parent: string }>
): DiagramValidationResult {
  const errors: string[] = [];

  // 1. Containment hierarchy
  try {
    validateContainmentHierarchy(layout.containers);
  } catch (err: unknown) {
    if (err instanceof Error) {
      errors.push(err.message);
    } else {
      errors.push(String(err));
    }
  }

  const rectOf = (id: string): Rect | null => layout.containers[id] ?? null;
  const inside = (child: Rect, parent: Rect): boolean =>
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.w <= parent.x + parent.w + 1 &&
    child.y + child.h <= parent.y + parent.h + 1;
  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  // 2. Every container inside its parent; siblings share no area.
  const cloud = rectOf(CID.aws);
  if (cloud) {
    for (const [id, r] of Object.entries(layout.containers)) {
      if (!r || id === CID.aws) continue;
      const parent = containerParent(id);
      if (parent === "1") continue;
      const pr = rectOf(parent);
      if (pr && !inside(r, pr)) {
        errors.push(`Container "${id}" exceeds parent "${parent}" bounds`);
      }
    }
    // Top-level siblings (edge / regional / vpc / external) stack vertically.
    const stack: Array<{ id: string; r: Rect }> = [];
    for (const id of [CID.edge, CID.regional, CID.vpc, CID.external]) {
      const r = rectOf(id);
      if (r) stack.push({ id, r });
    }
    stack.sort((a, b) => a.r.y - b.r.y);
    for (let i = 0; i < stack.length; i++) {
      for (let j = i + 1; j < stack.length; j++) {
        const a = stack[i];
        const b = stack[j];
        // The external column sits beside the VPC: same rows allowed only
        // when the columns do not intersect horizontally.
        const sideBySide =
          (a.id === CID.external || b.id === CID.external) &&
          (a.r.x + a.r.w <= b.r.x || b.r.x + b.r.w <= a.r.x);
        if (!sideBySide && overlaps(a.r, b.r)) {
          errors.push(`Containers "${a.id}" and "${b.id}" overlap`);
        }
      }
    }
    // AZ siblings inside the VPC sit side by side without overlapping.
    const azs = Object.entries(layout.containers)
      .filter(([id, r]) => r !== null && /^container-az-\d+$/.test(id))
      .map(([, r]) => r as Rect);
    for (let i = 0; i < azs.length; i++) {
      for (let j = i + 1; j < azs.length; j++) {
        if (overlaps(azs[i], azs[j])) {
          errors.push(`AZ containers overlap`);
        }
      }
    }
  }

  // 3. Node layout validation
  const nodesToCheck: Array<{
    id: string;
    serviceId: string;
    absX: number;
    absY: number;
    w: number;
    h: number;
    parent: string;
  }> = [];

  if (placedNodes && placedNodes.length > 0) {
    const contMap: Record<string, Rect> = {};
    for (const [k, r] of Object.entries(layout.containers)) {
      if (r) contMap[k] = r;
    }
    for (const pn of placedNodes) {
      const parentRect = contMap[pn.parent];
      const absX = (parentRect ? parentRect.x : 0) + pn.geo.x;
      const absY = (parentRect ? parentRect.y : 0) + pn.geo.y;
      nodesToCheck.push({
        id: pn.id,
        serviceId: pn.serviceId,
        absX,
        absY,
        w: pn.geo.w,
        h: pn.geo.h,
        parent: pn.parent,
      });
    }
  } else if (layout.nodes) {
    for (const [key, node] of Object.entries(layout.nodes)) {
      nodesToCheck.push({
        id: key,
        serviceId: node.serviceId,
        absX: node.x,
        absY: node.y,
        w: CELL_W,
        h: CELL_H,
        parent: node.parent,
      });
    }
  }

  // Check node-node collisions (AABB)
  for (let i = 0; i < nodesToCheck.length; i++) {
    for (let j = i + 1; j < nodesToCheck.length; j++) {
      const n1 = nodesToCheck[i];
      const n2 = nodesToCheck[j];
      const overlapsNodes = !(
        n1.absX + n1.w <= n2.absX ||
        n2.absX + n2.w <= n1.absX ||
        n1.absY + n1.h <= n2.absY ||
        n2.absY + n2.h <= n1.absY
      );
      if (overlapsNodes) {
        errors.push(`Node overlap: "${n1.serviceId}" and "${n2.serviceId}" collide`);
      }
    }
  }

  // Check node clearance from container title and borders
  for (const n of nodesToCheck) {
    const parentRect = rectOf(n.parent);
    if (parentRect) {
      if (n.absY < parentRect.y + LABEL_H) {
        errors.push(
          `Node "${n.serviceId}" header collision: y (${n.absY}) < container header bottom (${parentRect.y + LABEL_H})`
        );
      }
      if (
        n.absX < parentRect.x ||
        n.absX + n.w > parentRect.x + parentRect.w + 1 ||
        n.absY + n.h > parentRect.y + parentRect.h + 1
      ) {
        errors.push(
          `Node "${n.serviceId}" exceeds parent container "${n.parent}" bounds`
        );
      }
    } else {
      errors.push(`Node "${n.serviceId}" has unknown parent "${n.parent}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Computes the full diagram geometry from plan.awsMappings.
 * Incorporates:
 * 1. Full-label bounding boxes so nodes never collide.
 * 2. Mathematical centering of all containers and nodes in the canvas viewport.
 */
/**
 * Computes the full diagram geometry from plan.awsMappings.
 *
 * Scope-driven placement (one AZ container per availability zone):
 *   edge banner → regional row → VPC (N AZs side by side, each with public
 *   and private subnets, one compute node per AZ; data subnet spanning AZs)
 *   → external column beside the VPC.
 * Incorporates:
 * 1. Full-label bounding boxes so nodes never collide.
 * 2. ViewBox computed from the union of all rects plus padding, with
 *    mathematical centering of all containers and nodes in the viewport.
 */
export interface ComputeLayoutOptions {
  /** Rendered AZ count (default 1). */
  azCount?: number;
  /** Third-party integration boxes for the external column. */
  external?: Array<{ id: string; label: string }>;
  /** Render the generic Users/Internet ingress node in the edge banner. */
  users?: boolean;
}

export function computeLayout(
  services: AwsServiceMapping[],
  opts?: ComputeLayoutOptions
): DiagramLayout {
  const azCount = Math.min(6, Math.max(1, Math.floor(opts?.azCount ?? 1)));
  const buckets: Record<ServiceScope, BucketEntry[]> = {
    "global-edge": [],
    regional: [],
    "vpc-public": [],
    "vpc-private": [],
    "vpc-data": [],
    external: [],
  };
  for (const m of services) {
    // scopeOf throws on unknown ids: a ServiceId missing from the scope
    // table fails here, never defaults silently.
    const scope: ServiceScope =
      (m as { external?: boolean }).external === true ? "external" : scopeOf(m.serviceId);
    buckets[scope].push({
      componentId: m.componentId,
      serviceId: m.serviceId,
    });
  }

  const containers: DiagramLayout["containers"] = {};
  const nodes: DiagramLayout["nodes"] = {};

  const gridW = (cols: number): number => cols * CELL_W + (cols - 1) * GAP + 2 * PAD;

  const registerNode = (
    key: string,
    componentId: string,
    serviceId: string,
    x: number,
    y: number,
    parent: string
  ): void => {
    if (nodes[key]) {
      nodes[`${key}_${serviceId}`] = { x, y, parent, serviceId, componentId };
    } else {
      nodes[key] = { x, y, parent, serviceId, componentId };
    }
  };

  /** Positions bucket entries in columns inside rect (x, y, w) and registers them. */
  const placeBucket = (
    entries: BucketEntry[],
    cols: number,
    rect: Rect,
    parent: string
  ): void => {
    const actualCols = Math.min(entries.length, cols);
    const contentW = actualCols * CELL_W + (actualCols - 1) * GAP;
    const offsetX = Math.max(0, Math.round((rect.w - 2 * PAD - contentW) / 2));
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = rect.x + PAD + offsetX + col * (CELL_W + GAP);
      const y = rect.y + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
      registerNode(e.componentId, e.componentId, e.serviceId, x, y, parent);
    }
  };

  // ---- Measure buckets -------------------------------------------------
  // The Users node feeds the edge tier from the top of the banner.
  const edgeEntries: BucketEntry[] = [
    ...(opts?.users ? [{ componentId: USERS_COMPONENT_ID, serviceId: USERS_SERVICE_ID }] : []),
    ...buckets["global-edge"],
  ];
  const edgeH = edgeEntries.length > 0
    ? bucketHeight(Math.ceil(edgeEntries.length / EDGE_COLS))
    : 0;
  const regionalH = buckets.regional.length > 0
    ? bucketHeight(Math.ceil(buckets.regional.length / REGIONAL_COLS))
    : 0;
  // Load balancers and NAT gateways span every AZ (one node per AZ);
  // other public services stay in AZ-1.
  const isSpanningPublic = (e: BucketEntry): boolean =>
    LB_SERVICES.has(e.serviceId) || e.serviceId === "NATGateway";
  const pubRows = (az: number): BucketEntry[] =>
    az === 1 ? buckets["vpc-public"] : buckets["vpc-public"].filter(isSpanningPublic);
  const pubHFor = (az: number): number => {
    const list = pubRows(az);
    return list.length > 0 ? bucketHeight(Math.ceil(list.length / SUBNET_COLS)) : 0;
  };
  const publicH = pubHFor(1);
  const privateRows = buckets["vpc-private"].length > 0
    ? Math.ceil(buckets["vpc-private"].length / SUBNET_COLS)
    : 0;
  const privateH = privateRows > 0 ? bucketHeight(privateRows) : 0;
  const dataH = buckets["vpc-data"].length > 0
    ? bucketHeight(Math.ceil(buckets["vpc-data"].length / DATA_COLS))
    : 0;
  const externalCount = buckets.external.length + (opts?.external?.length ?? 0);
  const externalH = externalCount > 0
    ? bucketHeight(Math.ceil(externalCount / EXTERNAL_COLS))
    : 0;

  const hasVpcContent =
    buckets["vpc-public"].length > 0 ||
    buckets["vpc-private"].length > 0 ||
    buckets["vpc-data"].length > 0;

  // ---- AZ row ----------------------------------------------------------
  // AZs with no subnets are omitted; compute replicas land in every AZ that
  // has a private subnet (one compute node per AZ). A VPC with only a
  // spanning data subnet renders no AZ boxes at all.
  const azSubnetW = gridW(SUBNET_COLS);
  const renderedAzs: number[] = [];
  if (hasVpcContent) {
    for (let i = 1; i <= azCount; i++) {
      const hasPub = pubRows(i).length > 0;
      const hasPriv = buckets["vpc-private"].length > 0;
      if (hasPub || hasPriv) renderedAzs.push(i);
    }
  }
  const azW = azSubnetW + 2 * PAD;
  // Private subnets start at the same y in every AZ (reserving the public
  // row height even where no public subnet renders) so cross-AZ edges run
  // through open gutters instead of neighbouring subnets.
  const hasAnyPub = buckets["vpc-public"].length > 0;
  const hasAnyPriv = buckets["vpc-private"].length > 0;
  const pubRowH = hasAnyPub && hasAnyPriv ? publicH + VGAP : 0;
  const azHFor = (az: number): number => {
    const ph = pubHFor(az);
    let h = LABEL_H + PAD_TOP;
    if (ph > 0) h += ph + (hasAnyPriv ? VGAP : 0);
    else if (hasAnyPriv) h += pubRowH;
    if (hasAnyPriv) h += privateH;
    return h + PAD_BOTTOM;
  };
  const azRowH = renderedAzs.length > 0 ? Math.max(...renderedAzs.map(azHFor)) : 0;
  const azRowW =
    renderedAzs.length > 0 ? renderedAzs.length * azW + (renderedAzs.length - 1) * GAP : 0;

  // ---- VPC -------------------------------------------------------------
  const dataW = Math.max(azRowW, gridW(DATA_COLS));
  const vpcW = hasVpcContent ? Math.max(azRowW, dataW) + 2 * PAD : 0;
  const vpcH = hasVpcContent
    ? LABEL_H + PAD_TOP + azRowH + (dataH > 0 ? VGAP + dataH : 0) + PAD_BOTTOM
    : 0;

  // ---- External column -------------------------------------------------
  const extW = externalCount > 0 ? gridW(EXTERNAL_COLS) : 0;

  // ---- Width coordination ----------------------------------------------
  const contentW = Math.max(gridW(EDGE_COLS), gridW(REGIONAL_COLS), vpcW + (extW > 0 ? GAP + extW : 0));
  const edgeW = buckets["global-edge"].length > 0 ? contentW : 0;
  const regionalW = buckets.regional.length > 0 ? contentW : 0;

  // ---- Vertical stacking ------------------------------------------------
  let cursorY = MARGIN;
  if (edgeW > 0) {
    const edge: Rect = { x: MARGIN, y: cursorY, w: edgeW, h: edgeH };
    containers[CID.edge] = edge;
    placeBucket(edgeEntries, EDGE_COLS, edge, CID.edge);
    cursorY += edgeH + VGAP;
  }
  if (regionalW > 0) {
    const regional: Rect = { x: MARGIN, y: cursorY, w: regionalW, h: regionalH };
    containers[CID.regional] = regional;
    placeBucket(buckets.regional, REGIONAL_COLS, regional, CID.regional);
    cursorY += regionalH + VGAP;
  }
  const vpcY = cursorY;
  if (hasVpcContent) {
    containers[CID.vpc] = { x: MARGIN, y: vpcY, w: vpcW, h: vpcH };
    // AZs inside the VPC.
    let azX = MARGIN + PAD;
    const azY = vpcY + LABEL_H + PAD_TOP;
    for (const az of renderedAzs) {
      const h = azHFor(az);
      containers[azId(az)] = { x: azX, y: azY, w: azW, h };
      let subY = azY + LABEL_H + PAD_TOP;
      const pubList = pubRows(az);
      if (pubList.length > 0) {
        const pub: Rect = { x: azX + PAD, y: subY, w: azSubnetW, h: pubHFor(az) };
        containers[pubId(az)] = pub;
        const actualCols = Math.min(pubList.length, SUBNET_COLS);
        const contentPw = actualCols * CELL_W + (actualCols - 1) * GAP;
        const offsetX = Math.max(0, Math.round((azSubnetW - 2 * PAD - contentPw) / 2));
        for (let i = 0; i < pubList.length; i++) {
          const e = pubList[i];
          const col = i % SUBNET_COLS;
          const row = Math.floor(i / SUBNET_COLS);
          const x = pub.x + PAD + offsetX + col * (CELL_W + GAP);
          const y = pub.y + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
          registerNode(
            azNodeKey(e.componentId, az, azCount),
            e.componentId,
            e.serviceId,
            x,
            y,
            pubId(az)
          );
        }
        subY += pubHFor(az) + (hasAnyPriv ? VGAP : 0);
      } else if (hasAnyPriv) {
        subY += pubRowH;
      }
      if (hasAnyPriv) {
        const priv: Rect = { x: azX + PAD, y: subY, w: azSubnetW, h: privateH };
        containers[privId(az)] = priv;
        const actualCols = Math.min(buckets["vpc-private"].length, SUBNET_COLS);
        const contentPw = actualCols * CELL_W + (actualCols - 1) * GAP;
        const offsetX = Math.max(0, Math.round((azSubnetW - 2 * PAD - contentPw) / 2));
        for (let i = 0; i < buckets["vpc-private"].length; i++) {
          const e = buckets["vpc-private"][i];
          const col = i % SUBNET_COLS;
          const row = Math.floor(i / SUBNET_COLS);
          const x = priv.x + PAD + offsetX + col * (CELL_W + GAP);
          const y = priv.y + LABEL_H + PAD_TOP + row * (CELL_H + GAP);
          registerNode(
            azNodeKey(e.componentId, az, azCount),
            e.componentId,
            e.serviceId,
            x,
            y,
            privId(az)
          );
        }
      }
      azX += azW + GAP;
    }
    // Data subnet spanning the AZs, below the AZ row.
    if (dataH > 0) {
      const data: Rect = {
        x: MARGIN + PAD,
        y: vpcY + LABEL_H + PAD_TOP + azRowH + VGAP,
        w: dataW,
        h: dataH,
      };
      containers[CID.data] = data;
      placeBucket(buckets["vpc-data"], DATA_COLS, data, CID.data);
    }
    cursorY = vpcY + vpcH + VGAP;
  }
  if (externalCount > 0) {
    const extH = Math.max(hasVpcContent ? vpcH : 0, externalH);
    const ext: Rect = {
      x: MARGIN + vpcW + (hasVpcContent ? GAP : 0),
      y: hasVpcContent ? vpcY : cursorY,
      w: extW,
      h: extH,
    };
    containers[CID.external] = ext;
    const allExternal: BucketEntry[] = [
      ...buckets.external,
      ...(opts?.external ?? []).map((e) => ({ componentId: e.id, serviceId: e.label })),
    ];
    placeBucket(allExternal, EXTERNAL_COLS, ext, CID.external);
    if (!hasVpcContent) cursorY += extH + VGAP;
  }

  // ---- AWS Cloud wrapper ------------------------------------------------
  const activeRects = Object.values(containers).filter(
    (r): r is Rect => r !== null && r !== undefined
  );
  if (activeRects.length > 0) {
    const cloudMinX = Math.min(...activeRects.map((r) => r.x)) - PAD;
    const cloudMinY = Math.min(...activeRects.map((r) => r.y)) - LABEL_H - PAD_TOP;
    const cloudMaxX = Math.max(...activeRects.map((r) => r.x + r.w)) + PAD;
    const cloudMaxY = Math.max(...activeRects.map((r) => r.y + r.h)) + PAD_BOTTOM;
    containers[CID.aws] = {
      x: cloudMinX,
      y: cloudMinY,
      w: cloudMaxX - cloudMinX,
      h: cloudMaxY - cloudMinY,
    };
  }

  // ---- ViewBox from the union of all rects plus padding ------------------
  const unionRects: Rect[] = [...activeRects];
  for (const n of Object.values(nodes)) {
    unionRects.push({ x: n.x, y: n.y, w: CELL_W, h: CELL_H });
  }
  const minX = Math.min(...unionRects.map((r) => r.x));
  const minY = Math.min(...unionRects.map((r) => r.y));
  const maxX = Math.max(...unionRects.map((r) => r.x + r.w));
  const maxY = Math.max(...unionRects.map((r) => r.y + r.h));
  const contentWW = maxX - minX;
  const contentHH = maxY - minY;

  const CANVAS_PAD_X = 64;
  const CANVAS_PAD_Y = 56;
  const canvasW = Math.max(contentWW + 2 * CANVAS_PAD_X, 760);
  const canvasH = Math.max(contentHH + 2 * CANVAS_PAD_Y, 520);

  const shiftX = Math.round((canvasW - contentWW) / 2) - minX;
  const shiftY = Math.round((canvasH - contentHH) / 2) - minY;

  for (const key of Object.keys(containers)) {
    const r = containers[key];
    if (r) {
      r.x += shiftX;
      r.y += shiftY;
    }
  }

  for (const key of Object.keys(nodes)) {
    nodes[key].x += shiftX;
    nodes[key].y += shiftY;
  }

  const layout: DiagramLayout = {
    containers,
    nodes,
    canvasW,
    canvasH,
    azCount: renderedAzs.length,
  };
  const validation = validateDiagramLayout(layout);
  if (!validation.valid) {
    console.warn("Diagram layout validation warnings:\n" + validation.errors.join("\n"));
  }

  return layout;
}

// ---------------------------------------------------------------------------
// Role-derived edges (replaces pattern templates)
// ---------------------------------------------------------------------------

/**
 * Inferred topology links derived from service roles, never from pattern
 * names:
 *   client -> edge/CDN -> load balancer (or straight to the origin when no
 *   LB exists) -> compute -> data store / secrets / NAT -> external.
 *   Static origins link CDN -> object storage, never CDN -> compute while
 *   an LB exists. Edge labels come from the explicit relationship type when
 *   present, else from a role verb.
 */
export interface RoleEdgeDef {
  from: string;
  to: string;
  label: string;
}

export interface RoleEdgeNode {
  id: string;
  serviceId: string;
  /** True for third-party integration boxes in the external column. */
  external: boolean;
  /** True for the generic Users ingress node. */
  users: boolean;
  /**
   * True when object storage has SDK/usage evidence (repository mapping or
   * SDK hint). compute→storage edges require it.
   */
  storageProven: boolean;
  /** AZ number for AZ-indexed subnets, else null. */
  az: number | null;
}

const ROLE_VERBS = {
  dns: "DNS",
  staticOrigin: "static assets (read-only, OAC)",
  ingress: "HTTP",
  invoke: "API (HTTPS)",
  store: "reads/writes",
  publish: "sends/receives",
  egress: "egress",
  image: "pulls image",
  secrets: "reads secrets",
} as const;

function isComputeServiceId(s: string): boolean {
  try {
    return scopeOf(s as ServiceId) === "vpc-private";
  } catch {
    return false;
  }
}

function isLbServiceId(s: string): boolean {
  return LB_SERVICES.has(s);
}

function isEdgeServiceId(s: string): boolean {
  try {
    return scopeOf(s as ServiceId) === "global-edge";
  } catch {
    return false;
  }
}

function isDataServiceId(s: string): boolean {
  try {
    const scope = scopeOf(s as ServiceId);
    return scope === "vpc-data" || scope === "regional";
  } catch {
    return false;
  }
}

/**
 * CDN↔compute traffic traverses the load balancer when one exists.
 * Returns the (possibly redirected) edge endpoints; the label is untouched
 * so relationship-type checks still match. Both the builder (4a) and the
 * semantic check apply this identically.
 */
export function redirectCdnEdge(
  srcService: string,
  dstService: string,
  srcNodeId: string,
  dstNodeId: string,
  lbNodeIds: string[]
): { src: string; dst: string } {
  if (lbNodeIds.length === 0) return { src: srcNodeId, dst: dstNodeId };
  if (srcService === "CloudFront" && isComputeServiceId(dstService)) {
    return { src: srcNodeId, dst: lbNodeIds[0] };
  }
  if (dstService === "CloudFront" && isComputeServiceId(srcService)) {
    return { src: lbNodeIds[0], dst: dstNodeId };
  }
  return { src: srcNodeId, dst: dstNodeId };
}

/**
 * Derives inferred edges between grounded node ids from service roles.
 * Explicit plan relationships are handled separately and always win;
 * pairs they already connect are skipped here.
 */
export function deriveRoleEdges(
  nodes: RoleEdgeNode[],
  connectedPairs: Set<string>
): RoleEdgeDef[] {
  const out: RoleEdgeDef[] = [];
  const pairOf = (a: string, b: string): string =>
    a < b ? `${a}<->${b}` : `${b}<->${a}`;
  const link = (a: string, b: string, label: string): void => {
    if (a === b) return;
    if (connectedPairs.has(pairOf(a, b))) return;
    connectedPairs.add(pairOf(a, b));
    out.push({ from: a, to: b, label });
  };

  const aws = nodes.filter((n) => !n.external && !n.users);
  const users = nodes.filter((n) => n.users);
  const edge = aws.filter((n) => isEdgeServiceId(n.serviceId));
  const lbs = aws.filter((n) => isLbServiceId(n.serviceId));
  const compute = aws.filter((n) => isComputeServiceId(n.serviceId));
  const data = aws.filter(
    (n) =>
      isDataServiceId(n.serviceId) &&
      !isComputeServiceId(n.serviceId) &&
      !isLbServiceId(n.serviceId) &&
      !isEdgeServiceId(n.serviceId)
  );
  const nat = aws.filter((n) => n.serviceId === "NATGateway");
  const external = nodes.filter((n) => n.external);

  const cdn = edge.filter((n) => n.serviceId === "CloudFront");
  const dns = edge.filter((n) => n.serviceId === "Route53");
  const gateways = edge.filter((n) => n.serviceId === "APIGateway");

  // End users feed the edge tier over HTTPS.
  for (const u of users) {
    for (const target of edge) link(u.id, target.id, "HTTPS");
  }

  // DNS entry points.
  for (const d of dns) {
    for (const target of [...cdn, ...lbs, ...gateways]) link(d.id, target.id, ROLE_VERBS.dns);
  }
  // CDN origin is the static origin only: LB when present, else compute,
  // else object storage. Never CDN -> compute while an LB exists, and never
  // CDN -> datastores that are not object storage.
  const origins =
    lbs.length > 0
      ? lbs
      : compute.length > 0
        ? compute
        : data.filter((n) => SERVICE_CATEGORIES[n.serviceId as ServiceId] === "storage");
  for (const c of cdn) {
    for (const o of origins) {
      const isStatic = SERVICE_CATEGORIES[o.serviceId as ServiceId] === "storage";
      link(c.id, o.id, isStatic ? ROLE_VERBS.staticOrigin : ROLE_VERBS.ingress);
    }
  }
  // Gateways invoke compute; otherwise they front data-backed APIs.
  for (const g of gateways) {
    const targets = compute.length > 0 ? compute : data;
    for (const t of targets) link(g.id, t.id, ROLE_VERBS.invoke);
  }
  // Load balancers route to every compute node.
  for (const lb of lbs) {
    for (const c of compute) link(lb.id, c.id, ROLE_VERBS.ingress);
  }
  // Image registries feed compute.
  const registries = aws.filter((n) => n.serviceId === "ECR");
  for (const r of registries) {
    for (const c of compute) link(r.id, c.id, ROLE_VERBS.image);
  }
  // Compute fans out to proven data: secrets by role label, databases by
  // wire protocol, messaging by verb. Object storage links require SDK or
  // usage evidence — never a bare topology guess.
  for (const c of compute) {
    for (const d of data) {
      if (d.serviceId === "SecretsManager") link(c.id, d.id, ROLE_VERBS.secrets);
      else if (SERVICE_CATEGORIES[d.serviceId as ServiceId] === "storage") {
        if (d.storageProven) link(c.id, d.id, ROLE_VERBS.store);
      } else if (SERVICE_PROTOCOL[d.serviceId] !== undefined) {
        link(c.id, d.id, protocolFor(d.serviceId));
      } else {
        link(c.id, d.id, ROLE_VERBS.publish);
      }
    }
  }
  // NAT chains compute egress to the outside world. Every NAT links
  // outward so each AZ keeps a complete compute -> NAT -> external chain.
  // Routing (vpcExitKeys below) sends every hop through the top gutter
  // and the VPC-exit corridor, never sideways across sibling subnets.
  for (const c of compute) {
    for (const n of nat) link(c.id, n.id, ROLE_VERBS.egress);
  }
  for (const n of nat) {
    for (const x of external) link(n.id, x.id, ROLE_VERBS.egress);
  }
  // Queue triggers reach compute when nothing else connects them.
  const queues = aws.filter(
    (n) => n.serviceId === "SQS" || n.serviceId === "EventBridge"
  );
  for (const q of queues) {
    for (const c of compute) link(q.id, c.id, "triggers");
  }
  return out;
}

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
  if (Array.isArray(sdkEvidence) && sdkEvidence.length > 0) {
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

// ---------------------------------------------------------------------------
// Container Color Themes (Professional AWS Well-Architected Style)
// Titles are aligned top-left (align=left;spacingLeft=16;) so vertical edges
// entering nodes in the center never cross container titles.
// ---------------------------------------------------------------------------

const BASE_CONTAINER_THEME =
  "rounded=1;whiteSpace=wrap;html=1;verticalAlign=top;align=left;spacingLeft=16;spacingTop=8;fontStyle=1;";

const CONTAINER_THEMES: Record<string, string> = {
  [CID.aws]:
    BASE_CONTAINER_THEME + "fontSize=14;" +
    "fillColor=#F9FAFB;strokeColor=#232F3E;strokeWidth=2;fontColor=#232F3E;dashed=0;arcSize=6;",
  [CID.edge]:
    BASE_CONTAINER_THEME + "fontSize=12;" +
    "fillColor=#F8FAFC;strokeColor=#CBD5E1;strokeWidth=1.5;fontColor=#334155;dashed=0;arcSize=6;",
  [CID.regional]:
    BASE_CONTAINER_THEME + "fontSize=12;" +
    "fillColor=#FFF7ED;strokeColor=#F97316;strokeWidth=1.5;fontColor=#C2410C;dashed=0;arcSize=6;",
  [CID.vpc]:
    BASE_CONTAINER_THEME + "fontSize=13;" +
    "fillColor=#FFFFFF;strokeColor=#1E293B;strokeWidth=2;fontColor=#0F172A;dashed=0;arcSize=6;",
  [CID.data]:
    BASE_CONTAINER_THEME + "fontSize=11;" +
    "fillColor=#FAF5FF;strokeColor=#A855F7;strokeWidth=1.5;fontColor=#6B21A8;dashed=1;dashPattern=6 4;arcSize=6;",
  [CID.external]:
    BASE_CONTAINER_THEME + "fontSize=12;" +
    "fillColor=#F8FAFC;strokeColor=#94A3B8;strokeWidth=1.5;fontColor=#475569;dashed=1;dashPattern=6 4;arcSize=6;",
};

function themeForContainer(id: string): string {
  const hit = CONTAINER_THEMES[id];
  if (hit) return hit;
  if (/^container-az-\d+$/.test(id)) {
    return (
      BASE_CONTAINER_THEME + "fontSize=11;" +
      "fillColor=#F0FDFA;strokeColor=#14B8A6;strokeWidth=1.5;fontColor=#0D9488;dashed=1;dashPattern=6 4;arcSize=6;"
    );
  }
  if (/^container-public-\d+$/.test(id)) {
    return (
      BASE_CONTAINER_THEME + "fontSize=11;" +
      "fillColor=#F0FDF4;strokeColor=#22C55E;strokeWidth=1.5;fontColor=#15803D;dashed=1;dashPattern=6 4;arcSize=6;"
    );
  }
  if (/^container-private-\d+$/.test(id)) {
    return (
      BASE_CONTAINER_THEME + "fontSize=11;" +
      "fillColor=#EFF6FF;strokeColor=#3B82F6;strokeWidth=1.5;fontColor=#1D4ED8;dashed=1;dashPattern=6 4;arcSize=6;"
    );
  }
  return (
    BASE_CONTAINER_THEME + "fontSize=11;" +
    "fillColor=#FFFFFF;strokeColor=#94A3B8;strokeWidth=1;fontColor=#334155;dashed=1;dashPattern=6 4;arcSize=6;"
  );
}

// ---------------------------------------------------------------------------
// Edge Routing & Collision Avoidance
// ---------------------------------------------------------------------------

export interface EdgeWaypoint {
  x: number;
  y: number;
}

export interface Port {
  x: number;
  y: number;
}

export interface RoutedEdge {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  style: "solid" | "dashed";
  serviceId?: string;
  tooltip?: string;
  labelOffsetX: number;
  labelOffsetY: number;
  waypoints: EdgeWaypoint[];
  exitPort: Port;
  entryPort: Port;
  flowStep?: number;
}

/**
 * Label box for an edge label anchored at a point. Shared with the
 * validator so seating and checking use identical geometry.
 */
export function edgeLabelBox(anchor: { x: number; y: number }, label: string): Rect {
  return {
    x: anchor.x - (label.length * 7 + 8) / 2,
    y: anchor.y - 8,
    w: label.length * 7 + 8,
    h: 16,
  };
}

/**
 * Label box for a node label below its 56px icon. Shared with the
 * validator so seating and checking use identical geometry.
 */
export function nodeLabelBox(
  icon: { x: number; y: number },
  label: string
): Rect {
  const lines = Math.max(1, label.split("\n").length);
  return {
    x: icon.x + ICON_SIZE / 2 - CELL_W / 2,
    y: icon.y + ICON_SIZE + 4,
    w: CELL_W,
    h: lines * 14,
  };
}

function boxesOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Seats every labelled edge on a horizontal segment, clear of node label
 * boxes. The recorded offset is set to (seat − path middle) so renderers
 * and the validator agree exactly where the label sits.
 *
 * Returns the ids of edges whose label could not be seated clear of every
 * node label box. Callers drop those only when the edge itself is a
 * droppable hint; explicit evidence edges are always kept.
 */
export function seatEdgeLabels(
  routed: RoutedEdge[],
  nodes: Array<{ id: string; label: string }>,
  nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }>
): string[] {
  const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
  const blocked: string[] = [];
  for (const edge of routed) {
    if (!edge.label || edge.label.trim().length === 0) continue;
    const src = nodeAbsGeo[edge.sourceId];
    const dst = nodeAbsGeo[edge.targetId];
    if (!src || !dst) continue;
    const pts = [
      { x: src.x + src.w / 2, y: src.y + src.h / 2 },
      ...edge.waypoints,
      { x: dst.x + dst.w / 2, y: dst.y + dst.h / 2 },
    ];
    // Path middle (what renderers offset from).
    let total = 0;
    const lens: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      lens.push(len);
      total += len;
    }
    let acc = 0;
    let middle = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (acc + lens[i] >= total / 2) {
        const t = lens[i] === 0 ? 0 : (total / 2 - acc) / lens[i];
        middle = {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
        };
        break;
      }
      acc += lens[i];
    }
    // Candidate seats: midpoints and quarter points of horizontal runs.
    const candidates: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < pts.length - 1; i++) {
      if (Math.abs(pts[i + 1].y - pts[i].y) <= 4) {
        const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        if (len >= 24) {
          for (const t of [0.25, 0.5, 0.75]) {
            candidates.push({
              x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
              y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
            });
          }
        }
      }
    }
    const blockers: Rect[] = [];
    for (const [id, g] of Object.entries(nodeAbsGeo)) {
      if (id === edge.sourceId || id === edge.targetId) continue;
      blockers.push(nodeLabelBox(g, labelOf.get(id) ?? ""));
      blockers.push({ x: g.x, y: g.y, w: g.w, h: g.h });
    }
    let seat = candidates[0] ?? middle;
    let seated = candidates.length === 0;
    for (const c of candidates) {
      const box = edgeLabelBox(c, edge.label);
      if (!blockers.some((b) => boxesOverlap(box, b))) {
        seat = c;
        seated = true;
        break;
      }
    }
    if (!seated) blocked.push(edge.id);
    edge.labelOffsetX = Math.round(seat.x - middle.x);
    edge.labelOffsetY = Math.round(seat.y - middle.y);
  }
  return blocked;
}

/**
 * Computes orthogonal waypoints through container gutters with clean branching
 * and positions edge labels with non-colliding offsets and opaque backgrounds.
 */
export function routeEdges(
  edgesToRoute: Array<{
    source: string;
    target: string;
    label: string;
    style: "solid" | "dashed";
    tooltip?: string;
    flowStep?: number;
    /**
     * Inferred hint edges may be omitted when no collision-free lane
     * exists; explicit evidence edges are never dropped.
     */
    droppable?: boolean;
  }>,
  nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }>,
  opts?: {
    /**
     * Node ids in transit bands (edge/regional rows). Bypass detours
     * never route around them: dodging a full-width band only creates
     * longer crossings elsewhere.
     */
    transitIds?: Set<string>;
    /**
     * Gutter Y for VPC-exit edges: edges in vpcExitKeys leave the VPC
     * for the regional row or external column via this horizontal lane
     * (VPC header gap), never sideways across sibling AZ subnets.
     */
    vpcExitY?: number;
    /** "source->target" keys routed via vpcExitY. */
    vpcExitKeys?: Set<string>;
    /**
     * Vertical exit-corridor lane for external-bound hops, with its own
     * key set. Corridor edges drop from the gutter through the gap
     * between the VPC extent and the external column.
     */
    vpcExitX?: number;
    /** "source->target" keys routed via the exit corridor. */
    vpcCorridorKeys?: Set<string>;
  }
): RoutedEdge[] {
  const routed: RoutedEdge[] = [];
  let edgeCounter = 200;

  // Track target incoming edge counts for label staggering
  const targetEdgeCount = new Map<string, number>();
  // Track gutter lane allocation so multiple horizontal lines do not stack
  const gutterEdgeCount = new Map<string, number>();
  // Transit-band nodes never count as intermediates to bypass.
  const transitIds = opts?.transitIds ?? new Set<string>();

  const allNodeEntries = Object.entries(nodeAbsGeo);

  for (const e of edgesToRoute) {
    const src = nodeAbsGeo[e.source];
    const dst = nodeAbsGeo[e.target];
    const waypoints: EdgeWaypoint[] = [];

    const inIdx = targetEdgeCount.get(e.target) ?? 0;
    targetEdgeCount.set(e.target, inIdx + 1);

    // Stagger label offset along edge path to eliminate overlap between adjacent labels
    const labelOffsetX = (inIdx % 2 === 0 ? -1 : 1) * (14 + inIdx * 10);
    const labelOffsetY = inIdx % 2 === 0 ? -12 : 12;

    // Default to vertical progression: exit bottom, enter top
    let exitPort: Port = { x: 0.5, y: 1 };
    let entryPort: Port = { x: 0.5, y: 0 };

    if (src && dst) {
      const srcCx = Math.round(src.x + src.w / 2);
      const srcCy = Math.round(src.y + src.h / 2);
      const dstCx = Math.round(dst.x + dst.w / 2);
      const dstCy = Math.round(dst.y + dst.h / 2);

      const dx = dstCx - srcCx;
      const dy = dstCy - srcCy;

      const srcBot = Math.round(src.y + src.h);
      const dstTop = Math.round(dst.y);

      // Primary direction determines exit and entry ports.
      // The horizontal strip between the endpoints bounds every
      // between-check below.
      const stripMinX = Math.min(srcCx, dstCx) - 8;
      const stripMaxX = Math.max(srcCx, dstCx) + 8;
      const inStrip = (n: { x: number; y: number; w: number; h: number }): boolean =>
        n.x < stripMaxX && n.x + n.w > stripMinX;
      // VPC-exit edges leave through the top gutter lane, never sideways
      // across a sibling AZ's subnets. Corridor edges additionally drop
      // through the exit-corridor gap beside the VPC to reach the
      // external column without entering any subnet.
      const vpcExitY = opts?.vpcExitY;
      const vpcExitX = opts?.vpcExitX;
      const isVpcExit =
        vpcExitY !== undefined && (opts?.vpcExitKeys?.has(`${e.source}->${e.target}`) ?? false);
      const isCorridor =
        vpcExitY !== undefined &&
        vpcExitX !== undefined &&
        (opts?.vpcCorridorKeys?.has(`${e.source}->${e.target}`) ?? false);
      if (isCorridor && vpcExitY !== undefined && vpcExitX !== undefined) {
        exitPort = srcCy > vpcExitY ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
        entryPort = dstCx >= vpcExitX ? { x: 0, y: 0.5 } : { x: 0.5, y: 0 };
        waypoints.push({ x: srcCx, y: vpcExitY });
        waypoints.push({ x: vpcExitX, y: vpcExitY });
        if (Math.abs(dstCy - vpcExitY) > 4) {
          waypoints.push({ x: vpcExitX, y: dstCy });
        }
      } else if (isVpcExit && vpcExitY !== undefined) {
        exitPort = srcCy > vpcExitY ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
        entryPort = dstCy > vpcExitY ? { x: 0.5, y: 0 } : { x: 0.5, y: 1 };
        waypoints.push({ x: srcCx, y: vpcExitY });
        waypoints.push({ x: dstCx, y: vpcExitY });
      } else if (Math.abs(dy) >= Math.abs(dx)) {
        if (dy >= 0) {
          // Downward vertical flow
          exitPort = { x: 0.5, y: 1 };
          entryPort = { x: 0.5, y: 0 };

          // Check if intermediate nodes lie between source and target:
          // in the vertical band AND overlapping the horizontal strip
          // between the two endpoints. Nodes off to the side never count —
          // routing around them produces absurd cross-diagram detours.
          // Transit-band nodes never count either.
          const intermediateNodes = allNodeEntries
            .filter(([id]) => !transitIds.has(id))
            .map(([, n]) => n)
            .filter(
              (n) => n !== src && n !== dst && inStrip(n) && n.y >= srcBot - 5 && n.y + n.h <= dstTop + 5
            );

          if (srcBot < dstTop - 15) {
            // Allocate separate lane in this gutter
            const gutterKey = `${Math.floor((srcBot + 10) / 40)}->${Math.floor(dstTop / 40)}`;
            const laneIdx = gutterEdgeCount.get(gutterKey) ?? 0;
            gutterEdgeCount.set(gutterKey, laneIdx + 1);
            const laneOffset = (laneIdx % 2 === 0 ? 1 : -1) * Math.ceil(laneIdx / 2) * 12;

            if (intermediateNodes.length > 0) {
              // Bypass intermediate tier around the side
              const maxInterX = Math.max(...intermediateNodes.map((n) => n.x + n.w));
              const minInterX = Math.min(...intermediateNodes.map((n) => n.x));
              const bypassRight = maxInterX + 36;
              const bypassLeft = minInterX - 36;
              const bypassX = Math.abs(srcCx - bypassRight) <= Math.abs(srcCx - bypassLeft) ? bypassRight : bypassLeft;
              const g1Y = Math.round(srcBot + 16) + laneOffset;
              const g2Y = Math.round(dstTop - 16) - laneOffset;
              waypoints.push({ x: srcCx, y: g1Y });
              waypoints.push({ x: bypassX, y: g1Y });
              waypoints.push({ x: bypassX, y: g2Y });
              waypoints.push({ x: dstCx, y: g2Y });
            } else {
              const midY = Math.round((srcBot + dstTop) / 2) + laneOffset;
              if (Math.abs(srcCx - dstCx) > 8) {
                waypoints.push({ x: srcCx, y: midY });
                waypoints.push({ x: dstCx, y: midY });
              }
            }
          }
        } else {
          // Upward vertical flow
          exitPort = { x: 0.5, y: 0 };
          entryPort = { x: 0.5, y: 1 };

          const gutterKey = `up-${Math.floor(src.y / 40)}->${Math.floor(dst.y / 40)}`;
          const laneIdx = gutterEdgeCount.get(gutterKey) ?? 0;
          gutterEdgeCount.set(gutterKey, laneIdx + 1);
          const laneOffset = (laneIdx % 2 === 0 ? 1 : -1) * Math.ceil(laneIdx / 2) * 12;

          const intermediateNodes = allNodeEntries
            .filter(([id]) => !transitIds.has(id))
            .map(([, n]) => n)
            .filter(
              (n) => n !== src && n !== dst && inStrip(n) && n.y >= dst.y + dst.h - 5 && n.y + n.h <= src.y + 5
            );

          if (intermediateNodes.length > 0) {
            const maxInterX = Math.max(...intermediateNodes.map((n) => n.x + n.w));
            const minInterX = Math.min(...intermediateNodes.map((n) => n.x));
            const bypassRight = maxInterX + 36;
            const bypassLeft = minInterX - 36;
            const bypassX = Math.abs(srcCx - bypassRight) <= Math.abs(srcCx - bypassLeft) ? bypassRight : bypassLeft;
            const g1Y = Math.round(src.y - 16) - laneOffset;
            const g2Y = Math.round(dst.y + dst.h + 16) + laneOffset;
            if (process.env.DIAGRAM_DEBUG === "1") {
              console.log(`UP ${e.source}->${e.target} src=(${srcCx},${Math.round(src.y + src.h / 2)}) dst=(${dstCx},${Math.round(dst.y + dst.h / 2)}) n=${intermediateNodes.length} bypassX=${bypassX} g1=${g1Y} g2=${g2Y}`);
            }
            waypoints.push({ x: srcCx, y: g1Y });
            waypoints.push({ x: bypassX, y: g1Y });
            waypoints.push({ x: bypassX, y: g2Y });
            waypoints.push({ x: dstCx, y: g2Y });
          } else {
            const midY = Math.round((src.y + dst.y + dst.h) / 2) + laneOffset;
            if (Math.abs(srcCx - dstCx) > 8) {
              waypoints.push({ x: srcCx, y: midY });
              waypoints.push({ x: dstCx, y: midY });
            }
          }
        }
      } else {
        if (dx >= 0) {
          // Rightward horizontal flow
          exitPort = { x: 1, y: 0.5 };
          entryPort = { x: 0, y: 0.5 };
        } else {
          // Leftward horizontal flow
          exitPort = { x: 0, y: 0.5 };
          entryPort = { x: 1, y: 0.5 };
        }
      }
    }

    routed.push({
      id: `edge-${edgeCounter++}`,
      sourceId: e.source,
      targetId: e.target,
      label: e.label,
      style: e.style,
      tooltip: e.tooltip,
      labelOffsetX,
      labelOffsetY,
      waypoints,
      exitPort,
      entryPort,
      flowStep: e.flowStep,
    });
  }

  // Every edge gets explicit waypoints through the inter-tier channels:
  // waypoint-less edges receive a horizontal bus at the vertical midpoint,
  // so labels always have a horizontal segment to sit on.
  for (const edge of routed) {
    if (edge.waypoints.length > 0) continue;
    const src = nodeAbsGeo[edge.sourceId];
    const dst = nodeAbsGeo[edge.targetId];
    if (!src || !dst) continue;
    const srcCx = Math.round(src.x + src.w / 2);
    const srcCy = Math.round(src.y + src.h / 2);
    const dstCx = Math.round(dst.x + dst.w / 2);
    const dstCy = Math.round(dst.y + dst.h / 2);
    const midY = Math.round((srcCy + dstCy) / 2);
    edge.waypoints.push({ x: srcCx, y: midY }, { x: dstCx, y: midY });
  }

  // Post-pass: test every routed segment against every non-endpoint node
  // rect and shift waypoints into the nearest free channel when a segment
  // would cross a node it does not terminate at. Droppable hint edges with
  // no clean lane are omitted rather than drawn through a node.
  const droppable = new Map(routed.map((e, i) => [e.id, edgesToRoute[i]?.droppable === true]));
  adjustEdgeLanes(routed, nodeAbsGeo);
  const kept = routed.filter((e) => {
    if (!droppable.get(e.id)) return true;
    return !edgeHitsNode(e, nodeAbsGeo);
  });

  return kept;
}

/** True when segment p1→p2 touches rect (endpoints excluded by the caller). */
function segTouchesRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number }
): boolean {
  const inside = (p: { x: number; y: number }): boolean =>
    p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  if (inside(p1) || inside(p2)) return true;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  const d = (
    p: { x: number; y: number },
    q: { x: number; y: number },
    s: { x: number; y: number }
  ): number => (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x);
  for (let i = 0; i < 4; i++) {
    const c1 = corners[i];
    const c2 = corners[(i + 1) % 4];
    const d1 = d(c1, c2, p1);
    const d2 = d(c1, c2, p2);
    const d3 = d(p1, p2, c1);
    const d4 = d(p1, p2, c2);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return true;
    }
  }
  return false;
}

function edgeNodeCenters(
  edge: RoutedEdge,
  geos: Record<string, { x: number; y: number; w: number; h: number }>
): Array<{ x: number; y: number }> {
  const src = geos[edge.sourceId];
  const dst = geos[edge.targetId];
  if (!src || !dst) return [];
  return [
    { x: src.x + src.w / 2, y: src.y + src.h / 2 },
    ...edge.waypoints,
    { x: dst.x + dst.w / 2, y: dst.y + dst.h / 2 },
  ];
}

function edgeHitsNode(
  edge: RoutedEdge,
  geos: Record<string, { x: number; y: number; w: number; h: number }>
): boolean {
  const pts = edgeNodeCenters(edge, geos);
  if (pts.length < 2) return false;
  for (let i = 0; i < pts.length - 1; i++) {
    for (const [id, g] of Object.entries(geos)) {
      if (id === edge.sourceId || id === edge.targetId) continue;
      if (segTouchesRect(pts[i], pts[i + 1], g)) return true;
    }
  }
  return false;
}

/**
 * Shifts edge waypoints perpendicular to the dominant direction until no
 * segment crosses a non-endpoint node (bounded attempts, nearest channel
 * first). Mutates the routed edges in place.
 */
export function adjustEdgeLanes(
  routed: RoutedEdge[],
  nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }>
): void {
  for (const edge of routed) {
    // A straight port-to-port edge can still cross a node it does not
    // terminate at: seed a midpoint waypoint so the shifting loop below
    // has something to move into the nearest free channel.
    if (edge.waypoints.length === 0 && edgeHitsNode(edge, nodeAbsGeo)) {
      const pts = edgeNodeCenters(edge, nodeAbsGeo);
      if (pts.length >= 2) {
        edge.waypoints.push({
          x: Math.round((pts[0].x + pts[pts.length - 1].x) / 2),
          y: Math.round((pts[0].y + pts[pts.length - 1].y) / 2),
        });
      }
    }
    if (edge.waypoints.length === 0) continue;
    const original = edge.waypoints.map((w) => ({ ...w }));
    const probe = edgeNodeCenters(edge, nodeAbsGeo);
    const dx = Math.abs(probe[probe.length - 1].x - probe[0].x);
    const dy = Math.abs(probe[probe.length - 1].y - probe[0].y);
    const dominantVertical = dy >= dx;
    // Each attempt resets to the original waypoints and tries one offset:
    // both axes, both directions, growing magnitude. The first offset that
    // clears every non-endpoint node wins.
    // Each attempt resets to the original waypoints and tries one offset:
    // perpendicular axis first (into the channels), then parallel, both
    // directions, growing magnitude. The first offset that clears every
    // non-endpoint node wins.
    const perpIsX = dominantVertical;
    for (let attempt = 1; attempt <= 12; attempt++) {
      if (!edgeHitsNode(edge, nodeAbsGeo)) break;
      const mag = 20 * (1 + Math.floor((attempt - 1) / 4));
      const phase = (attempt - 1) % 4;
      const useX = (phase < 2) === perpIsX;
      const dir = phase % 2 === 0 ? 1 : -1;
      const shiftX = useX ? dir * mag : 0;
      const shiftY = useX ? 0 : dir * mag;
      edge.waypoints = original.map((w) => ({ x: w.x + shiftX, y: w.y + shiftY }));
    }
  }
}

// ---------------------------------------------------------------------------
// Main Diagram Generator
// ---------------------------------------------------------------------------

/**
 * Generates a complete, professional .drawio XML document from a ServicePlan or an array of ServicePlans.
 * When passed an array of plans (1..N), returns an array of XML strings.
 * When passed a single plan, returns a single XML string.
 * Single-element arrays produce byte-identical output to single-path calls.
 */
export function generateDiagramXml(
  plans: ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string[];
export function generateDiagramXml(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): string;
export function generateDiagramXml(
  planOrPlans: ServicePlan | ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string | string[];
export function generateDiagramXml(
  planOrPlans: ServicePlan | ServicePlan[],
  sdkEvidence?: SdkEvidence[] | null
): string | string[] {
  if (Array.isArray(planOrPlans)) {
    return planOrPlans.map((p) => generateSingleDiagramXml(p, sdkEvidence));
  }
  return generateSingleDiagramXml(planOrPlans, sdkEvidence);
}

export interface DiagramNode {
  id: string;
  componentId: string;
  /** AWS ServiceId, or the integration name for external boxes. */
  serviceId: string;
  label: string;
  geo: { x: number; y: number; w: number; h: number };
  parent: string;
}

export function slugifyIntegrationName(name: string): string {
  return `ext-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

/** Container id for a service scope (AZ-1 subnets for VPC-local scopes). */
export function scopeContainer(scope: ServiceScope, external = false): string {
  if (external) return CID.external;
  switch (scope) {
    case "global-edge":
      return CID.edge;
    case "regional":
      return CID.regional;
    case "vpc-public":
      return pubId(1);
    case "vpc-private":
      return privId(1);
    case "vpc-data":
      return CID.data;
    case "external":
      return CID.external;
  }
}

export interface DiagramElements {
  layout: DiagramLayout;
  nodes: DiagramNode[];
  routedEdges: RoutedEdge[];
  consolidatedMappings: AwsServiceMapping[];
  compIdRedirect: Record<string, string>;
}

/**
 * Builds the geometric nodes and routed edges from a Stage 1 ServicePlan.
 * Enforces semantic integrity:
 * 1. Component mapping and deduplication preserve logical service identity.
 * 2. Explicit relationships from Stage 1 are processed FIRST and take absolute precedence.
 * 3. Inferred template edges never conflict with, invert, or duplicate explicit relationships.
 * 4. Label collision shifting is bounded within parent container margins.
 */
export function buildDiagramElements(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): DiagramElements {
  // STRICT GROUNDING: Authoritative Stage 1 service set
  const stage1ServiceIds = new Set<ServiceId>(plan.awsMappings.map((m) => m.serviceId));

  // 1. Deduplication pass: consolidate duplicate generic infrastructure
  // within the same scope (scope table owns placement).
  const compMap = new Map(plan.components.map((c) => [c.id, c]));
  const consolidatedMappings: AwsServiceMapping[] = [];
  const compIdRedirect: Record<string, string> = {};
  const seenServiceScopes = new Map<string, string>(); // scope:serviceId -> masterComponentId

  for (const m of plan.awsMappings) {
    // Strictly reject any service that is not in the authoritative stage1ServiceIds
    if (!stage1ServiceIds.has(m.serviceId)) continue;

    const scope = m.external === true ? "external" : scopeOf(m.serviceId);
    const comp = compMap.get(m.componentId);
    const hasCustomTech =
      comp?.technology &&
      comp.technology.toLowerCase() !== m.serviceId.toLowerCase() &&
      !comp.technology.toLowerCase().includes("generic");

    const dedupeKey = `${scope}:${m.serviceId}`;
    if (!hasCustomTech && seenServiceScopes.has(dedupeKey)) {
      // Re-route to already existing master node for this service in this scope
      compIdRedirect[m.componentId] = seenServiceScopes.get(dedupeKey)!;
    } else {
      consolidatedMappings.push(m);
      seenServiceScopes.set(dedupeKey, m.componentId);
      compIdRedirect[m.componentId] = m.componentId;
    }
  }

  // Ensure every serviceId in stage1ServiceIds has at least one entry in consolidatedMappings
  for (const sId of stage1ServiceIds) {
    if (!consolidatedMappings.some((m) => m.serviceId === sId)) {
      const orig = plan.awsMappings.find((m) => m.serviceId === sId);
      if (orig) {
        consolidatedMappings.push(orig);
        compIdRedirect[orig.componentId] = orig.componentId;
      }
    }
  }

  // Third-party integrations render as labelled boxes in the external
  // column (one per integration name, order-stable).
  const integrationNames: string[] = [];
  for (const dm of plan.deploymentModel ?? []) {
    for (const t of dm.thirdPartyIntegrations ?? []) {
      if (!integrationNames.includes(t.name)) integrationNames.push(t.name);
    }
  }
  const externalBoxes = integrationNames.map((name) => ({
    id: slugifyIntegrationName(name),
    label: name,
  }));

  // One AZ container per plan availability zone.
  const azCount = Math.min(
    6,
    Math.max(1, ...(plan.deploymentModel ?? []).map((d) => d.availabilityZones ?? 1))
  );

  // 2. Compute layout geometry with mathematical centering.
  // The generic Users node feeds the edge tier whenever edge nodes exist.
  const hasEdgeTier = consolidatedMappings.some((m) => {
    try {
      return scopeOf(m.serviceId) === "global-edge";
    } catch {
      return false;
    }
  });
  const layout = computeLayout(consolidatedMappings, {
    azCount,
    external: externalBoxes,
    users: hasEdgeTier,
  });

  // 3. Build node list
  const nodes: DiagramNode[] = [];
  const compIdToNodeId: Record<string, string> = {};
  const serviceIdToNodeId: Record<string, string> = {};
  // INVARIANT: nodeAbsGeo stores ABSOLUTE canvas positions for each node,
  // not parent-relative positions. This is critical for routeEdges()
  // which needs to compute source/target direction across different container parents.
  const nodeAbsGeo: Record<string, { x: number; y: number; w: number; h: number }> = {};
  let nextId = 2; // mxGraph cells start at 2 (0=root, 1=layer)

  const layoutEntries = Object.entries(layout.nodes);
  const placementsFor = (componentId: string): typeof layoutEntries =>
    layoutEntries.filter(([, n]) => n.componentId === componentId);

  const emitNode = (
    placement: { x: number; y: number; parent: string; serviceId: string; componentId: string },
    componentId: string,
    serviceId: string,
    label: string
  ): void => {
    const parent = placement.parent;
    const nodeId = `node-${nextId++}`;
    if (!compIdToNodeId[componentId]) compIdToNodeId[componentId] = nodeId;
    if (!serviceIdToNodeId[serviceId]) serviceIdToNodeId[serviceId] = nodeId;

    // Relative to parent container
    const containerRect = layout.containers[parent];
    const baseX = containerRect ? containerRect.x : 0;
    const baseY = containerRect ? containerRect.y : 0;

    // Centered 56x56 icon inside cell
    const iconOffsetX = Math.round((CELL_W - ICON_SIZE) / 2);
    const relX = placement.x - baseX + iconOffsetX;
    const relY = placement.y - baseY + 4;

    nodeAbsGeo[nodeId] = {
      x: placement.x + iconOffsetX,
      y: placement.y + 4,
      w: ICON_SIZE,
      h: ICON_SIZE,
    };

    nodes.push({
      id: nodeId,
      componentId,
      serviceId,
      label,
      geo: {
        x: relX,
        y: relY,
        w: ICON_SIZE,
        h: ICON_SIZE,
      },
      parent,
    });
  };

  const displayLabel = (mapping: AwsServiceMapping): string => {
    const comp = compMap.get(mapping.componentId);
    let displayName = normalizeServiceName(mapping.serviceId);
    if (comp?.technology && comp.technology.toLowerCase() !== mapping.serviceId.toLowerCase()) {
      const cleanSub = comp.technology.replace(/^(AWS|Amazon)\s+/i, "");
      const normalizedSub = normalizeForComparison(cleanSub);
      const normalizedDisplay = normalizeForComparison(displayName);
      const isRedundant =
        !cleanSub ||
        normalizedSub === normalizedDisplay ||
        normalizedDisplay.includes(normalizedSub) ||
        normalizedSub.includes(normalizedDisplay);
      if (!isRedundant) {
        displayName = `${wrapServiceName(displayName)}\n(${cleanSub})`;
      } else {
        displayName = wrapServiceName(displayName);
      }
    } else {
      displayName = wrapServiceName(displayName);
    }
    return displayName;
  };

  for (const mapping of consolidatedMappings) {
    if (!stage1ServiceIds.has(mapping.serviceId)) continue;

    let found = placementsFor(mapping.componentId);
    if (found.length === 0) {
      const byService = layoutEntries.filter(([, n]) => n.serviceId === mapping.serviceId);
      if (byService.length > 0) found = [byService[0]];
    }

    if (found.length === 0) {
      // Missing Service Protection: assign a scope-correct fallback so no
      // Stage 1 service is ever silently dropped.
      const scope = mapping.external === true ? "external" : scopeOf(mapping.serviceId);
      const fallbackParent = scopeContainer(scope as ServiceScope, mapping.external === true);
      nodeAbsGeo[`node-${nextId}`] = {
        x: MARGIN + PAD,
        y: MARGIN + PAD,
        w: ICON_SIZE,
        h: ICON_SIZE,
      };
      nodes.push({
        id: `node-${nextId++}`,
        componentId: mapping.componentId,
        serviceId: mapping.serviceId,
        label: wrapServiceName(normalizeServiceName(mapping.serviceId)),
        geo: { x: PAD, y: LABEL_H + PAD_TOP, w: ICON_SIZE, h: ICON_SIZE },
        parent: fallbackParent,
      });
      if (!compIdToNodeId[mapping.componentId]) {
        compIdToNodeId[mapping.componentId] = `node-${nextId - 1}`;
      }
      if (!serviceIdToNodeId[mapping.serviceId]) {
        serviceIdToNodeId[mapping.serviceId] = `node-${nextId - 1}`;
      }
      continue;
    }

    const label = displayLabel(mapping);
    for (const [, placement] of found) {
      emitNode(placement, mapping.componentId, mapping.serviceId, label);
    }
  }

  // External integration boxes (labelled, never blank), plus the generic
  // Users node when the edge tier exists.
  const boxSpecs: Array<{ id: string; serviceId: string; label: string }> = [
    ...externalBoxes.map((box) => ({ id: box.id, serviceId: box.label, label: wrapServiceName(box.label) })),
  ];
  if (hasEdgeTier) {
    boxSpecs.push({ id: USERS_COMPONENT_ID, serviceId: USERS_SERVICE_ID, label: wrapServiceName(USERS_LABEL) });
  }
  for (const box of boxSpecs) {
    const found = placementsFor(box.id);
    if (found.length === 0) continue;
    for (const [, placement] of found) {
      emitNode(placement, box.id, box.serviceId, box.label);
    }
  }

  // All nodes are grounded by construction (mappings plus integration
  // boxes plus the generic Users node); keep every node whose service is
  // authoritative or external.
  const groundedNodes = nodes.filter(
    (n) =>
      stage1ServiceIds.has(n.serviceId as ServiceId) ||
      n.componentId.startsWith("ext-") ||
      n.componentId === USERS_COMPONENT_ID
  );

  // 3b. Label collision resolution pass (clamped to parent container bounds).
  // Shifted nodes write back into the layout so routing, validation and
  // rendering all share one geometry.
  {
    const occupiedBboxes: Rect[] = [];
    for (const node of groundedNodes) {
      const absGeo = nodeAbsGeo[node.id];
      if (!absGeo) continue;

      let bbox = labelBbox(absGeo.x, absGeo.y, node.label);
      let attempts = 0;
      const MAX_ATTEMPTS = 5;

      const containerRect = layout.containers[node.parent];
      const maxRelY = containerRect ? containerRect.h - PAD_BOTTOM - node.geo.h : Infinity;

      while (attempts < MAX_ATTEMPTS && occupiedBboxes.some((ob) => rectsCollide(bbox, ob))) {
        const shift = CELL_H + GAP;
        if (node.geo.y + shift > maxRelY) {
          break; // Stop shifting if it would exceed parent container bounds
        }
        absGeo.y += shift;
        node.geo.y += shift;
        bbox = labelBbox(absGeo.x, absGeo.y, node.label);
        attempts++;
      }
      if (attempts > 0) {
        const dy = attempts * (CELL_H + GAP);
        for (const entry of Object.values(layout.nodes)) {
          if (entry.componentId === node.componentId && entry.parent === node.parent) {
            entry.y += dy;
          }
        }
      }

      occupiedBboxes.push({ x: absGeo.x, y: absGeo.y, w: absGeo.w, h: absGeo.h });
      occupiedBboxes.push(bbox);
    }
  }

  // 4. Build edge relationships
  interface RawEdge {
    source: string;
    target: string;
    label: string;
    style: "solid" | "dashed";
    tooltip?: string;
    flowStep?: number;
    droppable?: boolean;
  }
  const rawEdges: RawEdge[] = [];
  const edgeKeys = new Set<string>(); // "srcId->dstId"
  const connectedPairs = new Set<string>(); // "minId<->maxId"

  // 4a. Explicit relationships from Stage 1 plan (Highest priority: solid, preserve exact direction)
  // CDN↔compute traffic always traverses the load balancer when one is
  // present: the edge is redirected through the first LB node with its
  // label intact (see redirectCdnEdge, mirrored by the semantic check).
  const lbNodeIds = groundedNodes
    .filter((n) => LB_SERVICES.has(n.serviceId))
    .map((n) => n.id);
  const svcByCompId = new Map(groundedNodes.map((n) => [n.componentId, n.serviceId]));
  // Third-party hosted stores are reached via the NAT egress chain, never
  // a direct wire: an explicit compute -> external-store relationship would
  // cut sideways across sibling AZ subnets. The semantic check mirrors
  // this by accepting the NAT chain as satisfaction.
  const mappingByCompId = new Map(plan.awsMappings.map((m) => [m.componentId, m]));
  for (const rel of plan.relationships ?? []) {
    const mappedFrom = compIdRedirect[rel.from] ?? rel.from;
    const mappedTo = compIdRedirect[rel.to] ?? rel.to;
    const srcMapping = mappingByCompId.get(rel.from) ?? mappingByCompId.get(mappedFrom);
    const dstMapping = mappingByCompId.get(rel.to) ?? mappingByCompId.get(mappedTo);
    if (srcMapping?.external === true || dstMapping?.external === true) continue;
    const srcNodeId = compIdToNodeId[mappedFrom] ?? serviceIdToNodeId[rel.from];
    const dstNodeId = compIdToNodeId[mappedTo] ?? serviceIdToNodeId[rel.to];

    if (srcNodeId && dstNodeId) {
      const srcExists = groundedNodes.some((n) => n.id === srcNodeId);
      const dstExists = groundedNodes.some((n) => n.id === dstNodeId);
      if (!srcExists || !dstExists) continue;

      const redir = redirectCdnEdge(
        svcByCompId.get(mappedFrom) ?? rel.from,
        svcByCompId.get(mappedTo) ?? rel.to,
        srcNodeId,
        dstNodeId,
        lbNodeIds
      );
      const forwardKey = `${redir.src}->${redir.dst}`;
      if (!edgeKeys.has(forwardKey)) {
        rawEdges.push({
          source: redir.src,
          target: redir.dst,
          label: rel.type ?? "",
          style: "solid",
          tooltip: rel.type ?? undefined,
        });
        edgeKeys.add(forwardKey);
        const pairKey = redir.src < redir.dst ? `${redir.src}<->${redir.dst}` : `${redir.dst}<->${redir.src}`;
        connectedPairs.add(pairKey);
      }
    }
  }

  // 4b. Role-derived edges (dashed unless confirmed by evidence; explicit
  // relationships above always win and are never duplicated here).
  let primaryFlowCounter = 1;

  const ASYNC_SERVICES = new Set<string>(["SQS", "SNS", "EventBridge", "Kinesis"]);
  const MONITORING_IAC_SERVICES = new Set<string>(["CloudWatch", "CloudFormation", "CodePipeline", "ECR"]);
  const ASYNC_OR_IAC_LABELS = /fanout|trigger|consume|publish|pull image|deploy|monitor/i;

  function isPrimaryPathEdge(src: string, dst: string, label?: string): boolean {
    if (ASYNC_SERVICES.has(src) || ASYNC_SERVICES.has(dst)) return false;
    if (MONITORING_IAC_SERVICES.has(src) || MONITORING_IAC_SERVICES.has(dst)) return false;
    if (label && ASYNC_OR_IAC_LABELS.test(label)) return false;
    return true;
  }

  const nodeById = new Map(groundedNodes.map((n) => [n.id, n]));
  const externalComps = new Set(
    consolidatedMappings.filter((m) => m.external === true).map((m) => m.componentId)
  );
  // Object storage counts as proven with a repository mapping or an SDK
  // hint naming the service; bare topology never earns a storage edge.
  const storageProvenFor = (node: DiagramNode): boolean => {
    const mapping = consolidatedMappings.find((m) => m.componentId === node.componentId);
    if (mapping?.category === "repository-evidence") return true;
    return (sdkEvidence ?? []).some(
      (ev) => (ev.serviceHint ?? ev.service ?? "").toLowerCase() === node.serviceId.toLowerCase()
    );
  };
  const roleEdges = deriveRoleEdges(
    groundedNodes.map((n) => {
      const azMatch = n.parent.match(/^container-(?:public|private)-(\d+)$/);
      return {
        id: n.id,
        serviceId: n.serviceId,
        external: n.componentId.startsWith("ext-") || externalComps.has(n.componentId),
        users: n.componentId === USERS_COMPONENT_ID,
        storageProven: storageProvenFor(n),
        az: azMatch ? Number(azMatch[1]) : null,
      };
    }),
    connectedPairs
  );

  // External integration edges carry the registry protocol as their label.
  const protocolForExternal = (nodeId: string): string | null => {
    const node = nodeById.get(nodeId);
    if (!node || !node.componentId.startsWith("ext-")) return null;
    const hit = matchIntegration(node.serviceId);
    return hit ? hit.protocol : null;
  };

  for (const def of roleEdges) {
    const forwardKey = `${def.from}->${def.to}`;
    const reverseKey = `${def.to}->${def.from}`;
    if (edgeKeys.has(forwardKey) || edgeKeys.has(reverseKey)) continue;
    const srcNode = nodeById.get(def.from);
    const dstNode = nodeById.get(def.to);
    if (!srcNode || !dstNode) continue;

    const srcMapping = consolidatedMappings.find((m) => m.componentId === srcNode.componentId);
    const dstMapping = consolidatedMappings.find((m) => m.componentId === dstNode.componentId);
    const confirmed = isEdgeConfirmed(
      srcNode.serviceId,
      dstNode.serviceId,
      srcMapping?.evidence ?? "",
      dstMapping?.evidence ?? "",
      plan.relationships ?? [],
      sdkEvidence
    );

    const protocol = protocolForExternal(def.from) ?? protocolForExternal(def.to);
    // Labels come from role/protocol only — never a generic guess marker.
    const edgeLabel = protocol ?? def.label;
    const isPrimary = isPrimaryPathEdge(srcNode.serviceId, dstNode.serviceId, def.label);
    const flowStep = isPrimary ? primaryFlowCounter++ : undefined;
    // The NAT egress chain is load-bearing topology (the only path to
    // external stores), never a droppable hint — but only for real
    // service mappings. Decorative ext- integration boxes stay droppable
    // so node-crossing hints to them are omitted, not drawn through nodes.
    const dstIsExternalMapping = externalComps.has(dstNode.componentId);
    const isNatEgress = srcNode.serviceId === "NATGateway" && dstIsExternalMapping;

    rawEdges.push({
      source: def.from,
      target: def.to,
      label: edgeLabel,
      style: confirmed ? "solid" : "dashed",
      tooltip: undefined,
      flowStep,
      droppable: !isNatEgress,
    });
    edgeKeys.add(forwardKey);
  }

  // 5. Route edges with collision avoidance and label staggering,
  // then seat every label on a clear horizontal run. Transit-band nodes
  // never trigger bypass detours. Inferred hints whose labels cannot seat
  // clear are omitted; explicit evidence edges are always kept.
  const transitIds = new Set(
    groundedNodes
      .filter((n) => n.parent === CID.edge || n.parent === CID.regional)
      .map((n) => n.id)
  );
  // Egress exits through the top gutter and the VPC-exit corridor: any
  // edge leaving the VPC for the regional row or the external column
  // routes up through the VPC header gap, never sideways across a sibling
  // AZ's subnets (validator 5b). External-bound hops additionally drop
  // through the corridor gap between the last AZ and the external column.
  const parentOf = new Map(groundedNodes.map((n) => [n.id, n.parent]));
  const inAzSubnet = (parent: string | undefined): boolean =>
    Boolean(parent && /^container-(public|private)-\d+$/.test(parent));
  const outsideVpc = (parent: string | undefined): boolean =>
    parent === CID.regional || parent === CID.edge || parent === CID.external;
  const vpcRect = layout.containers[CID.vpc];
  const extRect = layout.containers[CID.external];
  const vpcExitY = vpcRect ? Math.round(vpcRect.y + LABEL_H + PAD_TOP / 2) : null;
  // Corridor: vertical lane in the gap between the VPC extent and the
  // external column. Falls back to the gutter-only path when absent.
  const vpcExitX =
    vpcRect && extRect ? Math.round(extRect.x - (extRect.x - (vpcRect.x + vpcRect.w)) / 2) : null;
  const vpcExitKeys = new Set<string>();
  const vpcCorridorKeys = new Set<string>();
  if (vpcExitY !== null) {
    for (const r of rawEdges) {
      const sp = parentOf.get(r.source);
      const dp = parentOf.get(r.target);
      if ((inAzSubnet(sp) && outsideVpc(dp)) || (inAzSubnet(dp) && outsideVpc(sp))) {
        if ((dp === CID.external || sp === CID.external) && vpcExitX !== null) {
          vpcCorridorKeys.add(`${r.source}->${r.target}`);
        } else {
          vpcExitKeys.add(`${r.source}->${r.target}`);
        }
      }
    }
  }
  let routedEdges = routeEdges(rawEdges, nodeAbsGeo, {
    transitIds,
    vpcExitY: vpcExitY ?? undefined,
    vpcExitX: vpcExitX ?? undefined,
    vpcExitKeys,
    vpcCorridorKeys,
  });
  const droppableByPair = new Map(
    rawEdges.filter((r) => r.droppable).map((r) => [`${r.source}->${r.target}`, true])
  );
  const blockedSeats = new Set(seatEdgeLabels(routedEdges, groundedNodes, nodeAbsGeo));
  if (blockedSeats.size > 0) {
    routedEdges = routedEdges.filter(
      (e) => !blockedSeats.has(e.id) || !droppableByPair.get(`${e.sourceId}->${e.targetId}`)
    );
  }
  // Renumber primary-flow badges contiguously after label seating drops.
  // Flow steps are assigned pre-routing, so a dropped hint leaves a gap
  // (e.g. 1,3,4) and the second visible badge reads 3, not 2.
  {
    let step = 1;
    for (const e of routedEdges) {
      if (e.flowStep !== undefined) e.flowStep = step++;
    }
  }

  return {
    layout,
    nodes: groundedNodes,
    routedEdges,
    consolidatedMappings,
    compIdRedirect,
  };
}

/**
 * Convenience helper to validate semantic integrity directly on a ServicePlan.
 */
export function validatePlanSemantics(
  plan: ServicePlan,
  sdkEvidence?: SdkEvidence[] | null
): SemanticValidationResult {
  const { nodes, routedEdges } = buildDiagramElements(plan, sdkEvidence);
  return validateDiagramSemantics(plan, nodes, routedEdges);
}

export function generateSingleDiagramXml(
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

  const { layout, nodes, routedEdges } = buildDiagramElements(plan, sdkEvidence);

  // 6. Render mxGraph cells
  const cellsXml: string[] = [];

  // Containers (drawn first so they sit in the background)
  // Emit parents before children: cloud, then top-level rows, then AZs,
  // then subnets ordered top-to-bottom.
  const emitRank = (id: string): number => {
    if (id === CID.aws) return 0;
    if (id === CID.edge || id === CID.regional || id === CID.vpc || id === CID.external) return 1;
    if (/^container-az-\d+$/.test(id)) return 2;
    return 3;
  };
  const containerEmitOrder = Object.keys(layout.containers)
    .filter((id) => layout.containers[id] !== null)
    .sort((a, b) => {
      const ra = emitRank(a);
      const rb = emitRank(b);
      if (ra !== rb) return ra - rb;
      return (layout.containers[a]?.y ?? 0) - (layout.containers[b]?.y ?? 0);
    });
  for (const containerId of containerEmitOrder) {
    const rect = layout.containers[containerId];
    if (!rect) continue;
    const label = containerLabel(containerId);
    const themeStyle = themeForContainer(containerId);
    const parentId = containerParent(containerId);

    // Compute geometry relative to parent container
    let geoX = rect.x;
    let geoY = rect.y;
    const geoW = rect.w;
    const geoH = rect.h;

    if (parentId !== "1") {
      // Convert absolute coordinates to parent-relative coordinates
      const parentRect = layout.containers[parentId];
      if (parentRect) {
        geoX = rect.x - parentRect.x;
        geoY = rect.y - parentRect.y;
      }
    }

    cellsXml.push(
      `    <mxCell id="${containerId}" value="${xmlAttr(label)}" ` +
        `style="${themeStyle}" vertex="1" parent="${parentId}">` +
        `<mxGeometry x="${geoX}" y="${geoY}" ` +
        `width="${geoW}" height="${geoH}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // Edges (Orthogonal with clear arrowheads, parallel lane separation, and shielded label badges)
  for (const edge of routedEdges) {
    const label = xmlAttr(edge.label);
    const portStyle = `exitX=${edge.exitPort.x};exitY=${edge.exitPort.y};exitDx=0;exitDy=0;entryX=${edge.entryPort.x};entryY=${edge.entryPort.y};entryDx=0;entryDy=0;`;
    const edgeStyle =
      edge.style === "dashed"
        ? `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;${portStyle}dashed=1;dashPattern=8 8;strokeColor=#6B7280;strokeWidth=1;labelBackgroundColor=#FFFFFF;spacing=4;`
        : `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;${portStyle}strokeColor=#232F3E;strokeWidth=1.5;labelBackgroundColor=#FFFFFF;spacing=4;`;

    const waypointsXml =
      edge.waypoints.length > 0
        ? `<Array as="points">\n${edge.waypoints
            .map((pt) => `          <mxPoint x="${pt.x}" y="${pt.y}"/>`)
            .join("\n")}\n        </Array>`
        : "";

    cellsXml.push(
      `    <mxCell id="${edge.id}" value="${label}" ` +
        `style="${edgeStyle}" ` +
        `edge="1" source="${edge.sourceId}" target="${edge.targetId}" parent="1">` +
        `<mxGeometry relative="1" as="geometry">\n` +
        `        <mxPoint as="offset" x="${edge.labelOffsetX}" y="${edge.labelOffsetY}"/>\n` +
        (waypointsXml ? `        ${waypointsXml}\n` : "") +
        `      </mxGeometry>` +
        `</mxCell>`
    );
  }

  // Badges (flow numbers on primary edges - drawn after edges)
  for (const edge of routedEdges) {
    if (edge.flowStep !== undefined) {
      const badgeStyle =
        "shape=ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=#232F3E;strokeColor=none;" +
        "fontColor=#FFFFFF;fontSize=9;fontStyle=1;align=center;verticalAlign=middle;";
      cellsXml.push(
        `    <mxCell id="badge-${edge.id}" value="${edge.flowStep}" ` +
          `style="${badgeStyle}" vertex="1" parent="${edge.id}">` +
          `<mxGeometry relative="1" as="geometry"/>` +
          `</mxCell>`
      );
    }
  }

  // Nodes (AWS services - drawn last so icons and labels sit cleanly in the foreground)
  for (const node of nodes) {
    const style = nodeStyle(node.serviceId);
    const label = xmlAttr(node.label);
    cellsXml.push(
      `    <mxCell id="${node.id}" value="${label}" serviceId="${node.serviceId}" style="${xmlAttr(style)}" ` +
        `vertex="1" parent="${node.parent}">` +
        `<mxGeometry x="${node.geo.x}" y="${node.geo.y}" ` +
        `width="${node.geo.w}" height="${node.geo.h}" as="geometry"/>` +
        `</mxCell>`
    );
  }

  // 7. Validate full semantics and layout
  const semanticValidation = validateDiagramSemantics(plan, nodes, routedEdges);
  if (!semanticValidation.valid) {
    console.warn(
      "Diagram semantic validation warnings in generateSingleDiagramXml:\n" +
        semanticValidation.errors.join("\n")
    );
  }

  const layoutValidation = validateDiagramLayout(layout, nodes);
  if (!layoutValidation.valid) {
    console.warn(
      "Diagram layout validation warnings in generateSingleDiagramXml:\n" +
        layoutValidation.errors.join("\n")
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
