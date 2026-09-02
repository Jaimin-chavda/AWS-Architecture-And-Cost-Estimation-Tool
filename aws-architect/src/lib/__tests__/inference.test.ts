/**
 * inference.test.ts
 *
 * Tests for the central reasoning flow in inference.ts:
 *  - grounding derivation
 *  - grounding confidence cap
 *  - runInference fallback to the rules baseline when no LLM is configured
 *
 * No real LLM or network calls — the test runner has no provider keys set,
 * so runInference takes its deterministic fallback path.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/inference.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runInference, deriveGrounding, applyGroundingCap } from "../inference.ts";
import type { InferenceInput } from "../inference.ts";
import { ServicePlanSchema } from "../schema.ts";
import type { ServicePlan } from "../schema.ts";
import type { RuleInput } from "../ruleEngine.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRuleInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    description: "",
    fileContent: "",
    fileNames: [],
    inputKind: "description",
    grounding: "description",
    truncated: false,
    parseErrors: [],
    ...overrides,
  };
}

function makePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    inputKind: "description",
    components: [
      { id: "comp1", type: "backend", technology: "Lambda", evidence: ["explicit lambda"], confidence: "high", status: "detected" },
      { id: "comp2", type: "database", technology: "DynamoDB", evidence: ["dynamo ref"], confidence: "high", status: "detected" },
      { id: "comp3", type: "proxy", technology: "CloudWatch", evidence: ["always present"], confidence: "medium", status: "inferred" },
    ],
    awsMappings: [
      { componentId: "comp1", serviceId: "Lambda", confidence: "high", evidence: "explicit lambda", fromPattern: false },
      { componentId: "comp2", serviceId: "DynamoDB", confidence: "high", evidence: "dynamo ref", fromPattern: false },
      { componentId: "comp3", serviceId: "CloudWatch", confidence: "medium", evidence: "always present", fromPattern: false },
    ],
    relationships: [],
    deploymentModel: [],
    detectedPattern: "serverless-api",
    metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Fix 2 — Grounding derivation", () => {
  it("derives 'description' when description is non-empty", () => {
    const g = deriveGrounding({
      description: "My custom app",
      fetchedFiles: [{ content: "package.json content" }],
    });
    assert.strictEqual(g, "description");
  });

  it("derives 'repoFiles' when description is empty and file content was fetched", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [
        { content: "FROM node:22" },
        { content: null },
      ],
    });
    assert.strictEqual(g, "repoFiles");
  });

  it("derives 'filenameOnly' when fetch fails for all files but filenames were known", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [
        { content: null },
        { content: null },
      ],
    });
    assert.strictEqual(g, "filenameOnly");
    assert.notStrictEqual(g, "description", "Must never be 'description' when description is empty");
  });

  it("derives 'unfounded' when fetch failed AND no filenames were resolvable", () => {
    const g = deriveGrounding({
      description: "",
      fetchedFiles: [],
    });
    assert.strictEqual(g, "unfounded");
    assert.notStrictEqual(g, "description");
  });
});

describe("Decision 19 — Grounding confidence cap", () => {
  it("does not cap confidence for repo / repoFiles grounding", () => {
    for (const g of ["repo", "repoFiles"] as const) {
      const result = applyGroundingCap(makePlan(), g);
      // Check that high confidence remains high
      const highConf = result.awsMappings.find(m => m.confidence === "high");
      assert.ok(highConf, `grounding=${g} must not cap high confidence`);
    }
  });

  it("caps all confidence to 'low' for description / filenameOnly / unfounded grounding", () => {
    for (const g of ["description", "filenameOnly", "unfounded"] as const) {
      const result = applyGroundingCap(makePlan(), g);
      for (const mapping of result.awsMappings) {
        assert.strictEqual(mapping.confidence, "low", `grounding=${g}: expected 'low' got '${mapping.confidence}'`);
      }
    }
  });
});

describe("runInference — no-LLM fallback", () => {
  it("returns a valid ServicePlan and a null architectureModel when no LLM is configured", async () => {
    const input: InferenceInput = {
      ruleInput: makeRuleInput({
        description: "react app with express api postgres and s3",
        inputKind: "description",
        grounding: "description",
      }),
      signals: null,
      description: "react app with express api postgres and s3",
      profile: null,
    };

    const result = await runInference(input);

    assert.strictEqual(result.architectureModel, null, "No LLM configured → no architecture model");
    const check = ServicePlanSchema.safeParse(result.plan);
    assert.ok(check.success, "Fallback plan must be a valid ServicePlan");
    assert.strictEqual(result.plan.inputKind, "description");
  });

  it("falls back to rules when the LLM path is unavailable, preserving input metadata", async () => {
    const input: InferenceInput = {
      ruleInput: makeRuleInput({
        inputKind: "github_url",
        grounding: "repoFiles",
        truncated: true,
        parseErrors: ["bad.yaml"],
      }),
      signals: null,
      description: "",
      profile: null,
    };

    const result = await runInference(input);
    assert.strictEqual(result.plan.metadata.grounding, "repoFiles");
    assert.strictEqual(result.plan.metadata.truncated, true);
    assert.deepStrictEqual(result.plan.metadata.parseErrors, ["bad.yaml"]);
  });
});