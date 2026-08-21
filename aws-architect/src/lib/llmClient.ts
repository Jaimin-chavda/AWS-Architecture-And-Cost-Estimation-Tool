/**
 * llmClient.ts  —  LLM provider factory + structured repository understanding
 *
 * Decision 18: Primary = DeepSeek deepseek-v4-flash; Gemini Flash / Groq fallbacks.
 * Decision 16: generateObject + zod schema = provider-agnostic structured extraction.
 * Decision 21: temperature 0, ≤3 retries.
 * Decision 5:  Any error → return null (caller falls back to rules baseline).
 *
 * The LLM's ONLY job is to build the ArchitectureModel — a structured
 * understanding of the whole repository as a system (components, technologies,
 * databases, APIs, external services, build config, runtime relationships).
 * It does NOT choose AWS services. AWS service selection happens later,
 * deterministically, in architecture.ts::mapArchitectureModelToServicePlan().
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

import { PATTERN_IDS } from "./schema.ts";
import type { Grounding } from "./schema.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";
import {
  ArchitectureModelSchema,
  COMPONENT_TYPES,
  validateArchitectureModel,
} from "./architecture.ts";
import type { ArchitectureModel } from "./architecture.ts";

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
// Prompt builders
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a software architecture analyst. You are given structured evidence extracted from a software repository (or a project description). Build a SINGLE structured model of the ENTIRE application as a system — how its parts fit and interact — not a list of isolated files.

The application model must capture:
- appType: the deployment pattern that best fits the whole app. Valid values: ${PATTERN_IDS.join(", ")}.
- appName: short repo/project name.
- description: 1-2 sentence summary of what the application does.
- components: the application's meaningful parts. Each component has: id (short unique slug, e.g. "web", "api", "db", "worker"), name, type, technology (the ACTUAL tech: e.g. "Next.js", "Express", "PostgreSQL", "Redis"), and optional details. Component types: ${COMPONENT_TYPES.join(", ")}.
- languages, frameworks, databases, apis (endpoints / third-party APIs used), externalServices (non-AWS SaaS such as Stripe, Auth0, Twilio, SendGrid), dependencies, and buildConfig (Docker, CI/CD, serverless.yml, terraform, etc.).
- relationships: runtime connections between components: { from: <component id>, to: <component id>, type: "calls" | "reads" | "writes" | "triggers" | "subscribes" | "sends" | "receives" }.

Rules:
- The model describes the APPLICATION, NOT AWS. Never name AWS services inside components or technologies (use "PostgreSQL", never "RDS"; use the actual library or "object storage", never "S3").
- Every component and relationship must be grounded in the evidence provided. Do NOT invent parts that the evidence does not support.
- External SaaS (hosted by a third party, not self-hosted) belong in externalServices; only add an "external_service" component if the app talks to it at runtime.
- Record a relationship for every real interaction you can justify (frontend → API, API → database, worker → queue, compute → storage).`;
}

/**
 * Builds the evidence prompt for the architecture-model call (Fix 7).
 * Contains ONLY:
 *   1. The structured summary string from repoAnalyzer (profile text).
 *   2. The repository file-path structure (paths, never raw contents).
 *   3. A README excerpt.
 *   4. The sdkEvidence[] array from Fix 3.
 *   5. The user's input description (if present).
 * Explicitly excludes raw file dumps to prevent token overflow and hallucinations.
 */
export function buildArchitecturePrompt(
  profile: ProjectProfile | null,
  signals: RepoSignals | null,
  description: string,
  grounding: Grounding
): string {
  const parts: string[] = [];

  if (profile && (grounding === "repo" || grounding === "repoFiles" || grounding === "filenameOnly")) {
    // 1. Structured analysis summary from repoAnalyzer
    parts.push(profile.summary);

    // 2. Repository structure — file paths only
    if (signals && signals.keyFiles.length > 0) {
      parts.push("\nREPOSITORY STRUCTURE (file paths):");
      for (const f of signals.keyFiles) {
        parts.push(`  - ${f.path}`);
      }
    }

    // 3. README excerpt
    const readme = signals?.keyFiles.find((f) => f.kind === "readme")?.content;
    if (readme) {
      parts.push(`\nREADME EXCERPT:\n${readme.slice(0, 1500)}`);
    }

    // 4. sdkEvidence array (Fix 3)
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

    // 5. User description (if present)
    if (description) {
      parts.push(`\nADDITIONAL USER CONTEXT:\n${description}`);
    }
  } else {
    // Description path — no profile available
    parts.push(
      "Analyze the following project description and build the architecture model of the described application as a system."
    );
    if (description) {
      parts.push(`\nProject description: ${description}`);
    }
  }

  return parts.join("\n\n").slice(0, 20_000);
}

// ---------------------------------------------------------------------------
// Main call
// ---------------------------------------------------------------------------

/**
 * Calls the configured LLM provider to produce an ArchitectureModel.
 * Returns a validated, normalized model or null on any failure
 * (caller falls back to the rules baseline).
 *
 * Decision 5 / 16: gate = ArchitectureModelSchema.safeParse; failure → null.
 * Decision 21: temperature 0, maxRetries 3.
 */
export async function analyzeArchitecture(opts: {
  signals: RepoSignals | null;
  description: string;
  inputKind: "github_url" | "description";
  grounding: Grounding;
  /** Structured project profile from repoAnalyzer — used to build a pre-analyzed prompt */
  profile?: ProjectProfile | null;
}): Promise<ArchitectureModel | null> {
  const provider = resolveProvider();
  if (!provider) return null;

  const prompt = buildArchitecturePrompt(
    opts.profile ?? null,
    opts.signals,
    opts.description,
    opts.grounding
  );

  try {
    const { object: raw } = await generateObject({
      model: provider.getModel() as Parameters<typeof generateObject>[0]["model"],
      schema: ArchitectureModelSchema,
      system: buildSystemPrompt(),
      prompt,
      temperature: 0,
      maxRetries: 3,
    });

    return validateArchitectureModel(raw);
  } catch (err) {
    // Any network error, provider error, timeout, malformed response → null
    console.warn("[llmClient] Architecture model call failed:", (err as Error).message ?? String(err));
    return null;
  }
}