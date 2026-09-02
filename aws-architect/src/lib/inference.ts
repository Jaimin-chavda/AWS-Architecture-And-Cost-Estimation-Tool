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

import { runRuleEngine } from "./ruleEngine.ts";
import { analyzeArchitecture, llmConfigured } from "./llmClient.ts";
import { mapArchitectureModelToServicePlan } from "./architecture.ts";
import type { ArchitectureModel } from "./architecture.ts";
import type {
  ServicePlan,
  Grounding,
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