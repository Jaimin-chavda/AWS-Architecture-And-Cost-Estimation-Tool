---
quick_id: 260903-nly
slug: fix-llm-over-inference-and-diagram-conta
date: 2026-09-03
mode: quick
---

# Quick Task 260903-nly — Fix LLM over-inference and diagram container width overflow

Two independent bugs in the inference/diagram pipeline, each with a regression test.

## Bug 1 — LLM over-inference (evidence-free components)

`buildSystemPrompt()` orders the model to emit all 7 architecture layers
("must include all necessary layers", "Do not limit the output … enterprise-grade
AWS deployment"). `buildArchitecturePrompt()`'s description path repeats it
("You MUST decompose … Every single tier MUST be an item"). For a repo with zero
backend evidence (pure static HTML/CSS/JS) the model invents Lambda, API Gateway,
DynamoDB and Secrets Manager components.

**Fix:** rewrite both prompt paths so each component must cite specific evidence
(file path, dependency entry, README line, or user-description phrase) and so
minimal/empty layers are explicitly allowed. Add a code-level backstop in
`normalizeArchitectureModel()` that drops any component whose `evidence` array is
empty, no matter what the LLM returns.

## Bug 2 — Diagram container width overflow

`computeLayout()` force-assigns `rect.w` on two already-positioned containers:

- `diagram.ts:624` — cross-cutting container → `vpcRect.w`
- `diagram.ts:664` — edge banner → `baseCanvasW - 2 * MARGIN`

Neither checks the assigned width still covers the nodes already placed inside.
Reproduced: 6 edge services + 1 compute service shrinks the edge banner from its
natural 896px to 660px; nodes `e5`/`e6` land at cell-right 852/1000 against an
edge-container right edge of 784 and an AWS Cloud right edge of 804 — outside both.

**Fix:** `Math.max(naturalWidth, targetWidth)` at both sites so containers only
ever widen.

## Tasks

1. **Prompt rewrite + evidence backstop** — `llmClient.ts` (`buildSystemPrompt`,
   `buildArchitecturePrompt`), `architecture.ts` (`normalizeArchitectureModel`).
   Relationship filtering must key off surviving components, not the pre-filter
   list. Verify: `npm test`.
2. **Container width clamp** — `diagram.ts:624`, `diagram.ts:664`.
   Verify: `npm test`.
3. **Regression tests** — `architecture.test.ts` (evidence-less component
   rejection), `diagram.test.ts` (narrow-VPC / edge-banner overflow: every node
   inside its container, every container inside AWS Cloud).
   Verify: `npm test` — all green.

## Done when

- Evidence-free components never survive `validateArchitectureModel()`.
- No container is ever narrower than the nodes it holds.
- Full suite green (baseline: 166 passing).
