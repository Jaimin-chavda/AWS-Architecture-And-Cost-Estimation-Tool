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
import type { ServicePlan, Grounding } from "./schema.ts";
import type { RepoSignals } from "./repoFetcher.ts";

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
  return `You are an AWS architecture analyst. Given evidence about a software project,
determine which AWS services are needed to deploy it and classify the architecture pattern.

Valid serviceIds (use ONLY these exact strings):
${SERVICE_IDS.join(", ")}

Valid patterns:
${PATTERN_IDS.join(", ")}

Rules:
- Only include services that have clear evidence from the project files.
- Use slot names that match the pattern (e.g. "compute", "database", "storage", "api", "queue", "cdn", "monitoring").
- Confidence "high" = explicit SDK/service reference; "medium" = likely needed; "low" = inferred.
- Evidence field: one short sentence explaining why this service was chosen.
- Maximum 12 distinct services total.
- Never include services not in the valid serviceIds list.`;
}

function buildUserPrompt(
  evidence: string,
  inputKind: "github_url" | "description",
  grounding: Grounding
): string {
  const context =
    grounding === "repo"
      ? "Analyze the following repository files and infer the AWS architecture."
      : "Analyze the following project description and infer the AWS architecture needed.";

  return `${context}\n\n${evidence}`;
}

function buildEvidence(
  signals: RepoSignals | null,
  description: string
): string {
  if (!signals || signals.keyFiles.length === 0) {
    return description || "(no evidence provided)";
  }
  const parts: string[] = [];
  if (description) parts.push(`Project description: ${description}`);
  for (const f of signals.keyFiles) {
    if (f.content) {
      parts.push(`=== ${f.path} ===\n${f.content.slice(0, 3000)}`);
    } else {
      parts.push(`=== ${f.path} === (file present, content unavailable)`);
    }
  }
  return parts.join("\n\n").slice(0, 16_000); // total evidence cap for LLM context
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
}): Promise<ServicePlan | null> {
  const provider = resolveProvider();
  if (!provider) return null;

  const evidence = buildEvidence(opts.signals, opts.description);
  const userPrompt = buildUserPrompt(evidence, opts.inputKind, opts.grounding);

  try {
    const { object: raw } = await generateObject({
      model: provider.getModel() as Parameters<typeof generateObject>[0]["model"],
      schema: LlmOutputSchema,
      system: buildSystemPrompt(),
      prompt: userPrompt,
      temperature: 0,
      maxRetries: 3,
    });

    // Build the full shape including inputKind + metadata for the gate
    const candidate = {
      inputKind: opts.inputKind,
      pattern: raw.pattern,
      slots: raw.slots,
      customEdges: raw.customEdges,
      metadata: {
        grounding: opts.grounding,
        truncated: opts.signals?.truncated ?? false,
        parseErrors: opts.signals?.parseErrors ?? [],
      },
    };

    // Gate: run the full schema including catalog allowlist + 12-service cap refines
    const gateResult = ServicePlanSchema.safeParse(candidate);
    if (!gateResult.success) {
      console.warn(
        "[llmClient] LLM output failed schema gate:",
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
