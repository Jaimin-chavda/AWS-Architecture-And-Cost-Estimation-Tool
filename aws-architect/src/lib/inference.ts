/**
 * inference.ts  —  FLOW.md Stage 3: Inference orchestration
 *
 * New pipeline (avoids collapse problem by construction):
 *   RepoSignals/description → LLM → ArchitectureModel → validation
 *     → deterministic AWS service mapping → ServicePlan
 *
 * The LLM never picks AWS services directly. It builds a single structured
 * ArchitectureModel of the whole application as a system; architecture.ts maps
 * that model to the ServicePlan. Downstream (diagram, cost) consume the ServicePlan.
 */

import { runRuleEngine, serviceTypeFromId } from "./ruleEngine.ts";
import { analyzeArchitecture, llmConfigured } from "./llmClient.ts";
import { mapArchitectureModelToServicePlan, deduplicateAwsMappings } from "./architecture.ts";
import type { ArchitectureModel } from "./architecture.ts";
import {
  ServicePlanSchema,
  SERVICE_IDS,
  SERVICE_CATEGORIES,
  type ServicePlan,
  type ServiceId,
  type DiscoveredComponent,
  type AwsServiceMapping,
  type ComponentRelationship,
  type DeploymentModel,
  type ConfidenceTier,
  type MappingCategory,
  type ComponentType,
  type Grounding,
} from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Grounding derivation
// ---------------------------------------------------------------------------

export function deriveGrounding(opts: {
  description?: string;
  fetchedFiles?: { content: string | null }[];
  treeFilenames?: string[];
}): Grounding {
  if (opts.description && opts.description.trim().length > 0) {
    return "description";
  }
  const files = opts.fetchedFiles ?? [];
  const hasContent = files.some((f) => f.content !== null);
  if (hasContent) {
    return "repoFiles";
  }
  if (files.length > 0 || (opts.treeFilenames && opts.treeFilenames.length > 0)) {
    return "filenameOnly";
  }
  return "unfounded";
}

/** Caps all component confidence to "low" for non-code grounded results. */
export function applyGroundingCap(plan: ServicePlan, grounding: Grounding): ServicePlan {
  if (grounding === "repo" || grounding === "repoFiles") return plan;

  const cappedComponents = plan.components.map((c) => ({ ...c, confidence: "low" as const }));
  const cappedMappings = plan.awsMappings.map((m) => ({ ...m, confidence: "low" as const }));
  return { ...plan, components: cappedComponents, awsMappings: cappedMappings };
}

import { buildAlternateProposal } from "./patternAlternates.ts";

const CONFIDENCE_RANK: Record<ConfidenceTier, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const CATEGORY_RANK: Record<MappingCategory, number> = {
  "repository-evidence": 4,
  "deployment-requirement": 3,
  "inference": 2,
  "recommendation": 1,
};

function isGenericComponentId(id: string): boolean {
  const lower = id.toLowerCase();
  return (
    lower.startsWith("svc-") ||
    lower.startsWith("pattern-") ||
    lower.startsWith("list-") ||
    lower === "fallback"
  );
}

function resolveServiceAndTier(
  c: DiscoveredComponent,
  mappings: AwsServiceMapping[]
): { serviceId?: ServiceId; tier: string } {
  // 1. Direct mapping match by componentId
  const direct = mappings.find(
    (m) => m.componentId.toLowerCase() === c.id.toLowerCase()
  );
  if (direct) {
    const tier = (SERVICE_CATEGORIES[direct.serviceId] ?? c.type) as string;
    return { serviceId: direct.serviceId, tier };
  }

  // 2. Match by svc-<serviceId>
  if (c.id.toLowerCase().startsWith("svc-")) {
    const svcName = c.id.slice(4).toLowerCase();
    const match = (SERVICE_IDS as readonly string[]).find(
      (s) => s.toLowerCase() === svcName
    ) as ServiceId | undefined;
    if (match) {
      const tier = (SERVICE_CATEGORIES[match] ?? c.type) as string;
      return { serviceId: match, tier };
    }
  }

  // 3. Match by technology matching a known ServiceId
  const techBase = c.technology.split(/[\s(]/)[0];
  const techMatch = (SERVICE_IDS as readonly string[]).find(
    (s) => s.toLowerCase() === techBase.toLowerCase()
  ) as ServiceId | undefined;
  if (techMatch) {
    const tier = (SERVICE_CATEGORIES[techMatch] ?? c.type) as string;
    return { serviceId: techMatch, tier };
  }

  return { tier: c.type };
}

/**
 * Merges a single baseline ServicePlan with an optional LLM-derived plan and applies grounding caps.
 * Consolidates duplicate components and mappings sharing the same logical role or serviceId.
 * Passes the complete merged service list through ServicePlanSchema.safeParse without truncation.
 */
export function mergeSingleServicePlan(
  baseline: ServicePlan,
  llmResult?: ServicePlan | null,
  grounding?: Grounding
): ServicePlan {
  const effectiveGrounding = grounding ?? baseline.metadata.grounding;

  // 1. Merge AWS Mappings
  let combinedMappings: AwsServiceMapping[];
  if (llmResult && Array.isArray(llmResult.awsMappings)) {
    const llmMap = new Map(llmResult.awsMappings.map((m) => [m.serviceId, m]));
    const mergedBaselineMappings: AwsServiceMapping[] = baseline.awsMappings.map((bm) => {
      const lm = llmMap.get(bm.serviceId);
      if (lm) {
        const isRecommendation = lm.category === "recommendation" || bm.category === "recommendation";
        const confidence = isRecommendation
          ? (lm.confidence === "high" ? "medium" : lm.confidence)
          : ("high" as const);
        const componentId = !isGenericComponentId(lm.componentId)
          ? lm.componentId
          : !isGenericComponentId(bm.componentId)
          ? bm.componentId
          : lm.componentId;
        const evidence = lm.evidence && bm.evidence && lm.evidence !== bm.evidence
          ? `${bm.evidence}; ${lm.evidence}`.slice(0, 200)
          : lm.evidence || bm.evidence;
        const category = lm.category && bm.category
          ? (CATEGORY_RANK[lm.category] >= CATEGORY_RANK[bm.category] ? lm.category : bm.category)
          : lm.category ?? bm.category;

        return {
          ...bm,
          componentId,
          confidence,
          evidence,
          category,
        };
      }
      return bm;
    });

    const baseServiceSet = new Set(baseline.awsMappings.map((m) => m.serviceId));
    const llmOnlyMappings = llmResult.awsMappings.filter((lm) => !baseServiceSet.has(lm.serviceId));
    combinedMappings = [...mergedBaselineMappings, ...llmOnlyMappings];
  } else {
    combinedMappings = [...baseline.awsMappings];
  }

  let finalMappings = deduplicateAwsMappings(combinedMappings);

  // 2. Merge and Deduplicate Components
  const candidateComponents = [
    ...(baseline.components || []),
    ...(llmResult?.components || []),
  ];

  const resolved = candidateComponents.map((c) => resolveServiceAndTier(c, finalMappings));
  const n = candidateComponents.length;

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] === i) return i;
    parent[i] = find(parent[i]);
    return parent[i];
  };
  const union = (i: number, j: number) => {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent[rootI] = rootJ;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const compA = candidateComponents[i];
      const compB = candidateComponents[j];
      const resA = resolved[i];
      const resB = resolved[j];

      const sameId = compA.id.toLowerCase() === compB.id.toLowerCase();
      const sameServiceAndTier = Boolean(
        resA.serviceId && resB.serviceId && resA.serviceId === resB.serviceId && resA.tier === resB.tier
      );
      const sameService = Boolean(
        resA.serviceId && resB.serviceId && resA.serviceId === resB.serviceId
      );

      if (sameId || sameServiceAndTier || sameService) {
        union(i, j);
      }
    }
  }

  const clusters = new Map<number, DiscoveredComponent[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = clusters.get(root) || [];
    list.push(candidateComponents[i]);
    clusters.set(root, list);
  }

  const idRedirectMap = new Map<string, string>();
  const finalComponents: DiscoveredComponent[] = [];

  for (const cluster of clusters.values()) {
    if (cluster.length === 0) continue;

    // Determine surviving ID: prefer specific ID over generic ones
    let survivingId = cluster[0].id;
    const nonGeneric = cluster.find((c) => !isGenericComponentId(c.id));
    if (nonGeneric) {
      survivingId = nonGeneric.id;
    }

    // Check if finalMappings maps any service in this cluster to a preferred componentId
    for (const c of cluster) {
      const direct = finalMappings.find((m) => m.componentId.toLowerCase() === c.id.toLowerCase());
      if (direct && !isGenericComponentId(direct.componentId)) {
        survivingId = direct.componentId;
        break;
      }
    }

    for (const c of cluster) {
      idRedirectMap.set(c.id, survivingId);
      idRedirectMap.set(c.id.toLowerCase(), survivingId);
    }

    // Determine highest confidence
    let highestConf: ConfidenceTier = "low";
    for (const c of cluster) {
      if (CONFIDENCE_RANK[c.confidence] > CONFIDENCE_RANK[highestConf]) {
        highestConf = c.confidence;
      }
    }

    // Determine winning status
    const winningStatus = cluster.some((c) => c.status === "detected") ? "detected" : "inferred";

    // Determine winning type: prefer type of highest confidence or non-generic role
    const bestComp =
      cluster.find((c) => c.confidence === highestConf && !["proxy", "external-service"].includes(c.type)) ||
      cluster.find((c) => c.confidence === highestConf) ||
      cluster[0];
    const winningType = bestComp.type;

    // Determine winning technology (Decision #10: retain distinct subtitle e.g. (Static Assets))
    let winningTech = bestComp.technology;
    const withSubtitle = cluster.find((c) => /\([^)]+\)/.test(c.technology));
    if (withSubtitle) {
      winningTech = withSubtitle.technology;
    } else {
      const customTech = cluster.find(
        (c) => !(SERVICE_IDS as readonly string[]).includes(c.technology as ServiceId) && c.technology.toLowerCase() !== "custom"
      );
      if (customTech) {
        winningTech = customTech.technology;
      }
    }

    // Combine unique evidence fragments
    const evSet = new Set<string>();
    for (const c of cluster) {
      for (const ev of c.evidence || []) {
        const trimmed = ev.trim();
        if (trimmed && !Array.from(evSet).some((x) => x.toLowerCase() === trimmed.toLowerCase())) {
          evSet.add(trimmed);
        }
      }
    }
    const evidence = Array.from(evSet).slice(0, 5);

    finalComponents.push({
      id: survivingId,
      type: winningType,
      technology: winningTech,
      confidence: highestConf,
      status: winningStatus,
      evidence,
    });
  }

  // Update finalMappings componentIds
  for (const m of finalMappings) {
    const redirected = idRedirectMap.get(m.componentId) ?? idRedirectMap.get(m.componentId.toLowerCase());
    if (redirected) {
      m.componentId = redirected;
    }
  }
  finalMappings = deduplicateAwsMappings(finalMappings);

  // 3. Disambiguate componentId collisions across different services in finalMappings
  // Diagram semantics requires each rendered node (and thus each mapping) to have a unique componentId.
  const mappingCompCount = new Map<string, number>();
  for (const m of finalMappings) {
    mappingCompCount.set(m.componentId, (mappingCompCount.get(m.componentId) ?? 0) + 1);
  }

  for (const [compId, count] of mappingCompCount.entries()) {
    if (count > 1) {
      const sharingMappings = finalMappings.filter((m) => m.componentId === compId);
      // Pick primary service to retain the base componentId
      // For frontend/web roles: CloudFront is primary entrypoint/CDN; S3 gets storage
      // For compute/backend roles: ECS/Lambda/EKS/EC2 is primary; ECR gets registry, ALB gets ingress
      // For scheduler roles: compute is primary; EventBridge gets scheduler
      let primaryServiceId: ServiceId | undefined;
      if (sharingMappings.some((m) => m.serviceId === "CloudFront")) {
        primaryServiceId = "CloudFront";
      } else if (sharingMappings.some((m) => ["ECS", "Lambda", "EKS", "EC2", "AppRunner"].includes(m.serviceId))) {
        primaryServiceId = sharingMappings.find((m) => ["ECS", "Lambda", "EKS", "EC2", "AppRunner"].includes(m.serviceId))!.serviceId;
      } else {
        primaryServiceId = sharingMappings[0].serviceId;
      }

      for (const m of sharingMappings) {
        if (m.serviceId === primaryServiceId) {
          continue;
        }
        let suffix = `-${m.serviceId.toLowerCase()}`;
        if (m.serviceId === "S3") suffix = "-storage";
        else if (m.serviceId === "ECR") suffix = "-registry";
        else if (m.serviceId === "ALB") suffix = "-alb";
        else if (m.serviceId === "APIGateway") suffix = "-gateway";
        else if (m.serviceId === "EventBridge") suffix = "-scheduler";

        const newId = `${compId}${suffix}`;
        m.componentId = newId;

        // Ensure this newId exists in finalComponents
        if (!finalComponents.some((c) => c.id === newId)) {
          finalComponents.push({
            id: newId,
            type: serviceTypeFromId(m.serviceId),
            technology: m.serviceId,
            evidence: m.evidence ? [m.evidence] : [],
            confidence: m.confidence,
            status: m.confidence === "high" ? "detected" : "inferred",
          });
        }
      }
    }
  }

  // Ensure every mapping has a corresponding component in finalComponents
  for (const m of finalMappings) {
    if (!finalComponents.some((c) => c.id === m.componentId)) {
      finalComponents.push({
        id: m.componentId,
        type: serviceTypeFromId(m.serviceId),
        technology: m.serviceId,
        evidence: m.evidence ? [m.evidence] : [],
        confidence: m.confidence,
        status: m.confidence === "high" ? "detected" : "inferred",
      });
    }
  }

  // Update relationships
  const allRelationships = [
    ...(baseline.relationships || []),
    ...(llmResult?.relationships || []),
  ];
  const finalRelationships: ComponentRelationship[] = [];
  const seenRelKeys = new Set<string>();

  for (const r of allRelationships) {
    const from = idRedirectMap.get(r.from) ?? idRedirectMap.get(r.from.toLowerCase()) ?? r.from;
    const to = idRedirectMap.get(r.to) ?? idRedirectMap.get(r.to.toLowerCase()) ?? r.to;
    if (from === to) continue;
    const key = `${from}->${to}:${r.type ?? ""}`;
    if (!seenRelKeys.has(key)) {
      seenRelKeys.add(key);
      finalRelationships.push({
        ...r,
        from,
        to,
      });
    }
  }

  // Add auxiliary component links
  for (const c of finalComponents) {
    const storageComp = `${c.id}-storage`;
    if (finalComponents.some((x) => x.id === storageComp)) {
      const k = `${c.id}->${storageComp}:reads/writes`;
      if (!seenRelKeys.has(k)) {
        seenRelKeys.add(k);
        finalRelationships.push({ from: c.id, to: storageComp, type: "reads/writes" });
      }
    }
    const registryComp = `${c.id}-registry`;
    if (finalComponents.some((x) => x.id === registryComp)) {
      const k = `${c.id}->${registryComp}:reads/writes`;
      if (!seenRelKeys.has(k)) {
        seenRelKeys.add(k);
        finalRelationships.push({ from: c.id, to: registryComp, type: "reads/writes" });
      }
    }
    const albComp = `${c.id}-alb`;
    if (finalComponents.some((x) => x.id === albComp)) {
      const k = `${albComp}->${c.id}:calls`;
      if (!seenRelKeys.has(k)) {
        seenRelKeys.add(k);
        finalRelationships.push({ from: albComp, to: c.id, type: "calls" });
      }
    }
  }

  // Update deploymentModel
  const allDeployments = [
    ...(baseline.deploymentModel || []),
    ...(llmResult?.deploymentModel || []),
  ];
  const finalDeployments: DeploymentModel[] = [];
  const seenDepIds = new Set<string>();

  for (const d of allDeployments) {
    const compId = idRedirectMap.get(d.componentId) ?? idRedirectMap.get(d.componentId.toLowerCase()) ?? d.componentId;
    if (!seenDepIds.has(compId)) {
      seenDepIds.add(compId);
      finalDeployments.push({
        ...d,
        componentId: compId,
      });
    }
  }

  // Ensure every component in finalComponents has a deploymentModel entry
  for (const c of finalComponents) {
    if (!seenDepIds.has(c.id)) {
      seenDepIds.add(c.id);
      finalDeployments.push({
        componentId: c.id,
        public: c.type === "frontend" || c.type === "api",
        needsVpc: !["frontend", "object-storage"].includes(c.type),
        needsMultiAz: ["database", "cache"].includes(c.type),
        needsAutoscaling: ["backend", "worker"].includes(c.type),
        source: "recommended",
      });
    }
  }

  const mergedPlan: ServicePlan = {
    ...baseline,
    components: finalComponents,
    awsMappings: finalMappings,
    relationships: finalRelationships,
    deploymentModel: finalDeployments,
    detectedPattern: llmResult?.detectedPattern || baseline.detectedPattern,
    metadata: {
      ...baseline.metadata,
      grounding: effectiveGrounding,
    },
    warnings: [...(baseline.warnings || []), ...(llmResult?.warnings || [])],
  };

  const cappedPlan = applyGroundingCap(mergedPlan, effectiveGrounding);
  const parsed = ServicePlanSchema.safeParse(cappedPlan);
  return parsed.success ? parsed.data : cappedPlan;
}

/**
 * Merges 1..N ServicePlan proposals with optional LLM proposals.
 * Accepts either a single ServicePlan or an array of ServicePlans.
 * Single-element arrays produce byte-identical output to single-path calls.
 */
export function mergeServicePlans(
  plans: ServicePlan[],
  llmResult?: ServicePlan | ServicePlan[] | null,
  grounding?: Grounding
): ServicePlan[];
export function mergeServicePlans(
  plan: ServicePlan,
  llmResult?: ServicePlan | null,
  grounding?: Grounding
): ServicePlan;
export function mergeServicePlans(
  planOrPlans: ServicePlan | ServicePlan[],
  llmResult?: ServicePlan | ServicePlan[] | null,
  grounding?: Grounding
): ServicePlan | ServicePlan[];
export function mergeServicePlans(
  planOrPlans: ServicePlan | ServicePlan[],
  llmResult?: ServicePlan | ServicePlan[] | null,
  grounding?: Grounding
): ServicePlan | ServicePlan[] {
  if (Array.isArray(planOrPlans)) {
    return planOrPlans.map((p, idx) => {
      const matchingLlm = Array.isArray(llmResult) ? llmResult[idx] ?? null : llmResult ?? null;
      return mergeSingleServicePlan(p, matchingLlm, grounding);
    });
  }
  const matchingLlm = Array.isArray(llmResult) ? llmResult[0] ?? null : llmResult ?? null;
  return mergeSingleServicePlan(planOrPlans, matchingLlm, grounding);
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface InferenceInput {
  ruleInput: RuleInput;
  signals: RepoSignals | null;
  description: string;
  profile?: ProjectProfile | null;
}

export interface InferenceResult {
  plan: ServicePlan;
  plans: ServicePlan[];
  architectureModel: ArchitectureModel | null;
}

/**
 * Runs the full inference pipeline:
 *   1. LLM builds the ArchitectureModel (if configured).
 *   2. The model is validated and deterministically mapped to a ServicePlan.
 *   3. No LLM (or LLM failure) → deterministic rules baseline.
 *
 * Always returns a valid ServicePlan — never throws.
 */
export async function runInference(input: InferenceInput): Promise<InferenceResult> {
  const { ruleInput, signals, description, profile } = input;

  // Fallback: deterministic rule engine (no LLM configured, or LLM failed).
  const baseline = () => runRuleEngine({ ...ruleInput, profile: profile ?? undefined });

  // Central reasoning path requires an LLM provider.
  if (!llmConfigured()) {
    const basePlan = baseline();
    const plans = basePlan.proposals && basePlan.proposals.length > 0 ? basePlan.proposals : [basePlan];
    return { plan: basePlan, plans, architectureModel: null };
  }

  // 1. LLM builds the architecture model of the whole repo/system.
  const model = await analyzeArchitecture({
    signals,
    description,
    inputKind: ruleInput.inputKind,
    grounding: ruleInput.grounding,
    profile: profile ?? null,
  });

  // 2. analyzeArchitecture already validated + normalized the model; on
  //    failure (null) fall back to rules.
  if (!model) {
    const basePlan = baseline();
    const plans = basePlan.proposals && basePlan.proposals.length > 0 ? basePlan.proposals : [basePlan];
    return { plan: basePlan, plans, architectureModel: null };
  }

  // 3. Deterministic AWS service mapping from the model — the ONLY inference path.
  const primaryPlan = mapArchitectureModelToServicePlan(model, {
    inputKind: ruleInput.inputKind,
    grounding: ruleInput.grounding,
    truncated: ruleInput.truncated,
    parseErrors: ruleInput.parseErrors,
    workloadClassification: profile?.workloadClassification,
    evidenceRegister: profile?.evidenceRegister,
  });

  const cappedPlan = applyGroundingCap(primaryPlan, ruleInput.grounding);
  const alternatePlan = buildAlternateProposal(cappedPlan, ruleInput);
  const p1 = { ...cappedPlan };
  delete p1.proposals;
  const p2 = alternatePlan ? applyGroundingCap({ ...alternatePlan }, ruleInput.grounding) : null;
  if (p2) delete p2.proposals;
  const plans = p2 ? [p1, p2] : [p1];
  cappedPlan.proposals = plans;

  return {
    plan: cappedPlan,
    plans,
    architectureModel: model,
  };
}