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
 * Nothing is added unless its predicate triggered (no unconditional injections).
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
  | "datastore-credentials"
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
  const evidence = policyEvidence(rule, trait, traitEvidence);
  const existing = plan.awsMappings.find((m) => m.serviceId === serviceId);
  if (existing) {
    // Repository ground truth (declared config resources) is never
    // rewritten. Anything else the predicate confirmed is adopted into the
    // policy: evidence becomes the policy record, so the validator's
    // policy-evidence rule holds and re-application is idempotent.
    if (existing.category === "repository-evidence" || /\.tf\b/i.test(existing.evidence)) {
      return;
    }
    existing.evidence = evidence.slice(0, 200);
    existing.confidence = "low";
    existing.category = "recommendation";
    const comp = plan.components.find((c) => c.id === existing.componentId);
    if (comp) {
      comp.evidence = [evidence.slice(0, 200)];
      comp.confidence = "low";
      if (comp.status !== "detected") comp.status = "inferred";
    }
    return;
  }
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
 * did not trigger. Repository-evidence mappings (ground truth such as declared
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
  const gated: ServicePlan = structuredClone(plan);
  const ev = (k: keyof Omit<WorkloadTraits, "evidence" | "egressTargets">, fallback: string) =>
    traits.evidence[k] ?? fallback;

  // Rule: servesRequests && computeModel != none -> load balancer, 2 AZs.
  if (traits.servesRequests && traits.computeModel !== "none") {
    ensureMapping(
      gated,
      "ALB",
      "load-balancer",
      "servesRequests with backend compute",
      ev("servesRequests", "request-serving workload")
    );
    for (const dm of gated.deploymentModel) {
      dm.availabilityZones = 2;
      dm.hasLoadBalancer = true;
    }
  } else {
    // Rule: computeModel == none (or nothing serves requests) -> no LB,
    // no compute suggestions: drop unevidenced compute/LB mappings.
    pruneUnevidenced(gated, "ALB");
    if (traits.computeModel === "none") {
      for (const svc of [
        "ECS",
        "EKS",
        "Fargate",
        "AppRunner",
        "ElasticBeanstalk",
        "EC2",
        "Lightsail",
        "Batch",
        "Lambda",
      ] as ServiceId[]) {
        pruneUnevidenced(gated, svc);
      }
    }
    for (const dm of gated.deploymentModel) {
      dm.hasLoadBalancer = false;
      if (!traits.servesRequests || traits.computeModel === "none") {
        dm.availabilityZones = 1;
      }
    }
  }

  // Rule: secrets predicate -> secrets manager, else prune the suggestion.
  // A data store reached over the network with credentials (connection
  // string or credential env var as evidence) always qualifies on its own.
  if (traits.dbCredentialEvidence) {
    ensureMapping(
      gated,
      "SecretsManager",
      "datastore-credentials",
      "networked data store with credential evidence",
      traits.dbCredentialEvidence
    );
    for (const dm of gated.deploymentModel) {
      dm.secretsManager = true;
    }
  } else if (traits.hasSecrets) {
    ensureMapping(
      gated,
      "SecretsManager",
      "secrets-manager",
      "hasSecrets",
      ev("hasSecrets", "secret material or sensitive-role integration")
    );
    for (const dm of gated.deploymentModel) {
      dm.secretsManager = true;
    }
  } else {
    pruneUnevidenced(gated, "SecretsManager");
    for (const dm of gated.deploymentModel) {
      dm.secretsManager = false;
    }
  }

  // Rule: egress && compute -> NAT in the public subnet.
  if (traits.egressTargets.length > 0 && traits.computeModel !== "none") {
    ensureMapping(
      gated,
      "NATGateway",
      "nat-gateway",
      "egressTargets with backend compute",
      traits.evidence.egressTargets ?? "external egress"
    );
    for (const dm of gated.deploymentModel) {
      dm.natGateway = true;
    }
  } else {
    pruneUnevidenced(gated, "NATGateway");
    for (const dm of gated.deploymentModel) {
      dm.natGateway = false;
    }
  }

  // Rule: relational DB -> multi-AZ flag. Document stores stay external
  // when third-party hosted: no VPC data-subnet flag is set for them here.
  if (traits.hasRelationalDb) {
    for (const dm of gated.deploymentModel) {
      if (isRelationalComponent(gated, dm.componentId)) {
        dm.database = { multiAz: true };
        if (!dm.notes) dm.notes = "Production DB → recommend Multi-AZ";
      }
    }
  }

  // Rule: static-only or client-only frontend -> CDN + object storage
  // origin, and no compute-flavoured suggestions.
  if (traits.staticOnly) {
    ensureMapping(
      gated,
      "S3",
      "static-origin",
      "staticOnly",
      "static frontend without backend"
    );
    ensureMapping(
      gated,
      "CloudFront",
      "static-origin",
      "staticOnly",
      "static frontend without backend"
    );
  }

  return gated;
}
