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
      model: "gemini-3.6-flash",
      getModel: () => client("gemini-3.6-flash") as never,
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
  return `You are a Senior Principal AWS Cloud Architect. You are given structured evidence extracted from a software repository or project description. Build a comprehensive, production-ready architectural model of the ENTIRE system for AWS deployment — how all tiers, services, and runtime parts connect together.

A complete production architecture model must include all necessary layers:
1. Client & Edge: End Users / Clients, DNS (Route 53), CDN (CloudFront), and Frontend Hosting (S3).
2. Ingress & Security: Load Balancing (ALB), API Gateways, User Authentication / JWT (Cognito), and Secrets / Key Management (Secrets Manager).
3. Compute Services: Containerized backends (ECS Fargate / EC2), and Serverless Workers / Functions (Lambda) for background processing, smart contract calls, or scheduled jobs.
4. Data & Caching: Databases (DocumentDB for MongoDB, RDS/Aurora for SQL, DynamoDB for NoSQL), and in-memory caches (Redis / ElastiCache).
5. Asynchronous Messaging: Message Queues (SQS) for job/transaction queues, Notification Topics (SNS), and Event Routers (EventBridge).
6. Observability & IaC: Logging/Metrics (CloudWatch) and Infrastructure-as-Code (CloudFormation / CDK).
7. External Services: Third-party integrations (e.g. MetaMask, Ethereum / Sepolia Testnet, Stripe, Auth0, external APIs).

Output schema requirements:
- appType: primary pattern (e.g. full-stack-web, containerised-app, serverless-api, event-driven, ml-pipeline, data-pipeline).
- appName: clean project / system name (e.g. "Decentralized Voting System").
- description: 1-2 sentence overview of the application.
- components: array of ALL system components across frontend, backend, api, worker, database, cache, queue, object-storage, auth, proxy, external-service, messaging. Each component has { id, name, type, technology, details, evidence, confidence: "high" | "medium" | "low" }.
- relationships: ALL runtime traffic connections between components: { from: <component id>, to: <component id>, type: "calls" | "reads" | "writes" | "triggers" | "sends" | "receives" | "subscribes" }.
  Ensure edges flow logically: Users → Route 53 / CloudFront → S3 (Frontend) & ALB / API Gateway → Backend (ECS / Lambda) → Database / Cache / Secrets / SQS → SNS / CloudWatch.

Do not limit the output to just 1 or 2 files. Provide the complete multi-tier architecture required for a realistic, enterprise-grade AWS deployment.`;
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
        "\nEach entry below is a SEPARATE running process or data tier. " +
        "You MUST model each one as its own component in the output — do NOT merge or collapse them.\n"
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
      "Analyze the following project description and build a comprehensive multi-tier architecture model of the system." +
      "\nYou MUST decompose the application into all distinct components mentioned or implied:" +
      "\n- Frontend UI (e.g. React, Next.js, Vue, mobile web)" +
      "\n- Backend Services / APIs (e.g. Express, FastAPI, Django, Spring)" +
      "\n- Workers / Smart Contract Integrations (e.g. Web3/Solidity contract calls, background tasks)" +
      "\n- Databases & Caches (e.g. MongoDB, PostgreSQL, DynamoDB, Redis)" +
      "\n- Queues & Async Messaging (e.g. SQS vote processing queues, SNS topics)" +
      "\n- Authentication & Secrets (e.g. JWT auth, API key secrets)" +
      "\n- External services / Wallets (e.g. MetaMask, Ethereum Sepolia, third-party APIs)\n" +
      "\nEvery single tier MUST be an item in the 'components' array with a unique id."
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