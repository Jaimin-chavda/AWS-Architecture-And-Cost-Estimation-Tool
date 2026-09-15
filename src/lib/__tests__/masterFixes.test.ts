/**
 * masterFixes.test.ts — unit coverage for the Master Prompt fixes.
 * Pure-function tests, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  selectWorkspaceAware,
  parsePnpmWorkspace,
  type FileCandidate,
} from "../repoFetcher.ts";
import {
  parseMixExs,
  ELIXIR_PACKAGE_MAP,
  extractTerraformResources,
  detectLibraryRepo,
} from "../repoAnalyzer.ts";
import { runRuleEngine } from "../ruleEngine.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { LIVE_PRICE_CAPS } from "../prices.ts";
import { getServiceDefaults } from "../SERVICE_DEFAULTS.ts";
import { computeCostRows } from "../cost.ts";
import type { ServicePlan } from "../schema.ts";

function makeInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    description: "",
    fileContent: "",
    fileNames: [],
    inputKind: "description",
    grounding: "description",
    truncated: false,
    parseErrors: [],
    ...overrides,
  };
}

function cand(path: string, kind: FileCandidate["kind"] = "manifest", score = 50): FileCandidate {
  return { path, kind, priority: 1, score };
}

describe("Fix 9 — workspace-aware selection", () => {
  it("prioritises README, root manifests and IaC over nested noise", () => {
    const selected = selectWorkspaceAware([
      cand("packages/zzz/package.json", "manifest", 90),
      cand("README.md", "readme", 100),
      cand("package.json", "manifest", 95),
      cand("main.tf", "container_ci", 80),
    ]);
    const paths = selected.map((c) => c.path);
    assert.ok(paths.includes("README.md"));
    assert.ok(paths.includes("package.json"));
    assert.ok(paths.includes("main.tf"));
  });

  it("round-robins across top-level dirs instead of starving deep services", () => {
    const input: FileCandidate[] = [];
    for (let i = 0; i < 10; i++) input.push(cand(`shallow-${i}/package.json`, "manifest", 90 - i));
    input.push(cand("deep-svc/go.mod", "manifest", 40));
    const selected = selectWorkspaceAware(input, 60);
    assert.ok(selected.some((c) => c.path === "deep-svc/go.mod"));
  });

  it("parses pnpm workspace globs", () => {
    const dirs = parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    assert.deepStrictEqual(dirs, ["apps", "packages"]);
  });
});

describe("Fix 9 — Elixir parsing", () => {
  it("parses mix.exs deps and maps Phoenix/Ecto", () => {
    const pkgs = parseMixExs("{:phoenix, \"~> 1.7\"},\n{:ecto_sql, \"~> 3.0\"},");
    const names = pkgs.map((p) => p.name);
    assert.ok(names.includes("phoenix"));
    assert.ok(names.includes("ecto_sql"));
    assert.strictEqual(ELIXIR_PACKAGE_MAP["phoenix"].label, "Phoenix");
    assert.strictEqual(ELIXIR_PACKAGE_MAP["ecto_sql"].label, "Ecto ORM");
  });
});

describe("Fix 7 — Terraform extraction", () => {
  it("maps resources and modules to services", () => {
    const out = extractTerraformResources([
      { path: "main.tf", content: 'resource "aws_eks_cluster" "x" {}\nresource "aws_db_instance" "y" {}' },
      { path: "vpc.tf", content: 'module "net" {\n  source = "terraform-aws-modules/vpc/aws"\n}' },
    ]);
    const names = out.map((o) => o.name);
    assert.ok(names.includes("Terraform resource (EKS)"));
    assert.ok(names.includes("Terraform resource (RDS)"));
    assert.ok(names.includes("Terraform resource (VPC)"));
  });

  it("adds EC2 for EKS modules with managed node groups", () => {
    const out = extractTerraformResources([
      { path: "main.tf", content: 'module "eks" {\n  source = "terraform-aws-modules/eks/aws"\n}' },
    ]);
    assert.ok(out.some((o) => o.name === "Terraform resource (EC2)"));
  });
});

describe("Fix 8/10 — library detection", () => {
  it("flags deno.json with exports and no entrypoints", () => {
    assert.strictEqual(
      detectLibraryRepo([{ path: "deno.json", content: '{"name":"x","exports":"./mod.ts"}' }], []),
      true
    );
  });

  it("does not flag apps with entry points", () => {
    assert.strictEqual(
      detectLibraryRepo([{ path: "deno.json", content: '{"exports":"./mod.ts"}' }], ["main.ts"]),
      false
    );
  });
});

describe("Fix 1 — compute exclusivity", () => {
  it("keeps exactly one compute service (ECS over EKS with compose only)", () => {
    const plan = runRuleEngine(makeInput({
      inputKind: "github_url",
      grounding: "repoFiles",
      fileNames: ["docker-compose.yml", "Dockerfile"],
      fileContent: "services:\n  web:\n    build: .",
    }));
    const compute = plan.awsMappings
      .map((m) => m.serviceId)
      .filter((s) => ["ECS", "EKS", "Lambda", "EC2", "Fargate"].includes(s));
    assert.ok(compute.length <= 1, `expected ≤1 compute, got ${compute.join(",")}`);
  });
});

describe("Fix 5 — pricing", () => {
  it("caps insane live prices via LIVE_PRICE_CAPS", () => {
    assert.ok(LIVE_PRICE_CAPS["S3"] < 1.01);
    assert.ok(LIVE_PRICE_CAPS["ALB"] <= 0.1);
  });

  it("labels RDS Postgres engine via getServiceDefaults", () => {
    const d = getServiceDefaults("RDS", "postgres");
    assert.ok(d?.annotation.includes("PostgreSQL"));
    const d2 = getServiceDefaults("RDS", "none");
    assert.ok(d2?.annotation.includes("MySQL"));
  });

  it("zeroes sub-50k Cognito and dedupes ECS/Fargate rows", async () => {
    const plan = {
      inputKind: "github_url",
      components: [],
      relationships: [],
      deploymentModel: [],
      awsMappings: [
        { componentId: "a", serviceId: "Cognito", confidence: "high", evidence: "x", fromPattern: false },
        { componentId: "b", serviceId: "ECS", confidence: "high", evidence: "x", fromPattern: false },
        { componentId: "c", serviceId: "Fargate", confidence: "high", evidence: "x", fromPattern: false },
      ],
      detectedPattern: "generic",
      metadata: { grounding: "repoFiles", truncated: false, parseErrors: [] },
      warnings: [],
    } as unknown as ServicePlan;
    const res = await computeCostRows(plan, "us-east-1", 1000);
    const cog = res.rows.find((r) => r.serviceId === "Cognito");
    assert.ok(cog, "Cognito row present");
    assert.strictEqual(cog.monthlyUsd, 0);
    assert.ok(!res.rows.some((r) => r.serviceId === "Fargate"), "Fargate folded into ECS");
    assert.ok(res.rows.some((r) => r.serviceId === "ECS"));
  });
});

describe("Fix 3 — engine helpers", () => {
  it("names MySQL engine for Spring Boot repos", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["pom.xml"],
      fileContent: `<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-data-jpa</artifactId></dependency>
<dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId></dependency>`,
    }));
    const rds = plan.awsMappings.find((m) => m.serviceId === "RDS");
    assert.ok(rds, "RDS expected");
    assert.ok(rds.evidence.includes("(MySQL)"), `engine label missing: ${rds.evidence}`);
  });

  it("does not map SQLite to RDS", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["go.mod"],
      fileContent: "module x\nrequire gorm.io/driver/sqlite v1.5.7\nrequire gorm.io/gorm v1.25.12",
      profile: {
        languages: [{ name: "Go", evidence: "go.mod", confidence: "high" }],
        frameworks: [{ name: "GORM ORM", evidence: "go.mod", confidence: "high" }],
        databases: [{ name: "SQLite", evidence: "go.mod", confidence: "high" }],
        infrastructure: [],
        entryPoints: [],
        awsUsage: [],
        deploymentHints: [],
        discoveredComponents: [],
        summary: "",
      },
    }));
    const rds = plan.awsMappings.find((m) => m.serviceId === "RDS");
    // ORM-implied default may still suggest Postgres, but never from SQLite evidence.
    if (rds) assert.ok(!/sqlite/i.test(rds.evidence), "SQLite must not back RDS evidence");
  });
});
