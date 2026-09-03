---
quick_id: 260903-nly
slug: fix-llm-over-inference-and-diagram-conta
date: 2026-09-03
mode: quick
status: complete
commits:
  - 6286583 fix(inference): require evidence citations and drop evidence-free components
  - 401807a fix(diagram): never shrink containers below the width their own nodes need
---

# Summary — Fix LLM over-inference and diagram container width overflow

Both bugs fixed, each with regression tests that fail against the pre-fix code.
Full suite: **175 passing, 0 failing** (baseline was 166).

## Bug 1 — LLM over-inference

**Prompt rewrite** (`llmClient.ts`)

- `buildSystemPrompt()` replaced. The old text ordered all seven tiers and closed
  with "Do not limit the output … enterprise-grade AWS deployment". The new text
  leads with **THE EVIDENCE RULE**: every component must cite a concrete file
  path, dependency entry, config key, README sentence, or description phrase, and
  states plainly that "typical for this kind of app", "best practice",
  "production systems need this" and "implied by the stack" are *not* evidence.
  A second section, **MINIMAL ARCHITECTURES ARE CORRECT ARCHITECTURES**, states
  that most tiers will be absent from any given project, that a static
  HTML/CSS/JS repo is a frontend component and nothing else, and that one
  component is a valid answer.
- `buildArchitecturePrompt()` repo path gained a preamble ahead of the profile
  summary: the evidence is the only thing that may be modelled, absent tiers are
  the expected result. The DISCOVERED DEPLOYABLE COMPONENTS block now closes with
  "this list is a floor, not a template: do not invent sibling tiers to
  'complete' it."
- Description path replaced. Previously "Every single tier MUST be an item in the
  'components' array"; now it requires citing the description phrase each
  component came from and says a description mentioning no database gets no
  database, no background processing gets no worker or queue, no login gets no
  auth component.

**Code backstop** (`architecture.ts`)

- `normalizeArchitectureModel()` trims each citation, discards blank/whitespace-only
  ones, and drops any component left with zero evidence — regardless of what the
  LLM emitted.
- Relationship filtering now keys off the *surviving* component ids, so an edge
  into a dropped component is dropped with it.
- `validateArchitectureModel()` returns `null` when normalization leaves zero
  components (logging `[architecture] every LLM component lacked evidence …`).
  `runInference()` then falls back to the deterministic rule engine, which is a
  better outcome than rendering pattern baselines with nothing behind them.
  This was an addition beyond the literal ask — noted here deliberately.

**Tests** — new `describe("evidence backstop …")` in `architecture.test.ts`,
5 cases: evidence-free sibling dropped; blank/whitespace citations count as none;
relationship into a dropped endpoint dropped; the reported static-HTML case
(5 components in, only the evidenced frontend survives, then asserts Lambda /
APIGateway / DynamoDB are not component-backed in the mapped plan); fully
evidence-free model returns `null`.

The shared `comp()` fixture helper gained a default citation plus an explicit
`evidence` parameter — without it the backstop would have dropped the components
of roughly eight pre-existing tests.

## Bug 2 — Diagram container width overflow

`computeLayout()` force-assigned `rect.w` on two containers whose nodes were
already positioned, without checking the new width still covered them:

- cross-cutting → `vpcRect.w` (`diagram.ts:626`)
- edge banner → `baseCanvasW - 2 * MARGIN` (`diagram.ts:670`)

Both are now `Math.max(natural, target)` — containers widen, never shrink.

Reproduction before the fix (6 edge services + 1 compute service): the edge
banner shrank from its natural 896px to 660px; nodes `e5`/`e6` reached cell-right
852/1000 against a container right edge of 784 and an AWS Cloud right edge of 804
— outside both. After the fix the banner keeps 896px inside a 976px cloud and all
six nodes are contained.

**Tests** — new `describe("container width overflow")` in `diagram.test.ts`,
4 cases sharing an `assertContained()` helper that checks every node's
CELL_W×CELL_H footprint against its parent container rect and every container rect
against `aws_cloud`: full edge banner with a narrow VPC; a 6×4 sweep of
edge-count × VPC-width; cross-cutting aligned to the VPC; all tiers populated at
once. Verified against the reverted code — the two edge-banner tests fail, the
two cross-cutting ones pass (see below).

## Notes / residual

- **The cross-cutting clamp is defensive only today.** `vpcRect.w` is always
  ≥ 680 while the cross-cutting grid's natural width is 600, so that override
  never actually shrank anything. Clamped anyway for the same reason as the edge
  banner, and the existing `assert.strictEqual(cross.w, vpc.w)` test still passes.
- **`applyPatternBaselines()` is untouched and still unconditional.** It adds
  Route53, CloudWatch, SecretsManager, CloudFormation, and ECS (when no compute
  service exists) with `fromPattern: true`, regardless of evidence. A static site
  will therefore *still* surface Secrets Manager and ECS through that separate
  path. Out of the stated scope, so deliberately left alone — flagging it because
  it partially overlaps the symptom Bug 1 was reported against.
