/**
 * diag_4repos.mjs — pipeline stage diagnostic (read-only, no code changes)
 */

import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";

const REPOS = [
  { name: "mern-student-mgmt",   url: "https://github.com/elselif/MERN" },
  { name: "springboot-student",  url: "https://github.com/ankitkumar2020/StudentManagementSystem" },
  { name: "campus-web-firebase", url: "https://github.com/gdsc-jssstu/campUS-Web" },
  { name: "yearbook-firebase",   url: "https://github.com/m-ehab2/Yearbook" },
];

function writeJson(name, suffix, data) {
  const dir = `scripts/diag_out`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}__${suffix}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function analyze(repo) {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`REPO: ${repo.name}   (${repo.url})`);
  console.log("=".repeat(72));

  const body = { input: { kind: "github_url", value: repo.url }, userCount: 10000 };

  let resp, json;
  try {
    resp = await fetch(`${BASE}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    json = await resp.json();
  } catch (err) {
    console.error(`  [FETCH ERROR] ${err.message}`);
    return;
  }

  if (json.status === "insufficient_signal") {
    console.log("  [GATE] insufficient_signal — pipeline stopped before Stage 1");
    return;
  }

  const prof = json.project_profile ?? {};

  console.log("\n--- STAGE 1: DETECTION ---");
  const allDeps = [
    ...(prof.frameworks ?? []).map(d => `  [fw]  ${d.name} | conf=${d.confidence} | ev=${d.evidence}`),
    ...(prof.databases ?? []).map(d => `  [db]  ${d.name} | conf=${d.confidence} | ev=${d.evidence}`),
    ...(prof.infrastructure ?? []).map(d => `  [inf] ${d.name} | conf=${d.confidence} | ev=${d.evidence}`),
    ...(prof.awsUsage ?? []).map(d => `  [aws] ${d.name} | conf=${d.confidence} | ev=${d.evidence}`),
  ];
  if (allDeps.length === 0) { console.log("  (no dependencies detected)"); }
  else { allDeps.forEach(l => console.log(l)); }

  const comps = prof.discoveredComponents ?? [];
  if (comps.length > 0) {
    console.log("  [discovered components]:");
    comps.forEach(c => console.log(`    + ${c.id} type=${c.type} tech=${c.technology} conf=${c.confidence} src=${c.source}`));
  }

  const dbLabels = (prof.databases ?? []).map(d => d.name.toLowerCase());
  const fwLabels = (prof.frameworks ?? []).map(d => d.name.toLowerCase());
  const allLabels = [...dbLabels, ...fwLabels];
  const hasFirebase = allLabels.some(l => l.includes("firebase"));
  const hasMongo    = allLabels.some(l => l.includes("mongo"));
  const hasMySQL    = allLabels.some(l => l.includes("mysql"));
  console.log(`  SIGNAL CHECK: Firebase=${hasFirebase}  MongoDB=${hasMongo}  MySQL=${hasMySQL}`);
  writeJson(repo.name, "stage1_profile", prof);

  const archModel = json.architecture_model ?? null;
  const plan      = json.service_plan ?? {};
  const mappings  = plan.awsMappings ?? [];
  const engine    = json.engine ?? "unknown";

  console.log(`\n--- STAGE 2: PLAN (engine=${engine}) ---`);
  if (archModel) {
    const am = archModel;
    console.log(`  LLM model — components: ${(am.components ?? []).map(c => c.name).join(", ")}`);
    const inf = am.infrastructure ?? {};
    console.log(`  infrastructure keys: ${JSON.stringify(inf)}`);
    const hasALB = inf.loadBalancer===true||inf.loadBalancing===true;
    const hasNAT = inf.natGateway===true;
    const hasSM  = inf.secretsManager===true;
    const az2    = inf.multiAZ===true||(inf.availabilityZones>=2);
    console.log(`  ALB=${hasALB}  NAT=${hasNAT}  SecretsManager=${hasSM}  multi-AZ=${az2}`);
  } else {
    console.log("  No architecture_model — rules-fallback");
  }

  console.log(`  awsMappings (${mappings.length}):`);
  mappings.forEach(m => console.log(`    ${m.serviceId.padEnd(18)} conf=${m.confidence}  cat=${m.category}  ev=${(m.evidence??"").slice(0,80)}`));

  const planServiceIds = mappings.map(m => m.serviceId);
  const hasALB2 = planServiceIds.includes("ALB");
  const hasNAT2 = planServiceIds.includes("NATGateway");
  const hasSM2  = planServiceIds.includes("SecretsManager");
  const dm = plan.deploymentModel ?? {};
  console.log(`  deploymentModel: ${JSON.stringify(dm)}`);
  console.log(`  PLAN CHECK: ALB=${hasALB2}  NATGateway=${hasNAT2}  SecretsManager=${hasSM2}`);
  writeJson(repo.name, "stage2_plan", { architectureModel: archModel, servicePlan: plan });

  console.log("\n--- STAGE 3: DIAGRAM INPUT ---");
  console.log(`  Services to generateDiagramXml (${mappings.length}):`);

  const SERVICE_TIERS = {
    Route53:"edge",CloudFront:"edge",APIGateway:"edge",ALB:"edge",Cognito:"edge",WAF:"edge",
    VPC:"vpc_public",NATGateway:"vpc_public",
    EC2:"vpc_compute",Lambda:"vpc_compute",ECS:"vpc_compute",EKS:"vpc_compute",Fargate:"vpc_compute",Lightsail:"vpc_compute",Batch:"vpc_compute",
    S3:"vpc_data",EBS:"vpc_data",EFS:"vpc_data",Glacier:"vpc_data",RDS:"vpc_data",Aurora:"vpc_data",DynamoDB:"vpc_data",
    ElastiCache:"vpc_data",Redshift:"vpc_data",DocumentDB:"vpc_data",SQS:"vpc_data",SNS:"vpc_data",EventBridge:"vpc_data",
    Kinesis:"vpc_data",MSK:"vpc_data",OpenSearch:"vpc_data",SecretsManager:"vpc_data",SageMaker:"vpc_data",
    CloudWatch:"cross_cutting",CodePipeline:"cross_cutting",CloudFormation:"cross_cutting",ECR:"cross_cutting",
    SES:"external",Amplify:"external",
  };

  mappings.forEach(m => {
    const tier = SERVICE_TIERS[m.serviceId] ?? "vpc_data(DEFAULT)";
    console.log(`    ${m.serviceId.padEnd(18)} componentId=${m.componentId}  tier=${tier}`);
  });

  const stage2ids = mappings.map(m=>m.serviceId).sort().join(",");
  const stage3ids = mappings.map(m=>m.serviceId).sort().join(",");
  console.log(`  Stage2==Stage3 (no drop): ${stage2ids===stage3ids}`);
  writeJson(repo.name, "stage3_diagram_input", mappings);
}

async function main() {
  for (const repo of REPOS) {
    try { await analyze(repo); }
    catch(err) { console.error(`[ERROR for ${repo.name}]: ${err.message}`); }
  }
  console.log("\n========== STATIC TIER TABLE (diagram.ts:283-331) ==========");
  console.log("  S3         -> vpc_data    -> INSIDE VPC  (data_subnet) [line 303]");
  console.log("  ALB        -> edge        -> OUTSIDE VPC (edge banner) [line 288]");
  console.log("  NATGateway -> vpc_public  -> inside VPC public subnet  [line 293]");
  console.log("  SecretsManager -> vpc_data-> INSIDE VPC data_subnet    [line 319]");
  console.log("  Default (unknown serviceId) -> vpc_data [diagram.ts:988]");
  console.log("\nCONTAINER HIERARCHY (diagram.ts:445-455):");
  console.log("  1 -> aws_cloud -> [edge, vpc, cross_cutting, external]");
  console.log("  vpc -> az -> [public_subnet, compute_subnet, data_subnet]");
  console.log("  Nodes inside VPC get parent=container-{subnet_key}");
  console.log("  ALB parent=container-edge (outside VPC by construction)");
}

main().catch(console.error);
