/**
 * topology.ts — Single topology reader for the plan.
 *
 * Every downstream stage (diagram layout, cost, CFT export) reads the same
 * flags from the ServicePlan, so the three outputs agree on one topology.
 * Pure function, no network.
 */

import type { ServicePlan } from "./schema.ts";

export interface PlanTopology {
  /** Replicated AZ count (1..6). */
  availabilityZones: number;
  /** A load balancer fronts compute. */
  loadBalancer: boolean;
  /** External egress passes a NAT gateway. */
  nat: boolean;
  /** Credential material needs Secrets Manager. */
  secrets: boolean;
  /** A relational store runs Multi-AZ. */
  multiAz: boolean;
  /** Baseline task count across task-based compute (2 per mapping). */
  computeTasks: number;
}

/** Task-based compute: priced per running task, scaled across AZs. */
const TASK_SERVICES: ReadonlySet<string> = new Set([
  "ECS",
  "Fargate",
  "AppRunner",
  "Batch",
]);

const LB_SERVICES: ReadonlySet<string> = new Set(["ALB", "NLB", "GLB"]);

/** Baseline tasks per task-based compute mapping (matches ECS default). */
export const TASKS_PER_COMPUTE_MAPPING = 2;

/**
 * Reads the deployment topology from plan flags (deployment-model fields
 * backed by mapping presence, so synthetic plans without a policy pass
 * still resolve). One reader: cost.ts and cftExport.ts must both use it.
 */
export function readTopology(plan: ServicePlan): PlanTopology {
  const dms = plan.deploymentModel ?? [];
  const mapped = new Set(plan.awsMappings.map((m) => m.serviceId));

  const availabilityZones = Math.min(
    6,
    Math.max(1, ...dms.map((d) => d.availabilityZones ?? 1))
  );
  const loadBalancer =
    dms.some((d) => d.hasLoadBalancer === true) ||
    [...LB_SERVICES].some((s) => mapped.has(s as never));
  const nat =
    dms.some((d) => d.natGateway === true) || mapped.has("NATGateway" as never);
  const secrets =
    dms.some((d) => d.secretsManager === true) ||
    mapped.has("SecretsManager" as never);
  const multiAz = dms.some((d) => d.database?.multiAz === true);
  const computeTasks =
    plan.awsMappings.filter(
      (m) => TASK_SERVICES.has(m.serviceId) && m.external !== true
    ).length * TASKS_PER_COMPUTE_MAPPING;

  return {
    availabilityZones,
    loadBalancer,
    nat,
    secrets,
    multiAz,
    computeTasks,
  };
}
