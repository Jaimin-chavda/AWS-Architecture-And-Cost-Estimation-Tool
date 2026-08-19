/**
 * inference.ts  —  FLOW.md Stage 3: Inference orchestration
 *
 * Runs rules baseline + optional LLM, then merges results.
 * This is the single entry point the route calls.
 *
 * Decision 3:  Rules-first — baseline never fails.
 * Decision 5:  LLM failure → baseline silently (no error page).
 * Decision 16: merge(baseline, validate(llm)) — provider-agnostic gate already in llmClient.
 * Decision 19: description-grounded → cap all confidence to "low" after merge.
 * Decision 21: retries capped at 3 inside llmClient.
 */

import { runRuleEngine } from "./ruleEngine.ts";
import { callLlm, llmConfigured } from "./llmClient.ts";
import { ServicePlanSchema, SERVICE_CATEGORIES } from "./schema.ts";
import type {
  ServicePlan,
  ServiceSlot,
  ServiceId,
  ConfidenceTier,
  Grounding,
  PatternId,
} from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Merge algorithm
//
// Confidence after merge:
//   serviceId in BOTH baseline + LLM → "high"   (consensus)
//   serviceId in LLM only             → min(llm.confidence, "medium")
//   serviceId in baseline only        → "low"    (unconfirmed)
//
// Pattern: prefer LLM's pattern (it has fuller context via formatted evidence).
// Slot names: prefer LLM's slot names; baseline services missing from LLM use
//   their existing slot names with "low" confidence.
// 12-service cap applied after merge, priority: high > medium > low.
// Description-grounded → cap all to "low" (Decision 19).
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: ConfidenceTier[] = ["high", "medium", "low"];

function capConfidence(c: ConfidenceTier, max: ConfidenceTier): ConfidenceTier {
  const ci = CONFIDENCE_ORDER.indexOf(c);
  const mi = CONFIDENCE_ORDER.indexOf(max);
  // Lower index = higher confidence ("high"=0, "medium"=1, "low"=2).
  // If current is already worse-or-equal to max (ci >= mi), keep it.
  // If current is better than max (ci < mi), clamp to max.
  return ci >= mi ? c : max;
}

/**
 * Merges the rule-engine baseline with a (validated) LLM ServicePlan.
 * If llmResult is null, returns the baseline unchanged.
 */
export function mergeServicePlans(
  baseline: ServicePlan,
  llmResult: ServicePlan | null,
  grounding: Grounding
): ServicePlan {
  if (!llmResult) return applyGroundingCap(baseline, grounding);

  // Build lookup maps: serviceId → {slotName, slot} for each plan
  const baseMap = new Map<string, { slotName: string; slot: ServiceSlot }>();
  for (const [slotName, slot] of Object.entries(baseline.slots)) {
    baseMap.set(slot.serviceId, { slotName, slot });
  }

  const llmMap = new Map<string, { slotName: string; slot: ServiceSlot }>();
  for (const [slotName, slot] of Object.entries(llmResult.slots)) {
    llmMap.set(slot.serviceId, { slotName, slot });
  }

  // ── Fix 1: Category-gap detection ──────────────────────────────────────
  // Identify which architecture categories the LLM already covers.
  // Only fill gaps from baseline for categories the LLM missed entirely.
  const llmCategories = new Set<string>();
  for (const id of llmMap.keys()) {
    const cat = SERVICE_CATEGORIES[id as ServiceId];
    if (cat) llmCategories.add(cat);
  }

  // All unique service IDs across both plans
  const allIds = new Set([...baseMap.keys(), ...llmMap.keys()]);

  type MergedEntry = {
    slotName: string;
    serviceId: string;
    confidence: ConfidenceTier;
    evidence: string;
    sortPriority: number; // 0 = high, 1 = medium, 2 = low
  };

  const merged: MergedEntry[] = [];
  for (const id of allIds) {
    const inBase = baseMap.get(id);
    const inLlm = llmMap.get(id);

    let confidence: ConfidenceTier;
    let evidence: string;
    let slotName: string;

    if (inBase && inLlm) {
      // Both agree → high confidence
      confidence = "high";
      evidence = inLlm.slot.evidence; // LLM evidence is usually more specific
      slotName = inLlm.slotName;
    } else if (inLlm) {
      // LLM only → cap at medium
      confidence = capConfidence(inLlm.slot.confidence, "medium");
      evidence = inLlm.slot.evidence;
      slotName = inLlm.slotName;
    } else {
      // Baseline only → include only if LLM missed this service's category
      const baseCat = SERVICE_CATEGORIES[id as ServiceId];
      if (baseCat && llmCategories.has(baseCat)) {
        // LLM already covered this category — skip baseline-only service
        continue;
      }
      confidence = "low";
      evidence = inBase!.slot.evidence + " (rule-only, gap-fill for missing category)";
      slotName = inBase!.slotName;
    }

    merged.push({
      slotName,
      serviceId: id,
      confidence,
      evidence,
      sortPriority: CONFIDENCE_ORDER.indexOf(confidence),
    });
  }

  // Sort by confidence (high first), then apply 12-service cap
  merged.sort((a, b) => a.sortPriority - b.sortPriority);
  const capped = merged.slice(0, 12);

  // Resolve slot name collisions (two services can't share the same slot name)
  const usedSlots = new Set<string>();
  let overflowIdx = 1;
  const slots: Record<string, ServiceSlot> = {};
  for (const entry of capped) {
    let slotName = entry.slotName;
    if (usedSlots.has(slotName)) {
      slotName = `additional_${overflowIdx++}`;
    }
    usedSlots.add(slotName);
    slots[slotName] = {
      serviceId: entry.serviceId,
      confidence: entry.confidence,
      evidence: entry.evidence,
    };
  }

  const plan: ServicePlan = {
    inputKind: baseline.inputKind,
    // Prefer LLM pattern when the LLM had real evidence; baseline otherwise
    pattern: llmResult.pattern as PatternId,
    slots,
    customEdges: llmResult.customEdges.length > 0 ? llmResult.customEdges : baseline.customEdges,
    metadata: {
      grounding: baseline.metadata.grounding,
      truncated: baseline.metadata.truncated,
      parseErrors: baseline.metadata.parseErrors,
    },
  };

  // Validate merged plan (should always pass, but defense-in-depth)
  const check = ServicePlanSchema.safeParse(plan);
  if (!check.success) {
    // Fallback: return baseline with grounding cap
    console.warn("[inference] Merged plan failed schema validation — using baseline");
    return applyGroundingCap(baseline, grounding);
  }

  return applyGroundingCap(check.data, grounding);
}

/**
 * Derives grounding directly and only from evidence actually consumed (Fix 2).
 */
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

/** Caps all slot confidence to "low" for non-code grounded results (Decision 19 / Fix 2). */
export function applyGroundingCap(plan: ServicePlan, grounding: Grounding): ServicePlan {
  if (grounding === "repo" || grounding === "repoFiles") return plan;

  const cappedSlots: Record<string, ServiceSlot> = {};
  for (const [name, slot] of Object.entries(plan.slots)) {
    cappedSlots[name] = { ...slot, confidence: "low" };
  }
  return { ...plan, slots: cappedSlots };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface InferenceInput {
  ruleInput: RuleInput;
  /** Populated when input_kind is github_url and RepoFetcher succeeded */
  signals: RepoSignals | null;
  /** Freeform description text (used on description path, or for LLM context on repo path) */
  description: string;
  /**
   * Structured project profile from repoAnalyzer (github_url path only).
   * Forwarded to both the rule engine (for typed scoring) and the LLM (for
   * the pre-analyzed technology summary prompt).
   */
  profile?: ProjectProfile | null;
}

/**
 * Runs the full inference pipeline:
 *   1. Rule engine baseline (always)
 *   2. LLM (if configured, silently skipped otherwise)
 *   3. Merge
 *
 * Always returns a valid ServicePlan — never throws.
 */
export async function runInference(input: InferenceInput): Promise<ServicePlan> {
  // Step 1: Rule engine baseline (synchronous, never fails)
  // Pass the profile so scoring uses typed fields + file-specific evidence strings
  const baseline = runRuleEngine({
    ...input.ruleInput,
    profile: input.profile ?? undefined,
  });

  // Step 2: LLM (async, can fail silently)
  let llmResult: ServicePlan | null = null;
  if (llmConfigured()) {
    llmResult = await callLlm({
      signals: input.signals,
      description: input.description,
      inputKind: input.ruleInput.inputKind,
      grounding: input.ruleInput.grounding,
      profile: input.profile ?? null,
    });
  }

  // Step 3: Merge
  return mergeServicePlans(baseline, llmResult, input.ruleInput.grounding);
}
