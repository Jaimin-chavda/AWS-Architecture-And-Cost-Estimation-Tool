/**
 * scripts/diagram-validate/run.ts — offline validator harness.
 *
 * Builds 4 synthetic plans that differ the way the 4 test repos should
 * (MERN/Mongo, Spring Boot/relational, Firebase/Campus Web, static/Yearbook),
 * validates each with diagramValidator.ts, writes the draw.io XML files, and
 * prints the report. No network, no LLM key.
 *
 * Run via: npm run test:diagram-validate
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServicePlan } from "../../src/lib/schema.ts";
import { buildDiagramElements, generateSingleDiagramXml } from "../../src/lib/diagram.ts";
import { validateDiagram } from "../../src/lib/diagramValidator.ts";

function baseMeta() {
  return { grounding: "repo" as const, truncated: false, parseErrors: [] as string[] };
}

function dm(componentId: string, over: Record<string, unknown> = {}) {
  return {
    componentId,
    public: false,
    needsVpc: true,
    needsMultiAz: false,
    needsAutoscaling: false,
    source: "recommended" as const,
    availabilityZones: 2,
    hasLoadBalancer: true,
    secretsManager: true,
    natGateway: true,
    thirdPartyIntegrations: [],
    computeTier: "ECS_FARGATE" as const,
    ...over,
  };
}

// 1. MERN — Express + Mongoose/MongoDB + S3 SDK uploads
const mern: ServicePlan = {
  inputKind: "github_url",
  components: [
    { id: "frontend", type: "frontend", technology: "React", evidence: ["package.json → dependencies.react"], confidence: "high", status: "detected" },
    { id: "api", type: "backend", technology: "Express", evidence: ["package.json → dependencies.express"], confidence: "high", status: "detected" },
    { id: "db", type: "database", technology: "MongoDB", evidence: ["package.json → dependencies.mongoose"], confidence: "high", status: "detected" },
  ],
  relationships: [{ from: "api", to: "db", type: "read/write" }],
  deploymentModel: [dm("api")],
  awsMappings: [
    { componentId: "frontend", serviceId: "CloudFront", confidence: "high", evidence: "React frontend", fromPattern: false },
    { componentId: "api", serviceId: "ECS", confidence: "high", evidence: "Express backend", fromPattern: false },
    { componentId: "api-alb", serviceId: "ALB", confidence: "low", evidence: "policy: load-balancer because servesRequests (synthetic)", fromPattern: false, category: "recommendation" },
    { componentId: "db", serviceId: "DocumentDB", confidence: "high", evidence: "Mongoose ODM", fromPattern: false },
    { componentId: "svc-secretsmanager", serviceId: "SecretsManager", confidence: "low", evidence: "policy: secrets-manager because hasSecrets (synthetic)", fromPattern: false, category: "recommendation" },
  ],
  detectedPattern: "full-stack-web",
  terminalState: "OK",
  warnings: [],
  metadata: baseMeta(),
};

// 2. Spring Boot — containerised API + PostgreSQL + ECR
const spring: ServicePlan = {
  inputKind: "github_url",
  components: [
    { id: "api", type: "backend", technology: "Spring Boot", evidence: ["pom.xml → spring-boot-starter-web"], confidence: "high", status: "detected" },
    { id: "db", type: "database", technology: "PostgreSQL", evidence: ["pom.xml → postgresql"], confidence: "high", status: "detected" },
  ],
  relationships: [{ from: "api", to: "db", type: "query" }],
  deploymentModel: [{ ...dm("api"), database: { multiAz: true } }],
  awsMappings: [
    { componentId: "api", serviceId: "ECS", confidence: "high", evidence: "Spring Boot + Dockerfile", fromPattern: false },
    { componentId: "api-registry", serviceId: "ECR", confidence: "medium", evidence: "container registry", fromPattern: false },
    { componentId: "api-alb", serviceId: "ALB", confidence: "low", evidence: "policy: load-balancer because servesRequests (synthetic)", fromPattern: false, category: "recommendation" },
    { componentId: "db", serviceId: "RDS", confidence: "high", evidence: "PostgreSQL → RDS (PostgreSQL)", fromPattern: false },
    { componentId: "svc-secretsmanager", serviceId: "SecretsManager", confidence: "low", evidence: "policy: secrets-manager because hasSecrets (synthetic)", fromPattern: false, category: "recommendation" },
  ],
  detectedPattern: "containerised-app",
  terminalState: "OK",
  warnings: [],
  metadata: baseMeta(),
};

// 3. Campus Web — Firebase SDK app, computeTier NONE, 3 outbound integrations
const campus: ServicePlan = {
  inputKind: "github_url",
  components: [
    { id: "web", type: "frontend", technology: "React", evidence: ["package.json → dependencies.react"], confidence: "high", status: "detected" },
  ],
  relationships: [],
  deploymentModel: [
    dm("web", {
      needsVpc: false,
      hasLoadBalancer: false,
      secretsManager: false,
      computeTier: "NONE" as const,
      thirdPartyIntegrations: [
        { name: "Firebase Firestore", purpose: "Realtime document database", protocol: "SDK", category: "database" },
        { name: "Firebase Auth", purpose: "Authentication and user management", protocol: "SDK", category: "auth" },
        { name: "Firebase Storage", purpose: "Object storage for user content", protocol: "SDK", category: "storage" },
      ],
    }),
  ],
  awsMappings: [
    { componentId: "web", serviceId: "S3", confidence: "high", evidence: "React static assets", fromPattern: false },
    { componentId: "web-cdn", serviceId: "CloudFront", confidence: "high", evidence: "CDN", fromPattern: false },
  ],
  detectedPattern: "static-site",
  terminalState: "OK",
  warnings: [],
  metadata: baseMeta(),
};

// 4. Yearbook — plain static site, no backend
const yearbook: ServicePlan = {
  inputKind: "github_url",
  components: [
    { id: "site", type: "frontend", technology: "Vite", evidence: ["package.json → scripts.build"], confidence: "high", status: "detected" },
  ],
  relationships: [],
  deploymentModel: [dm("site", { needsVpc: false, availabilityZones: 1, hasLoadBalancer: false, secretsManager: false, natGateway: false, computeTier: "NONE" as const })],
  awsMappings: [
    { componentId: "site", serviceId: "S3", confidence: "high", evidence: "static assets", fromPattern: false },
    { componentId: "site-cdn", serviceId: "CloudFront", confidence: "high", evidence: "CDN", fromPattern: false },
  ],
  detectedPattern: "static-site",
  terminalState: "OK",
  warnings: [],
  metadata: baseMeta(),
};

const plans: Array<[string, ServicePlan]> = [
  ["mern", mern],
  ["spring-boot", spring],
  ["campus-web-firebase", campus],
  ["yearbook-static", yearbook],
];

const outDir = join(tmpdir(), "diagram-validate");
mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const [name, plan] of plans) {
  const elements = buildDiagramElements(plan);
  const check = validateDiagram(plan, elements);
  const xml = generateSingleDiagramXml(plan);
  const file = join(outDir, `${name}.drawio`);
  writeFileSync(file, xml);
  console.log(`=== ${name} ===`);
  console.log(`  nodes: ${elements.nodes.map((n) => n.serviceId).join(", ")}`);
  console.log(`  validator: ${check.pass ? "PASS" : "FAIL"}`);
  for (const f of check.failures) console.log(`    - ${f}`);
  console.log(`  file: ${file}`);
  if (!check.pass) failed++;
}
console.log(`${plans.length - failed}/${plans.length} diagrams pass`);
if (failed > 0) process.exit(1);
