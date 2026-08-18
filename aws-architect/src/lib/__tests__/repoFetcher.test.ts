/**
 * repoFetcher.test.ts
 *
 * Tests for the pure-logic functions in repoFetcher.ts:
 * file classification, content compaction, signal-gate check.
 * No network calls made.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isInsufficientSignal, signalsToRuleInput } from "../repoFetcher.ts";
import type { RepoSignals } from "../repoFetcher.ts";

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

function makeSignals(overrides: Partial<RepoSignals> = {}): RepoSignals {
  return {
    repoName: "owner/repo",
    defaultBranch: "main",
    keyFiles: [],
    truncated: false,
    parseErrors: [],
    readmeLength: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isInsufficientSignal gate (Decision 20 / flaw 8)
// ---------------------------------------------------------------------------

describe("isInsufficientSignal", () => {
  it("returns true when no manifest/CI and readme < 100 chars", () => {
    const signals = makeSignals({ readmeLength: 50 });
    assert.ok(isInsufficientSignal(signals));
  });

  it("returns false when readme >= 100 chars even with no manifests", () => {
    const signals = makeSignals({ readmeLength: 100 });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when a manifest file is present (even empty readme)", () => {
    const signals = makeSignals({
      readmeLength: 0,
      keyFiles: [
        { path: "package.json", kind: "manifest", content: "{}", sizeBytes: 2, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when a container/CI file is present", () => {
    const signals = makeSignals({
      readmeLength: 0,
      keyFiles: [
        { path: "Dockerfile", kind: "container_ci", content: "FROM node:22", sizeBytes: 12, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });

  it("returns false when both manifest and readme present", () => {
    const signals = makeSignals({
      readmeLength: 200,
      keyFiles: [
        { path: "package.json", kind: "manifest", content: "{}", sizeBytes: 2, truncated: false },
      ],
    });
    assert.ok(!isInsufficientSignal(signals));
  });
});

// ---------------------------------------------------------------------------
// signalsToRuleInput
// ---------------------------------------------------------------------------

describe("signalsToRuleInput", () => {
  it("concatenates file contents into fileContent", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: "package.json", kind: "manifest", content: '{"name":"test"}', sizeBytes: 15, truncated: false },
        { path: "Dockerfile", kind: "container_ci", content: "FROM node:22", sizeBytes: 12, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileContent.includes("package.json"));
    assert.ok(input.fileContent.includes("Dockerfile"));
    assert.ok(input.fileContent.includes("FROM node:22"));
  });

  it("extracts file basenames into fileNames", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: ".github/workflows/ci.yml", kind: "container_ci", content: "name: CI", sizeBytes: 8, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileNames.includes("ci.yml"));
  });

  it("handles null content files as filename-only signal placeholder", () => {
    const signals = makeSignals({
      keyFiles: [
        { path: "serverless.yml", kind: "container_ci", content: null, sizeBytes: 100, truncated: false },
      ],
    });
    const input = signalsToRuleInput(signals, "github_url", "repo");
    assert.ok(input.fileContent.includes("serverless.yml"));
    assert.ok(input.fileContent.includes("parse error"));
  });

  it("passes through inputKind, grounding, truncated, parseErrors", () => {
    const signals = makeSignals({ truncated: true, parseErrors: ["bad.yaml"] });
    const input = signalsToRuleInput(signals, "github_url", "description");
    assert.strictEqual(input.inputKind, "github_url");
    assert.strictEqual(input.grounding, "description");
    assert.strictEqual(input.truncated, true);
    assert.deepStrictEqual(input.parseErrors, ["bad.yaml"]);
  });
});
