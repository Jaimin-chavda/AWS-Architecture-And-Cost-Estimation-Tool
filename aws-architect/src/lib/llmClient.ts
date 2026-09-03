/**
 * llmClient.ts  —  LLM provider factory + structured repository understanding
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

import {
  ArchitectureModelSchema,
  validateArchitectureModel,
} from "./architecture.ts";
import { COMPONENT_TYPES } from "./schema.ts";
import type { ArchitectureModel } from "./architecture.ts";
import type { Grounding } from "./schema.ts";
import type { RepoSignals } from "./repoFetcher.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

interface ProviderConfig {
  name: string;
  model: string;
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
      model: "gemini-3.5-flash",
      getModel: () => client("gemini-3.5-flash") as never,
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
  return `You are a Senior Principal AWS Cloud Architect. You are given structured evidence extracted from a software repository or project description. Build a model of the system that ACTUALLY EXISTS in that evidence — nothing more.

THE EVIDENCE RULE (non-negotiable):
Every component you output MUST cite at least one concrete piece of the evidence
below in its "evidence" array. A citation is a specific file path, dependency
entry, config key, README sentence, or phrase from the user's description — for
example "package.json → express", "docker-compose.yml → service: redis",
"serverless.yml → functions.processOrder", "README: 'stores uploads in S3'".
"Typical for this kind of app", "best practice", "production systems need this",
and "implied by the stack" are NOT evidence. If you cannot cite something
specific, DO NOT emit the component. A component with an empty evidence array
will be discarded, so emitting one only loses you information.

MINIMAL ARCHITECTURES ARE CORRECT ARCHITECTURES:
There is no required number of components and no required set of layers. Most of
the seven classic tiers (edge, ingress, compute, data, messaging, observability,
external) will be ABSENT from any given project, and that is the right answer.
A repository of static HTML, CSS and JavaScript with no server code is a frontend
component and NOTHING ELSE — no Lambda, no API Gateway, no DynamoDB, no Secrets
Manager, no queue, no auth. A single script with no database is one component.
Do not add a database because "apps have databases", an auth component because
"apps have logins", or a queue because "apps do background work". Emit ONLY the
tiers the evidence proves. One component is a perfectly valid answer.

Report what you find, not what a mature system would eventually grow into. Do not
compensate for a small repository by inventing scale.

Output schema requirements:
- appType: primary pattern (static-site, serverless-api, containerised-app, event-driven, ml-pipeline, full-stack-web, data-pipeline, generic). Pick the one the evidence supports — "static-site" and "generic" are ordinary answers, not failures.
- appName: clean project / system name taken from the repo or description.
- description: 1-2 sentence overview of the application as it actually is.
- components: the system components the evidence proves, drawn from frontend, backend, api, worker, database, cache, queue, object-storage, auth, proxy, external-service, messaging. Each has { id, name, type, technology, details, evidence, confidence }.
  - evidence: array of specific citations, as defined by THE EVIDENCE RULE. Never empty.
  - confidence: "high" when the evidence is a direct declaration (a dependency, a compose service, an IaC resource); "medium" when inferred from strong indirect signals such as an import or a README statement; "low" when the signal is weak. Do not report "high" for a guess — prefer omitting the component entirely.
- relationships: runtime connections you can actually justify between components you emitted: { from: <component id>, to: <component id>, type: "calls" | "reads" | "writes" | "triggers" | "sends" | "receives" | "subscribes" }. Both ids must refer to emitted components. If the project has one component, relationships is an empty array.

You are NOT choosing AWS services. Name the real technologies the project uses
("PostgreSQL", "Express", "React", "Redis"); AWS service selection happens later,
deterministically, from your model.`;
}

/**
 * Builds the evidence prompt for the architecture-model call.
 * Contains ONLY:
 *   1. The structured summary string from repoAnalyzer (profile text).
 *   2. The repository file-path structure (paths, never raw contents).
 *   3. A README excerpt.
 *   4. The sdkEvidence[] array.
 *   5. Discovered components from repoAnalyzer (CRITICAL - each is separate deployable unit).
 *   6. The user's input description (if present).
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
    parts.push(
      "Build the architecture model of this repository from the evidence below. " +
      "The evidence below is the ONLY thing you may model. Cite a specific line of " +
      "it in the 'evidence' array of every component you emit; emit no component " +
      "you cannot cite. If the repository turns out to be a single tier — a static " +
      "site, one script, one service with no database — say exactly that and stop. " +
      "Absent tiers are the expected result, not a gap for you to fill."
    );

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
      parts.push(`\nREADME:\n${readme}`);
    }

    // 4. sdkEvidence array
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

    // 5. Discovered components — CRITICAL: each is a distinct deployable unit
    if (profile.discoveredComponents.length > 0) {
      parts.push(
        "\nDISCOVERED DEPLOYABLE COMPONENTS (extracted from IaC and source code):" +
        "\nEach entry below is a SEPARATE running process or data tier, already " +
        "backed by the evidence shown on its line. Model each one as its own " +
        "component — do NOT merge or collapse them — and carry that evidence " +
        "through into the component's 'evidence' array. This list is a floor, " +
        "not a template: do not invent sibling tiers to 'complete' it.\n"
      );
      for (const dc of profile.discoveredComponents) {
        const evidenceLine = dc.evidence.join("; ");
        parts.push(
          `  [${dc.type.toUpperCase()}] id="${dc.id}" name="${dc.name}" ` +
          `technology="${dc.technology}" confidence=${dc.confidence}` +
          (evidenceLine ? ` evidence="${evidenceLine}"` : "")
        );
      }
    }

    // 6. User description (if present)
    if (description) {
      parts.push(`\nADDITIONAL USER CONTEXT:\n${description}`);
    }
  } else {
    // Description path — no profile available
    parts.push(
      "Analyze the following project description and model the system it describes." +
      "\nThe description is your only evidence. Decompose it into the components it" +
      "\nactually states or unambiguously implies, and cite the phrase you took each" +
      "\none from in that component's 'evidence' array (e.g. evidence:" +
      "\n[\"description: 'stores votes in MongoDB'\"])." +
      "\n\nComponent types available: frontend, backend, api, worker, scheduler," +
      "\ndatabase, cache, queue, object-storage, auth, proxy, messaging," +
      "\nexternal-service." +
      "\n\nEmit a tier ONLY where the description supports it. A description that" +
      "\nmentions no database gets no database; one that mentions no background" +
      "\nprocessing gets no worker and no queue; one that mentions no login gets no" +
      "\nauth component. Do not pad a short description into a multi-tier system —" +
      "\nif it describes one thing, return one component. Every component needs a" +
      "\nunique id, and relationships may only reference ids you emitted."
    );
    if (description) {
      parts.push(`\nProject description: ${description}`);
    }
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Main call
// ---------------------------------------------------------------------------

export async function analyzeArchitecture(opts: {
  signals: RepoSignals | null;
  description: string;
  inputKind: "github_url" | "description";
  grounding: Grounding;
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
    console.warn("[llmClient] Architecture model call failed:", (err as Error).message ?? String(err));
    return null;
  }
}