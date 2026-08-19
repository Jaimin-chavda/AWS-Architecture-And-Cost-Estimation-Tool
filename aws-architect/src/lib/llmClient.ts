/**
 * llmClient.ts  —  LLM provider factory + structured inference call
 *
 * Decision 18: Primary = DeepSeek deepseek-v4-flash; Gemini Flash / Groq fallbacks.
 * Decision 16: generateObject + zod schema = provider-agnostic structured extraction.
 * Decision 21: temperature 0, ≤3 retries.
 * Decision 5:  Any error → return null (caller falls back to rules baseline).
 * Decision 4:  LLM outputs ServicePlan only — never diagram XML or prices.
 *
 * Provider chain (first configured key wins):
 *   1. DEEPSEEK_API_KEY  → deepseek-v4-flash  (@ai-sdk/deepseek)
 *   2. GOOGLE_API_KEY    → gemini-2.5-flash   (@ai-sdk/google)
 *   3. GROQ_API_KEY      → llama-3.3-70b      (@ai-sdk/groq)
 */

import { generateObject } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { z } from "zod";

import {
  ServicePlanSchema,
  SERVICE_IDS,
  PATTERN_IDS,
  CONFIDENCE_TIERS,
  GROUNDING_VALUES,
} from "./schema.ts";
import type { ServicePlan, Grounding, ConfidenceTier } from "./schema.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// LLM output schema for generateObject
//
// Mirrors ServicePlanSchema shape WITHOUT the .refine() guards — those are our
// explicit gate (ServicePlanSchema.safeParse) run after the call. This avoids
// the LLM burning retries on catalog violations when the gate will catch them.
// ---------------------------------------------------------------------------
const LlmOutputSchema = z.object({
  pattern: z.enum(PATTERN_IDS),
  slots: z.record(
    z.string(),
    z.object({
      serviceId: z.string(),
      confidence: z.enum(CONFIDENCE_TIERS),
      evidence: z.string().max(200),
    })
  ),
  customEdges: z
    .array(z.object({ from: z.string(), to: z.string(), label: z.string().max(80).optional() }))
    .default([]),
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

interface ProviderConfig {
  name: string;
  model: string;
  // Returns the model reference accepted by generateObject
  getModel: () => ReturnType<typeof createDeepSeek> extends (...args: unknown[]) => infer R ? R : never;
}

function resolveProvider(): ProviderConfig | null {
  if (process.env.DEEPSEEK_API_KEY) {
    const client = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });
    return {
      name: "deepseek",
      model: "deepseek-v4-flash",
      getModel: () => client("deepseek-v4-flash") as never,
    };
  }
  if (process.env.GOOGLE_API_KEY) {
    const client = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
    return {
      name: "google",
      model: "gemini-2.5-flash",
      getModel: () => client("gemini-2.5-flash") as never,
    };
  }
  if (process.env.GROQ_API_KEY) {
    const client = createGroq({ apiKey: process.env.GROQ_API_KEY });
    return {
      name: "groq",
      model: "llama-3.3-70b-versatile",
      getModel: () => client("llama-3.3-70b-versatile") as never,
    };
  }
  return null;
}

/**
 * Returns true if at least one LLM provider API key is configured.
 * Decision 5: if no key, the caller skips LLM silently.
 */
export function llmConfigured(): boolean {
  return !!(
    process.env.DEEPSEEK_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GROQ_API_KEY
  );
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are an AWS architecture analyst. A project has already been analyzed and its technologies extracted.
Your ONLY job is to determine which AWS services are needed to deploy it, based on the detected technologies.

Valid serviceIds (use ONLY these exact strings):
${SERVICE_IDS.join(", ")}

Valid patterns:
${PATTERN_IDS.join(", ")}

Rules:
- Map each detected technology to the AWS service that would host/replace it in production.
- ONLY include services with a direct mapping to a detected technology listed in the analysis.
- Do NOT add services that have no evidence in the detected technologies.
- Use slot names that match the pattern (e.g. "compute", "database", "storage", "api", "queue", "cdn", "monitoring").
- Confidence "high" = explicit SDK/service reference or exact AWS service detected;
  "medium" = clearly needed given the tech stack; "low" = reasonable inference.
- Evidence field: cite the specific file and dependency that justifies this service.
- Maximum 12 distinct services total.
- Never include services not in the valid serviceIds list.`;
}

/**
 * Builds a structured prompt using the ProjectProfile as the primary context (Fix 7).
 * The LLM prompt contains ONLY:
 * 1. The structured summary string from repoAnalyzer (profile text).
 * 2. The sdkEvidence[] array from Fix 3.
 * 3. Pattern classification context.
 * 4. The user's input description (if present).
 * Explicitly excludes raw file dumps to prevent token overflow and hallucinations.
 */
export function buildStructuredPrompt(
  profile: ProjectProfile | null,
  signals: RepoSignals | null,
  description: string,
  grounding: Grounding
): string {
  const parts: string[] = [];

  if (profile && (grounding === "repo" || grounding === "repoFiles" || grounding === "filenameOnly")) {
    // 1. Structured analysis summary from repoAnalyzer
    parts.push(profile.summary);

    // 2. sdkEvidence array (Fix 3)
    if (signals?.sdkEvidence && signals.sdkEvidence.length > 0) {
      parts.push("\nEXTRACTED SDK / CODE SIGNALS:");
      for (const ev of signals.sdkEvidence) {
        const hint = ev.serviceHint ?? ev.service ?? "AWS";
        const path = ev.filePath ?? ev.file ?? "code";
        const line = ev.line !== undefined ? `:${ev.line}` : "";
        const match = ev.matchSnippet ?? ev.match ?? "";
        parts.push(`  - [${hint}] ${path}${line} — "${match}"`);
      }
    }

    // 3. User description (if present)
    if (description) {
      parts.push(`\nADDITIONAL USER CONTEXT:\n${description}`);
    }
  } else {
    // Description path — no profile available
    parts.push("Analyze the following project description and infer the AWS architecture needed.");
    if (description) {
      parts.push(`\nProject description: ${description}`);
    }
  }

  return parts.join("\n\n").slice(0, 20_000);
}

// ---------------------------------------------------------------------------
// Slot validation & filtering (Fix 1)
// ---------------------------------------------------------------------------

const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/**
 * Validates each slot independently against the service catalog allowlist,
 * drops invalid entries with warnings, and caps to top 12 by confidence.
 * Returns null if zero valid services remain.
 */
export function filterAndValidateLlmSlots(
  slots: Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }>
): Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }> | null {
  const allowlist = new Set<string>(SERVICE_IDS as readonly string[]);
  const validSlots: Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }> = {};

  const entries = Object.entries(slots).map(([slotName, slot], idx) => ({
    slotName,
    slot,
    originalIdx: idx,
  }));

  for (const { slotName, slot } of entries) {
    if (!allowlist.has(slot.serviceId)) {
      console.warn(
        `[llmClient] Dropped invalid service "${slot.serviceId}" from LLM result (slot: ${slotName}, reason: not in catalog allowlist)`
      );
      continue;
    }
    validSlots[slotName] = slot;
  }

  if (Object.keys(validSlots).length === 0) {
    console.warn("[llmClient] LLM returned zero valid services after filtering — falling back to rules");
    return null;
  }

  // If > 12 unique services, keep the 12 highest-confidence entries
  const uniqueServices = new Set(Object.values(validSlots).map((s) => s.serviceId));
  if (uniqueServices.size > 12) {
    const sorted = Object.entries(validSlots).sort(([, a], [, b]) => {
      const ca = CONFIDENCE_RANK[a.confidence] ?? 2;
      const cb = CONFIDENCE_RANK[b.confidence] ?? 2;
      return ca - cb;
    });
    const keptServices = new Set<string>();
    const keptSlots: Record<string, { serviceId: string; confidence: ConfidenceTier; evidence: string }> = {};
    for (const [slotName, slot] of sorted) {
      if (keptServices.size >= 12 && !keptServices.has(slot.serviceId)) continue;
      keptServices.add(slot.serviceId);
      keptSlots[slotName] = slot;
    }
    return keptSlots;
  }

  return validSlots;
}

// ---------------------------------------------------------------------------
// Main call
// ---------------------------------------------------------------------------

/**
 * Calls the configured LLM provider with the evidence, returning a validated
 * ServicePlan or null on any failure (caller uses rules baseline).
 *
 * Decision 5 / 16: gate = ServicePlanSchema.safeParse; failure → null.
 * Decision 21: temperature 0, maxRetries 3.
 */
export async function callLlm(opts: {
  signals: RepoSignals | null;
  description: string;
  inputKind: "github_url" | "description";
  grounding: Grounding;
  /** Structured project profile from repoAnalyzer — used to build a pre-analyzed prompt */
  profile?: ProjectProfile | null;
}): Promise<ServicePlan | null> {
  const provider = resolveProvider();
  if (!provider) return null;

  const userPrompt = buildStructuredPrompt(
    opts.profile ?? null,
    opts.signals,
    opts.description,
    opts.grounding
  );

  try {
    const { object: raw } = await generateObject({
      model: provider.getModel() as Parameters<typeof generateObject>[0]["model"],
      schema: LlmOutputSchema,
      system: buildSystemPrompt(),
      prompt: userPrompt,
      temperature: 0,
      maxRetries: 3,
    });

    // ── Per-entry validation (Fix 1) ─────────────────────────────────────
    const validSlots = filterAndValidateLlmSlots(raw.slots);
    if (!validSlots) {
      return null;
    }

    const candidate = {
      inputKind: opts.inputKind,
      pattern: raw.pattern,
      slots: validSlots,
      customEdges: raw.customEdges,
      metadata: {
        grounding: opts.grounding,
        truncated: opts.signals?.truncated ?? false,
        parseErrors: opts.signals?.parseErrors ?? [],
      },
    };

    // Final validation (should pass after per-entry filtering, but defense-in-depth)
    const gateResult = ServicePlanSchema.safeParse(candidate);
    if (!gateResult.success) {
      console.warn(
        "[llmClient] LLM output failed schema gate after per-entry filtering:",
        gateResult.error.issues.map((i) => i.message).join("; ")
      );
      return null;
    }

    return gateResult.data;
  } catch (err) {
    // Any network error, provider error, timeout, malformed response → null
    console.warn("[llmClient] LLM call failed:", (err as Error).message ?? String(err));
    return null;
  }
}
