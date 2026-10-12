/**
 * cost.ts — Stage 5: CostService
 *
 * Computes monthly cost estimates for each service in a ServicePlan.
 *
 * Algorithm:
 *   monthlyEstimate = unitPrice × (quantity × userScaleFactor)
 *
 * Where:
 *   unitPrice       = fetched from PriceService (live or fallback)
 *   quantity        = SERVICE_DEFAULTS[serviceId].baseQuantity
 *   userScaleFactor = userCount / BASE_USER_COUNT (= userCount / 10_000)
 *
 * Services without a SERVICE_DEFAULTS entry are listed as "unpriced" with
 * a note, never silently dropped.
 *
 * Exported:
 *   computeCostRows(plan, region, userCount) → Promise<CostResult>
 */

import type { ServicePlan, AwsServiceMapping } from "./schema.ts";
import { getUnitPrice, getPriceSourceMode } from "./prices.ts";
import type { PriceSourceMode } from "./prices.ts";
import { getServiceDefaults, BASE_USER_COUNT, FIXED_COST_SERVICES } from "./SERVICE_DEFAULTS.ts";
import type { RdsEngineLabel } from "./SERVICE_DEFAULTS.ts";
import { readTopology } from "./topology.ts";
import { scopeOf } from "./diagram.ts";

/** Cognito User Pools free tier: first 50k MAU free. */
const COGNITO_FREE_TIER_MAU = 50_000;

/** Task-based compute: priced per running task, replicated across AZs. */
const TASK_COMPUTE_SERVICES: ReadonlySet<string> = new Set([
  "ECS",
  "Fargate",
  "AppRunner",
  "Batch",
]);

/** Instance-based stores: a Multi-AZ standby doubles the instance hours. */
const DB_INSTANCE_SERVICES: ReadonlySet<string> = new Set([
  "RDS",
  "Aurora",
  "ElastiCache",
  "DocumentDB",
  "MemoryDB",
  "Neptune",
  "Redshift",
]);

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface CostRow {
  serviceId: string;
  componentId: string;
  unitLabel: string;
  quantity: number;
  unitPrice: number;
  monthlyUsd: number;
  priceSource: "live" | "fallback";
  annotation: string;
  fixed?: boolean;
}

export interface UnpricedRow {
  serviceId: string;
  componentId: string;
  note: string;
}

export interface CostResult {
  rows: CostRow[];
  unpricedRows: UnpricedRow[];
  totalMonthlyUsd: number;
  region: string;
  userCount: number;
  computedAt: string;
  priceSourceMode?: PriceSourceMode;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Computes monthly cost estimates for every service in the ServicePlan.
 *
 * @param plan         The inferred ServicePlan
 * @param region       AWS region string (e.g. "us-east-1")
 * @param userCount    User-provided user count for scaling (default: 10_000)
 * @param priceSource  Price data source: "bulk" (default) or "sdk" (@aws-sdk/client-pricing)
 */
export async function computeCostRows(
  plan: ServicePlan,
  region: string = "us-east-1",
  userCount: number = BASE_USER_COUNT,
  priceSource?: PriceSourceMode
): Promise<CostResult> {
  const rows: CostRow[] = [];
  const unpricedRows: UnpricedRow[] = [];

  const userScaleFactor = Math.max(userCount, 1) / BASE_USER_COUNT;
  const dbEngine = (plan.metadata?.dbEngine ?? "none") as RdsEngineLabel;
  // One topology reader for cost, diagram and template: quantities below
  // follow the same flags the diagram lays out and the CFT provisions.
  const topo = readTopology(plan);

  // ECS/Fargate defence in depth: Fix 1 folds Fargate into ECS upstream, but
  // if both survive into the final plan, price only the richer ECS row.
  const mappings = plan.awsMappings.filter(
    (m, _, arr) =>
      m.serviceId !== "Fargate" || !arr.some((o) => o.serviceId === "ECS")
  );

  // Fetch prices for all services in parallel.
  // External (third-party hosted) mappings follow the same hosting field:
  // they are reported as $0 external rows, never priced as AWS resources.
  const pricePromises = mappings.map(async (mapping) => {
    if (mapping.external === true) {
      unpricedRows.push({
        serviceId: mapping.serviceId,
        componentId: mapping.componentId,
        note: `External (third-party hosted) — not billed as an AWS resource.`,
      });
      return null;
    }
    const baseline = getServiceDefaults(mapping.serviceId, dbEngine);

    if (!baseline) {
      unpricedRows.push({
        serviceId: mapping.serviceId,
        componentId: mapping.componentId,
        note: `No pricing baseline configured for "${mapping.serviceId}".`,
      });
      return null;
    }

    // Topology-adjusted baseline: tasks across AZs, standby replicas,
    // per-AZ NAT hours, ALB + LCU, one price per secret.
    const defaults = { ...baseline };
    if (TASK_COMPUTE_SERVICES.has(mapping.serviceId)) {
      const tasks = Math.max(topo.computeTasks, 2) * topo.availabilityZones / 2;
      defaults.baseQuantity = 360 * tasks;
      defaults.annotation = `${baseline.annotation}; scaled: ${tasks} tasks × 0.5 vCPU across ${topo.availabilityZones} AZ(s)`;
    } else if (DB_INSTANCE_SERVICES.has(mapping.serviceId) && topo.multiAz) {
      defaults.baseQuantity = baseline.baseQuantity * 2;
      defaults.annotation = `${baseline.annotation}; Multi-AZ standby included (×2)`;
    } else if (mapping.serviceId === "NATGateway") {
      defaults.baseQuantity = 720 * topo.availabilityZones;
      defaults.unitLabel = "NAT Gateway-hours/mo + data processing";
      defaults.annotation = `${baseline.annotation}; ${topo.availabilityZones} AZ(s) × 720 h, plus data-processing per GB (see Assumptions)`;
    } else if (mapping.serviceId === "ALB" || mapping.serviceId === "NLB" || mapping.serviceId === "GLB") {
      defaults.annotation = `${baseline.annotation}; plus LCU charges per evaluated rule (see Assumptions)`;
    }

    const { price, source } = await getUnitPrice(
      mapping.serviceId,
      defaults.serviceCode,
      defaults.usageTypePrefix,
      region,
      priceSource
    );

    const isFixed = FIXED_COST_SERVICES.has(mapping.serviceId);
    const scaledQuantity = isFixed ? defaults.baseQuantity : defaults.baseQuantity * userScaleFactor;
    // Cognito bills only MAU past the 50k free tier.
    const billableQuantity =
      mapping.serviceId === "Cognito"
        ? Math.max(scaledQuantity - COGNITO_FREE_TIER_MAU, 0)
        : scaledQuantity;
    const monthlyUsd = price * billableQuantity;

    const row: CostRow = {
      serviceId: mapping.serviceId,
      componentId: mapping.componentId,
      unitLabel: defaults.unitLabel,
      quantity: billableQuantity,
      unitPrice: price,
      monthlyUsd,
      priceSource: source,
      annotation: defaults.annotation,
      fixed: isFixed,
    };

    return row;
  });

  const results = await Promise.all(pricePromises);

  for (const result of results) {
    if (result !== null) {
      rows.push(result);
    }
  }

  // Every diagram node gets a cost row or an explicit free note. Mappings
  // are covered above; the structural Users ingress marker and the
  // third-party integration boxes are free by construction.
  const pricedIds = new Set([
    ...rows.map((r) => `${r.serviceId}|${r.componentId}`),
    ...unpricedRows.map((r) => `${r.serviceId}|${r.componentId}`),
  ]);
  const hasEdgeTier = plan.awsMappings.some((m) => {
    try {
      return scopeOf(m.serviceId) === "global-edge";
    } catch {
      return false;
    }
  });
  if (hasEdgeTier && !pricedIds.has("Users|users")) {
    unpricedRows.push({
      serviceId: "Users",
      componentId: "users",
      note: "Structural ingress marker — not a billable AWS resource (free).",
    });
  }
  const seenInteg = new Set<string>();
  for (const dm of plan.deploymentModel ?? []) {
    for (const t of dm.thirdPartyIntegrations ?? []) {
      if (seenInteg.has(t.name)) continue;
      seenInteg.add(t.name);
      unpricedRows.push({
        serviceId: t.name,
        componentId: `ext-${t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        note: "External third-party integration — not billed as an AWS resource (free).",
      });
    }
  }

  // Sort rows by monthly cost descending (most expensive first)
  rows.sort((a, b) => b.monthlyUsd - a.monthlyUsd);

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    rows,
    unpricedRows,
    totalMonthlyUsd,
    region,
    userCount,
    computedAt: new Date().toISOString(),
    priceSourceMode: priceSource ?? getPriceSourceMode(),
  };
}

// ---------------------------------------------------------------------------
// Client-side scaling (pure math — no fetch)
// ---------------------------------------------------------------------------

/**
 * Re-scales an existing CostResult to a new userCount without re-fetching prices.
 * Safe to call on the client since it only does arithmetic.
 *
 * @param original  The CostResult returned by computeCostRows()
 * @param newCount  The new user count to scale to
 */
export function scaleCostRows(original: CostResult, newCount: number): CostResult {
  const ratio = Math.max(newCount, 1) / Math.max(original.userCount, 1);

  const rows: CostRow[] = original.rows.map((r) => {
    if (r.fixed) return r;
    return {
      ...r,
      quantity: r.quantity * ratio,
      monthlyUsd: r.monthlyUsd * ratio,
    };
  });

  const totalMonthlyUsd = rows.reduce((sum, r) => sum + r.monthlyUsd, 0);

  return {
    ...original,
    rows,
    totalMonthlyUsd,
    userCount: newCount,
    computedAt: new Date().toISOString(),
    priceSourceMode: original.priceSourceMode,
  };
}