/**
 * inference.test.ts
 *
 * Tests for the merge logic and grounding cap in inference.ts.
 * No real LLM or network calls — all merge-function inputs are constructed directly.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/inference.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeServicePlans } from "../inference.ts";
import type { ServicePlan } from "../schema.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlan(overrides: Partial<ServicePlan> = {}): ServicePlan {
  return {
    inputKind: "description",
    pattern: "serverless-api",
    slots: {
      compute: { serviceId: "Lambda", confidence: "high", evidence: "explicit lambda" },
      database: { serviceId: "DynamoDB", confidence: "high", evidence: "dynamo ref" },
      monitoring: { serviceId: "CloudWatch", confidence: "medium", evidence: "always present" },
    },
    customEdges: [],
    metadata: { grounding: "repo", truncated: false, parseErrors: [] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeServicePlans — null LLM result", () => {
  it("returns baseline unchanged when llmResult is null (repo grounding)", () => {
    const baseline = makePlan();
    const result = mergeServicePlans(baseline, null, "repo");
    assert.strictEqual(result.pattern, "serverless-api");
    assert.ok(result.slots.compute.serviceId === "Lambda");
    assert.ok(result.slots.database.serviceId === "DynamoDB");
    // repo grounding: no confidence cap
    assert.strictEqual(result.slots.compute.confidence, "high");
  });

  it("caps all confidence to 'low' when grounding=description and llmResult is null", () => {
    const baseline = makePlan({ metadata: { grounding: "description", truncated: false, parseErrors: [] } });
    const result = mergeServicePlans(baseline, null, "description");
    for (const slot of Object.values(result.slots)) {
      assert.strictEqual(slot.confidence, "low", `Expected 'low' got '${slot.confidence}' for ${slot.serviceId}`);
    }
  });
});

describe("mergeServicePlans — with LLM result", () => {
  it("uses 'high' confidence for services in both baseline and LLM", () => {
    const baseline = makePlan({
      slots: {
        compute: { serviceId: "Lambda", confidence: "medium", evidence: "rule signal" },
        monitoring: { serviceId: "CloudWatch", confidence: "medium", evidence: "always" },
      },
    });
    const llm = makePlan({
      pattern: "serverless-api",
      slots: {
        compute: { serviceId: "Lambda", confidence: "high", evidence: "aws-sdk lambda import" },
        api: { serviceId: "APIGateway", confidence: "high", evidence: "api gateway endpoint" },
      },
    });

    const result = mergeServicePlans(baseline, llm, "repo");

    // Lambda in both → high
    const lambdaSlot = Object.values(result.slots).find((s) => s.serviceId === "Lambda");
    assert.ok(lambdaSlot, "Lambda should be in merged plan");
    assert.strictEqual(lambdaSlot!.confidence, "high");

    // APIGateway from LLM only → medium (capped)
    const apiSlot = Object.values(result.slots).find((s) => s.serviceId === "APIGateway");
    assert.ok(apiSlot, "APIGateway from LLM should be in merged plan");
    assert.strictEqual(apiSlot!.confidence, "medium");

    // CloudWatch from baseline only → low
    const cwSlot = Object.values(result.slots).find((s) => s.serviceId === "CloudWatch");
    assert.ok(cwSlot, "CloudWatch from baseline should be kept");
    assert.strictEqual(cwSlot!.confidence, "low");
  });

  it("uses LLM pattern when LLM result is present", () => {
    const baseline = makePlan({ pattern: "generic" });
    const llm = makePlan({ pattern: "containerised-app" });
    const result = mergeServicePlans(baseline, llm, "repo");
    assert.strictEqual(result.pattern, "containerised-app");
  });

  it("caps all confidence to 'low' on description grounding even with LLM", () => {
    const baseline = makePlan({ metadata: { grounding: "description", truncated: false, parseErrors: [] } });
    const llm = makePlan({
      pattern: "serverless-api",
      slots: { compute: { serviceId: "Lambda", confidence: "high", evidence: "high signal" } },
    });
    const result = mergeServicePlans(baseline, llm, "description");
    for (const slot of Object.values(result.slots)) {
      assert.strictEqual(slot.confidence, "low");
    }
  });

  it("never exceeds 12 distinct services after merge", () => {
    // Create baseline with 8 services
    const baseSlots: Record<string, { serviceId: string; confidence: "high" | "medium" | "low"; evidence: string }> = {};
    const bSvcs = ["Lambda", "DynamoDB", "S3", "CloudWatch", "SQS", "SNS", "Cognito", "Route53"];
    bSvcs.forEach((id, i) => { baseSlots[`slot${i}`] = { serviceId: id, confidence: "medium", evidence: "rule" }; });

    // LLM adds 8 different services
    const llmSlots: typeof baseSlots = {};
    const lSvcs = ["ECS", "RDS", "CloudFront", "ALB", "APIGateway", "ElastiCache", "ECR", "EventBridge"];
    lSvcs.forEach((id, i) => { llmSlots[`lslot${i}`] = { serviceId: id, confidence: "high", evidence: "llm" }; });

    const baseline = makePlan({ slots: baseSlots });
    const llm = makePlan({ slots: llmSlots });
    const result = mergeServicePlans(baseline, llm, "repo");

    const unique = new Set(Object.values(result.slots).map((s) => s.serviceId));
    assert.ok(unique.size <= 12, `Expected ≤12, got ${unique.size}`);
  });

  it("resolves slot name collisions with additional_N overflow slots", () => {
    // Both LLM and baseline use the same slot name for different services
    const baseline = makePlan({
      slots: {
        compute: { serviceId: "Lambda", confidence: "medium", evidence: "base" },
      },
    });
    const llm = makePlan({
      slots: {
        compute: { serviceId: "ECS", confidence: "high", evidence: "llm" },
        // Same slot name — should cause collision resolution
        database: { serviceId: "DynamoDB", confidence: "high", evidence: "llm" },
      },
    });
    const result = mergeServicePlans(baseline, llm, "repo");
    // All serviceIds should be present (no data loss)
    const ids = new Set(Object.values(result.slots).map((s) => s.serviceId));
    // Lambda (baseline only) + ECS and DynamoDB (LLM) → all 3 present if under cap
    assert.ok(ids.has("ECS"), "ECS should be in merged plan");
    assert.ok(ids.has("DynamoDB"), "DynamoDB should be in merged plan");
    // All slot names should be unique
    const slotNames = Object.keys(result.slots);
    assert.strictEqual(slotNames.length, new Set(slotNames).size, "Slot names must be unique");
  });

  it("falls back to baseline when LLM services exceed catalog (gate catches it)", () => {
    // If somehow a bad LLM result gets through (all invalid service IDs),
    // ServicePlanSchema.safeParse in mergeServicePlans should reject it
    // and return baseline.
    const baseline = makePlan();
    const badLlm: ServicePlan = {
      ...makePlan(),
      slots: {
        compute: { serviceId: "INVALID_SERVICE", confidence: "high", evidence: "hallucinated" },
      },
    };
    // Note: in real flow, callLlm already gates this. Here we test the merge
    // itself is robust — bad data → baseline.
    // The merge produces an invalid serviceId → ServicePlanSchema.safeParse fails
    // → mergeServicePlans returns baseline with grounding cap.
    const result = mergeServicePlans(baseline, badLlm, "repo");
    // Lambda should still be present (from baseline fallback)
    const ids = new Set(Object.values(result.slots).map((s) => s.serviceId));
    assert.ok(ids.has("Lambda"), "Should fall back to baseline (Lambda present)");
    assert.ok(!ids.has("INVALID_SERVICE"), "Invalid service ID must not appear");
  });
});

describe("mergeServicePlans — metadata passthrough", () => {
  it("preserves parseErrors from baseline metadata", () => {
    const baseline = makePlan({
      metadata: { grounding: "repo", truncated: false, parseErrors: ["bad.yaml"] },
    });
    const result = mergeServicePlans(baseline, null, "repo");
    assert.deepStrictEqual(result.metadata.parseErrors, ["bad.yaml"]);
  });

  it("preserves truncated flag from baseline metadata", () => {
    const baseline = makePlan({
      metadata: { grounding: "repo", truncated: true, parseErrors: [] },
    });
    const result = mergeServicePlans(baseline, null, "repo");
    assert.strictEqual(result.metadata.truncated, true);
  });
});
