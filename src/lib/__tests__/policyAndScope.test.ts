/**
 * policyAndScope.test.ts — Steps 4/5/8: policy rules on synthetic traits,
 * scope-table exhaustiveness, and the no-names-in-generic-code lint.
 *
 * All plans here are synthetic (built from trait products), never fixtures
 * of a single repo, so the rules cannot be tuned to one repository.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_IDS, type ServicePlan, type ServiceId } from "../schema.ts";
import { SERVICE_SCOPE, scopeOf } from "../diagramValidator.ts";
import { applyInfraPolicy } from "../infraPolicy.ts";
import {
  INTEGRATION_REGISTRY,
  matchIntegration,
} from "../integrationRegistry.ts";
import type { WorkloadTraits } from "../workloadTraits.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function traits(over: Partial<WorkloadTraits> = {}): WorkloadTraits {
  return {
    servesRequests: false,
    batchOnly: false,
    staticOnly: false,
    computeModel: "none",
    hasRelationalDb: false,
    hasDocumentDb: false,
    hasKvStore: false,
    hasSecrets: false,
    egressTargets: [],
    evidence: {},
    ...over,
  };
}

function emptyPlan(): ServicePlan {
  return {
    inputKind: "github_url",
    components: [],
    relationships: [],
    deploymentModel: [],
    awsMappings: [],
    detectedPattern: "generic",
    terminalState: "OK",
    metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    warnings: [],
  };
}

function mappingIds(plan: ServicePlan): string[] {
  return plan.awsMappings.map((m) => m.serviceId);
}

// ---------------------------------------------------------------------------
// Step 5: scope table replaces service tiers
// ---------------------------------------------------------------------------

describe("STEP 5: scope table keyed by scope", () => {
  it("every ServiceId has a scope row (missing rows fail, never silent)", () => {
    const missing = SERVICE_IDS.filter(
      (id) => !(id in SERVICE_SCOPE)
    );
    assert.deepStrictEqual(missing, []);
  });

  it("scopeOf throws on an unknown ServiceId instead of defaulting", () => {
    assert.throws(
      () => scopeOf("NotAService" as ServiceId),
      /no row for ServiceId/
    );
  });

  it("key placements match the scope contract", () => {
    assert.strictEqual(scopeOf("CloudFront"), "global-edge");
    assert.strictEqual(scopeOf("Route53"), "global-edge");
    assert.strictEqual(scopeOf("WAF"), "global-edge");
    assert.strictEqual(scopeOf("S3"), "regional");
    assert.strictEqual(scopeOf("SecretsManager"), "regional");
    assert.strictEqual(scopeOf("ECR"), "regional");
    assert.strictEqual(scopeOf("SES"), "regional");
    assert.strictEqual(scopeOf("Cognito"), "regional");
    assert.strictEqual(scopeOf("ALB"), "vpc-public");
    assert.strictEqual(scopeOf("NATGateway"), "vpc-public");
    assert.strictEqual(scopeOf("ECS"), "vpc-private");
    assert.strictEqual(scopeOf("RDS"), "vpc-data");
    assert.strictEqual(scopeOf("DocumentDB"), "vpc-data");
    assert.strictEqual(scopeOf("OpenSearch"), "vpc-data");
  });
});

// ---------------------------------------------------------------------------
// Step 4: policy rules on synthetic traits
// ---------------------------------------------------------------------------

describe("STEP 4: policy predicates", () => {
  it("serving compute gets a load balancer, 2 AZs, policy evidence", () => {
    const out = applyInfraPolicy(
      emptyPlan(),
      traits({ servesRequests: true, computeModel: "container" })
    );
    assert.ok(mappingIds(out).includes("ALB"));
    const alb = out.awsMappings.find((m) => m.serviceId === "ALB")!;
    assert.ok(alb.evidence.startsWith("policy: load-balancer because"));
    assert.strictEqual(alb.confidence, "low");
    assert.strictEqual(alb.category, "recommendation");
    for (const dm of out.deploymentModel) {
      assert.strictEqual(dm.availabilityZones, 2);
      assert.strictEqual(dm.hasLoadBalancer, true);
    }
  });

  it("computeModel none means no LB and a single AZ", () => {
    const out = applyInfraPolicy(
      emptyPlan(),
      traits({ servesRequests: false, computeModel: "none" })
    );
    assert.ok(!mappingIds(out).includes("ALB"));
    for (const dm of out.deploymentModel) {
      assert.strictEqual(dm.hasLoadBalancer, false);
    }
  });

  it("secrets predicate adds SecretsManager; otherwise it is pruned", () => {
    const withSecrets = applyInfraPolicy(
      emptyPlan(),
      traits({ hasSecrets: true, computeModel: "container" })
    );
    assert.ok(mappingIds(withSecrets).includes("SecretsManager"));
    const sm = withSecrets.awsMappings.find(
      (m) => m.serviceId === "SecretsManager"
    )!;
    assert.ok(sm.evidence.startsWith("policy: secrets-manager because"));
    assert.strictEqual(sm.category, "recommendation");
    assert.notStrictEqual(sm.confidence, "high");

    const seeded: ServicePlan = {
      ...emptyPlan(),
      awsMappings: [
        {
          componentId: "svc-secretsmanager",
          serviceId: "SecretsManager",
          confidence: "medium",
          evidence: "suggested",
          fromPattern: false,
          category: "recommendation",
        },
      ],
    };
    const pruned = applyInfraPolicy(seeded, traits({}));
    assert.ok(!mappingIds(pruned).includes("SecretsManager"));
  });

  it("egress with compute gets NAT; without compute it does not", () => {
    const withNat = applyInfraPolicy(
      emptyPlan(),
      traits({ egressTargets: ["example-pay"], computeModel: "container" })
    );
    assert.ok(mappingIds(withNat).includes("NATGateway"));
    const nat = withNat.awsMappings.find((m) => m.serviceId === "NATGateway")!;
    assert.ok(nat.evidence.startsWith("policy: nat-gateway because"));

    const withoutCompute = applyInfraPolicy(
      emptyPlan(),
      traits({ egressTargets: ["example-pay"], computeModel: "none" })
    );
    assert.ok(!mappingIds(withoutCompute).includes("NATGateway"));
  });

  it("relational DB sets the multi-AZ flag", () => {
    const seeded: ServicePlan = {
      ...emptyPlan(),
      components: [
        {
          id: "db",
          type: "database",
          technology: "RDS",
          evidence: ["ev"],
          confidence: "high",
          status: "detected",
        },
      ],
      deploymentModel: [
        {
          componentId: "db",
          public: false,
          needsVpc: true,
          needsMultiAz: false,
          needsAutoscaling: false,
          source: "recommended",
          availabilityZones: 1,
          hasLoadBalancer: false,
          secretsManager: false,
          natGateway: false,
          thirdPartyIntegrations: [],
        },
      ],
      awsMappings: [
        {
          componentId: "db",
          serviceId: "RDS",
          confidence: "high",
          evidence: "ev",
          fromPattern: false,
          category: "repository-evidence",
        },
      ],
    };
    const out = applyInfraPolicy(seeded, traits({ hasRelationalDb: true }));
    assert.strictEqual(out.deploymentModel[0].database?.multiAz, true);
  });

  it("static-only gets CDN + origin and no load balancer", () => {
    const out = applyInfraPolicy(emptyPlan(), traits({ staticOnly: true }));
    assert.ok(mappingIds(out).includes("S3"));
    assert.ok(mappingIds(out).includes("CloudFront"));
    assert.ok(!mappingIds(out).includes("ALB"));
  });

  it("repository-evidence mappings survive pruning", () => {
    const seeded: ServicePlan = {
      ...emptyPlan(),
      awsMappings: [
        {
          componentId: "lb",
          serviceId: "ALB",
          confidence: "high",
          evidence: "infra.tf → resource lb",
          fromPattern: false,
          category: "repository-evidence",
        },
      ],
    };
    const out = applyInfraPolicy(seeded, traits({ computeModel: "none" }));
    assert.ok(mappingIds(out).includes("ALB"));
  });

  it("policy application is idempotent", () => {
    const t = traits({
      servesRequests: true,
      computeModel: "container",
      hasSecrets: true,
      egressTargets: ["example-pay"],
      hasRelationalDb: true,
    });
    const once = applyInfraPolicy(emptyPlan(), t);
    const twice = applyInfraPolicy(once, t);
    assert.deepStrictEqual(
      twice.awsMappings.map((m) => m.serviceId).sort(),
      once.awsMappings.map((m) => m.serviceId).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// Registry sanity (data lives here, matched per dependency)
// ---------------------------------------------------------------------------

describe("registry: data, not logic", () => {
  it("matches each dependency name individually", () => {
    assert.ok(matchIntegration("stripe", "npm"));
    assert.ok(matchIntegration("psycopg2-binary", "pip"));
    assert.strictEqual(matchIntegration("some-unknown-package-xyz", "npm"), null);
  });

  it("every row carries a role, hosting, protocol and label", () => {
    for (const row of INTEGRATION_REGISTRY) {
      assert.ok(row.match instanceof RegExp);
      assert.ok(row.role);
      assert.ok(row.hosting);
      assert.ok(row.protocol);
      assert.ok(row.label);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 8 (lint): no package/framework names in generic code
// ---------------------------------------------------------------------------

describe("STEP 8 lint: generic files contain no registry names", () => {
  it("policy, traits, layout and validator code name no packages or frameworks", () => {
    const genericFiles = [
      "workloadTraits.ts",
      "infraPolicy.ts",
      "diagram.ts",
      "diagramValidator.ts",
      "inference.ts",
    ];
    const sources = new Map(
      genericFiles.map((f) => [f, readFileSync(join(HERE, "..", f), "utf8")])
    );

    // Dictionary: alphabetic tokens from registry matchers + labels,
    // minus anything a generic module may legitimately say (ServiceIds,
    // protocols, roles, hosting terms, generic English).
    const allowed = new Set<string>();
    for (const id of SERVICE_IDS) allowed.add(id.toLowerCase());
    for (const w of [
      "https", "smtp", "sdk", "tcp",
      "data", "store", "auth", "payment", "email", "storage",
      "analytics", "messaging", "other", "aws", "managed",
      "third", "party", "process", "in",
      "api", "client", "server", "service", "services", "manager",
      "gateway", "provider", "library", "libraries", "tool", "framework",
      "cache", "queue", "queueing", "task", "tasks",
      "upload", "file", "files", "mail",
      "object", "realtime", "product", "member", "members",
      // Generic English / geometry / code words that also occur as
      // regex fragments or label words in the registry.
      "node", "nodes", "amazon", "identity", "observability",
      "migration", "segment", "segments", "registry", "promise",
      "system", "project", "projects", "starter", "core", "driver",
      "drivers", "engine", "rest", "web", "js",
    ]) {
      allowed.add(w);
    }

    const dict = new Set<string>();
    for (const row of INTEGRATION_REGISTRY) {
      const chunks = `${row.match.source} ${row.label}`.toLowerCase().split(/[^a-z]+/);
      for (const tok of chunks) {
        if (tok.length >= 4 && !allowed.has(tok)) dict.add(tok);
      }
    }

    const failures: string[] = [];
    for (const [file, src] of sources) {
      const low = src.toLowerCase();
      for (const tok of dict) {
        // Skip tokens that are substrings of allowed words is handled by
        // word-boundary matching below.
        const re = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (re.test(low)) failures.push(`${file} mentions "${tok}"`);
      }
    }
    assert.deepStrictEqual(failures, []);
  });
});
