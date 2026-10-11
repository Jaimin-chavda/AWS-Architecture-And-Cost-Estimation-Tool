/**
 * infraPolicy.ts — STEP 4: One policy module (pure function).
 *
 * Called from the single choke point in inference.ts after the winning path
 * (LLM or rules) produces a plan, and from ruleEngine.buildServicePlan so
 * direct rules callers see the same gates. Idempotent: re-applying changes
 * nothing.
 *
 * Each rule is a small named predicate over WorkloadTraits. Every injected
 * service records "policy: <rule> because <trait> (<evidence>)" with
 * category "recommendation" and "low" confidence — never "detected".
 * Nothing is added unless its predicate fired (no unconditional injections).
 *
 * This file contains no package, repo or framework names. It reads traits
 * and ServiceIds only.
 */

import type {
  ServicePlan,
  ServiceId,
  AwsServiceMapping,
  DiscoveredComponent,
} from "./schema.ts";
import { serviceTypeFromId } from "./ruleEngine.ts";
import type { WorkloadTraits } from "./workloadTraits.ts";

export type PolicyRuleName =
  | "load-balancer"
  | "no-compute"
  | "secrets-manager"
  | "nat-gateway"
  | "relational-multi-az"
  | "static-origin";

function policyEvidence(rule: PolicyRuleName, trait: string, evidence: string): string {
  return `policy: ${rule} because ${trait} (${evidence})`;
}

function ensureMapping(
  plan: ServicePlan,
  serviceId: ServiceId,
  rule: PolicyRuleName,
  trait: string,
  traitEvidence: string
): void {
  const existing = plan.awsMappings.find((m) => m.serviceId === serviceId);
  if (existing) {
    // A repository-evidence mapping already proves this service; leave it.
    // A previous policy injection is already correct (idempotency).
    return;
  }
  const evidence = policyEvidence(rule, trait, traitEvidence);
  const componentId = `svc-${serviceId.toLowerCase()}`;
  const mapping: AwsServiceMapping = {
    componentId,
    serviceId,
    confidence: "low",
    evidence: evidence.slice(0, 200),
    fromPattern: false,
    category: "recommendation",
  };
  plan.awsMappings.push(mapping);
  if (!plan.components.some((c) => c.id === componentId)) {
    const component: DiscoveredComponent = {
      id: componentId,
      type: serviceTypeFromId(serviceId),
      technology: serviceId,
      evidence: [evidence.slice(0, 200)],
      confidence: "low",
      status: "inferred",
    };
    plan.components.push(component);
  }
  if (!plan.deploymentModel.some((d) => d.componentId === componentId)) {
    plan.deploymentModel.push({
      componentId,
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
    });
  }
}

/**
 * Drops recommendation/inference mappings for a service when its predicate
 * did not fire. Repository-evidence mappings (ground truth such as declared
 * config resources) always survive.
 */
function pruneUnevidenced(plan: ServicePlan, serviceId: ServiceId): void {
  const removed = new Set<string>();
  plan.awsMappings = plan.awsMappings.filter((m) => {
    if (m.serviceId !== serviceId) return true;
    if (m.category === "repository-evidence") return true;
    if (/\.tf\b/i.test(m.evidence)) return true;
    removed.add(m.componentId);
    return false;
  });
  if (removed.size === 0) return;
  const stillUsed = new Set(plan.awsMappings.map((m) => m.componentId));
  plan.components = plan.components.filter(
    (c) => !removed.has(c.id) || stillUsed.has(c.id) || c.status === "detected"
  );
  plan.deploymentModel = plan.deploymentModel.filter(
    (d) => !removed.has(d.componentId) || stillUsed.has(d.componentId)
  );
  plan.relationships = (plan.relationships ?? []).filter(
    (r) => !removed.has(r.from) && !removed.has(r.to)
  );
}

function isRelationalComponent(plan: ServicePlan, componentId: string): boolean {
  const comp = plan.components.find((c) => c.id === componentId);
  if (comp && comp.type === "database") {
    const mapping = plan.awsMappings.find((m) => m.componentId === componentId);
    return mapping === undefined || mapping.serviceId === "RDS" || mapping.serviceId === "Aurora";
  }
  return false;
}

export function applyInfraPolicy(
  plan: ServicePlan,
  traits: WorkloadTraits
): ServicePlan {
  const next: ServicePlan = structuredClone(plan);
  const ev = (k: keyof Omit<WorkloadTraits, "evidence" | "egressTargets">, fallback: string) =>
    traits.evidence[k] ?? fallback;

  // Rule: servesRequests && computeModel != none -> load balancer, 2 AZs.
  if (traits.servesRequests && traits.computeModel !== "none") {
    ensureMapping(
      next,
      "ALB",
      "load-balancer",
      "servesRequests with backend compute",
      ev("servesRequests", "request-serving workload")
    );
    for (const dm of next.deploymentModel) {
      dm.availabilityZones = 2;
      dm.hasLoadBalancer = true;
    }
  } else {
    // Rule: computeModel == none (or nothing serves requests) -> no LB.
    pruneUnevidenced(next, "ALB");
    for (const dm of next.deploymentModel) {
      dm.hasLoadBalancer = false;
      if (!traits.servesRequests || traits.computeModel === "none") {
        dm.availabilityZones = 1;
      }
    }
  }

  // Rule: secrets predicate -> secrets manager, else prune the suggestion.
  if (traits.hasSecrets) {
    ensureMapping(
      next,
      "SecretsManager",
      "secrets-manager",
      "hasSecrets",
      ev("hasSecrets", "secret material or sensitive-role integration")
    );
    for (const dm of next.deploymentModel) {
      dm.secretsManager = true;
    }
  } else {
    pruneUnevidenced(next, "SecretsManager");
    for (const dm of next.deploymentModel) {
      dm.secretsManager = false;
    }
  }

  // Rule: egress && compute -> NAT in the public subnet.
  if (traits.egressTargets.length > 0 && traits.computeModel !== "none") {
    ensureMapping(
      next,
      "NATGateway",
      "nat-gateway",
      "egressTargets with backend compute",
      traits.evidence.egressTargets ?? "external egress"
    );
    for (const dm of next.deploymentModel) {
      dm.natGateway = true;
    }
  } else {
    pruneUnevidenced(next, "NATGateway");
    for (const dm of next.deploymentModel) {
      dm.natGateway = false;
    }
  }

  // Rule: relational DB -> multi-AZ flag. Document stores stay external
  // when third-party hosted: no VPC data-subnet flag is set for them here.
  if (traits.hasRelationalDb) {
    for (const dm of next.deploymentModel) {
      if (isRelationalComponent(next, dm.componentId)) {
        dm.database = { multiAz: true };
        if (!dm.notes) dm.notes = "Production DB → recommend Multi-AZ";
      }
    }
  }

  // Rule: static-only or client-only frontend -> CDN + object storage
  // origin, and no compute-flavoured suggestions.
  if (traits.staticOnly) {
    ensureMapping(
      next,
      "S3",
      "static-origin",
      "staticOnly",
      "static frontend without backend"
    );
    ensureMapping(
      next,
      "CloudFront",
      "static-origin",
      "staticOnly",
      "static frontend without backend"
    );
  }

  return next;
}
