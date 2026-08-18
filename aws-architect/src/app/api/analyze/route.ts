/**
 * /api/analyze — POST
 *
 * Stage 1: Input normalisation + validation (FLOW.md Stage 1).
 * Stage 2: Evidence extraction via RepoFetcher + insufficient-signal gate.
 * Stage 3: Inference — runInference (rules baseline + optional LLM merge).
 * Stage 4: Diagram XML generation via diagram.ts.
 * Stage 5: Cost estimation via cost.ts (default region us-east-1, 10k users).
 *
 * Decision 1:  Pipeline server-side only.
 * Decision 7:  SSRF protection — host allowlist (github.com), timeouts, length caps.
 * Decision 20: Insufficient-signal gate returns advisory payload, never a plan.
 * Decision 39: input_kind and grounding are separate fields; they may differ.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  fetchRepoSignals,
  isInsufficientSignal,
  signalsToRuleInput,
} from "@/lib/repoFetcher";
import { runInference } from "@/lib/inference";
import { generateDiagramXml } from "@/lib/diagram";
import { computeCostRows } from "@/lib/cost";
import type { RuleInput } from "@/lib/ruleEngine";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface AnalyzeRequestBody {
  input: {
    kind: "github_url" | "description";
    value: string;
  };
  /** Optional region override (default: us-east-1) */
  region?: string;
  /** Optional user count override (default: 10_000) */
  userCount?: number;
}

// ---------------------------------------------------------------------------
// Input validation constants (Decision 7)
// ---------------------------------------------------------------------------
const MAX_DESCRIPTION_LENGTH = 8_000; // chars
const MAX_URL_LENGTH = 2_000; // chars
const ALLOWED_GITHUB_HOSTS = ["github.com"]; // SSRF allowlist

const ALLOWED_REGIONS = new Set([
  "us-east-1", "us-east-2", "us-west-1", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-southeast-2", "ap-northeast-1",
  "ap-south-1", "sa-east-1", "ca-central-1",
]);

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      ALLOWED_GITHUB_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/analyze
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Parse body ───────────────────────────────────────────────────────────
  let body: AnalyzeRequestBody;
  try {
    body = (await req.json()) as AnalyzeRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate shape ───────────────────────────────────────────────────────
  if (
    !body?.input ||
    typeof body.input !== "object" ||
    !["github_url", "description"].includes(body.input.kind) ||
    typeof body.input.value !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          'Request body must be { input: { kind: "github_url" | "description", value: string } }',
      },
      { status: 400 }
    );
  }

  const { kind, value } = body.input;

  // Region + user count (optional, with safe defaults)
  const region =
    typeof body.region === "string" && ALLOWED_REGIONS.has(body.region)
      ? body.region
      : "us-east-1";
  const userCount =
    typeof body.userCount === "number" &&
    Number.isFinite(body.userCount) &&
    body.userCount >= 1
      ? Math.round(body.userCount)
      : 10_000;

  // ── Validate value per kind (Decision 7) ─────────────────────────────────
  if (kind === "github_url") {
    if (value.length > MAX_URL_LENGTH) {
      return NextResponse.json(
        { error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters` },
        { status: 400 }
      );
    }
    if (!isGitHubUrl(value)) {
      return NextResponse.json(
        { error: "URL must be a valid github.com HTTPS URL" },
        { status: 400 }
      );
    }
  } else {
    if (value.trim().length === 0) {
      return NextResponse.json(
        { error: "Description must not be empty" },
        { status: 400 }
      );
    }
    if (value.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        {
          error: `Description exceeds maximum length of ${MAX_DESCRIPTION_LENGTH} characters`,
        },
        { status: 400 }
      );
    }
  }

  // ── Stage 2: Evidence extraction (FLOW.md Stage 2) ───────────────────────
  const warnings: string[] = [];
  let ruleInput: RuleInput;
  let signals = null;
  let grounding: "repo" | "description";
  let description = "";

  if (kind === "github_url") {
    const githubToken = process.env.GITHUB_TOKEN;
    signals = await fetchRepoSignals(value, githubToken);

    // Insufficient-signal gate (Decision 20 / flaw 8)
    if (isInsufficientSignal(signals)) {
      const readme = signals.keyFiles.find((f) => f.kind === "readme");
      const snippet = readme?.content?.slice(0, 200) ?? "";
      return NextResponse.json({
        status: "insufficient_signal",
        message:
          "Couldn't extract enough from this repo — describe it instead.",
        prefill: { repoName: signals.repoName, readmeSnippet: snippet },
      });
    }

    // Grounding: did we actually get file content, or only an empty repo?
    const hasContent = signals.keyFiles.some((f) => f.content !== null);
    grounding = hasContent ? "repo" : "description";
    if (!hasContent) {
      warnings.push(
        "Could not fetch repo files — falling back to description-level inference."
      );
    }

    ruleInput = signalsToRuleInput(signals, kind, grounding);

    if (signals.truncated) {
      warnings.push("Some files were truncated due to size limits.");
    }
    if (signals.parseErrors.length > 0) {
      warnings.push(
        `${signals.parseErrors.length} file(s) could not be parsed and were used as filename-only signals.`
      );
    }
  } else {
    // Freeform description path — no fetch, grounding = description
    grounding = "description";
    description = value;
    ruleInput = {
      description: value,
      fileContent: "",
      fileNames: [],
      inputKind: kind,
      grounding,
      truncated: false,
      parseErrors: [],
    };
  }

  // ── Stage 3: Inference (rules baseline + optional LLM) ───────────────────
  const servicePlan = await runInference({
    ruleInput,
    signals,
    description,
  });

  // Grounding warning (Decision 19)
  if (grounding === "description") {
    warnings.push(
      "Inferred from your description only — not verified against code."
    );
  }

  // ── Stage 4: Diagram XML ──────────────────────────────────────────────────
  let diagramXml: string | null = null;
  try {
    diagramXml = generateDiagramXml(servicePlan);
  } catch (err) {
    console.warn("[analyze] Diagram generation failed:", err);
    warnings.push("Diagram generation failed — diagram unavailable.");
  }

  // ── Stage 5: Cost rows ────────────────────────────────────────────────────
  let costRows = null;
  try {
    costRows = await computeCostRows(servicePlan, region, userCount);
  } catch (err) {
    console.warn("[analyze] Cost computation failed:", err);
    warnings.push("Cost estimation failed — estimates unavailable.");
  }

  // ── Response ─────────────────────────────────────────────────────────────
  return NextResponse.json({
    input_kind: kind,
    grounding,
    service_plan: servicePlan,
    diagram_xml: diagramXml,
    cost_rows: costRows,
    warnings,
  });
}
