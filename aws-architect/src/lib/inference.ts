/**
 * inference.ts  —  FLOW.md Stage 3: Inference orchestration
 *
 * Central reasoning pipeline:
 *   RepoSignals/description → LLM → ArchitectureModel → validation
 *     → deterministic AWS service mapping → ServicePlan
 *
 * The LLM never picks AWS services directly. It builds a single structured
 * ArchitectureModel of the whole application; architecture.ts maps that model
 * to the ServicePlan. Downstream (diagram, cost) consume the ServicePlan.
 *
 * Decision 3:  Rules-first — baseline never fails.
 * Decision 5:  LLM failure → baseline silently (no error page).
 * Decision 19: description-grounded → cap all confidence to "low".
 * Decision 21: retries capped at 3 inside llmClient.
 */

import { runRuleEngine } from "./ruleEngine.ts";
import { analyzeArchitecture, llmConfigured } from "./llmClient.ts";
import { mapArchitectureModelToServicePlan } from "./architecture.ts";
import type { ArchitectureModel } from "./architecture.ts";
import type {
  ServicePlan,
  ServiceSlot,
  Grounding,
} from "./schema.ts";
import type { RuleInput } from "./ruleEngine.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Grounding derivation (Fix 2)
// ---------------------------------------------------------------------------

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
   * Forwarded to the LLM as the evidence base for building the architecture model.
   */
  profile?: ProjectProfile | null;
}

export interface InferenceResult {
  /** The ServicePlan consumed by diagram + cost (derived from the model, or rules baseline). */
  plan: ServicePlan;
  /**
   * The ArchitectureModel produced by the LLM (null when the LLM was not
   * configured or failed and the rules baseline was used).
   */
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
    return { plan: baseline(), architectureModel: null };
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
    return { plan: baseline(), architectureModel: null };
  }

  // 3. Deterministic AWS service mapping from the model — the ONLY inference path.
  const plan = mapArchitectureModelToServicePlan(model, {
    inputKind: ruleInput.inputKind,
    grounding: ruleInput.grounding,
    truncated: ruleInput.truncated,
    parseErrors: ruleInput.parseErrors,
  });

  return {
    plan: applyGroundingCap(plan, ruleInput.grounding),
    architectureModel: model,
  };
}