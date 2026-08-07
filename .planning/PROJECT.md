# AWS Architect

## What This Is

A webapp where a user submits a GitHub repo OR a plain project idea/description, and the app infers the AWS services that deployment would need, generates a draw.io deployment diagram, and produces a monthly cost estimate. Users can generate and download everything without logging in; a simple login exists for saved history. Built for a university SGP project — expected traffic is low.

## Core Value

Given a repo or idea, produce a correct AWS service map with a downloadable draw.io diagram and a realistic monthly cost estimate.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User can paste a GitHub repo URL and the app reads the README + key files (package manifests, Dockerfile, compose, serverless.yml) to infer AWS services
- [ ] User can paste a freeform project description and get the same pipeline (guided questionnaire optional, default freeform)
- [ ] Inference engine is LLM-based with a rule-based keyword fallback, outputting a structured list of AWS services
- [ ] App generates a draw.io diagram and shows an in-browser preview plus a downloadable `.drawio` file
- [ ] Cost estimate uses the real AWS Price List API (free) with sensible per-service defaults and a region picker; shows per-service and monthly total
- [ ] Cost simulator: user-count slider (100 → 1M) scales service quantities and recalculates cost live
- [ ] User can generate and estimate without logging in; optional login saves analysis history

### Out of Scope

- Editable in-app diagram editor (moving/relabeling nodes) — preview is read-only, download is the output
- Public shared diagram links — not needed for a university demo
- Full code scan of every source file — README + config/key files is the intended depth
- CI/CD pipeline or production-grade multi-tenant deployment — local/university-hosted demo

## Context

- University SGP project; traffic and usage are minimal, so per-call costs and API rate limits are non-issues.
- The AWS Price List API (Query + Bulk) is free of charge. Rate limits: token bucket ~10 burst, refill ~5/sec per account+region — ample for this app. Requires AWS credentials (free-tier account is sufficient).
- Draw.io diagrams are mxGraph XML — the official draw.io embed library can render them in-browser.
- LLM calls for inference should use a cheap/free-tier provider (DeepSeek, Gemini Flash, Groq class) — the researcher validates the best fit for structured JSON extraction.

## Constraints

- **Tech stack**: Undecided — researcher will pick (framework, draw.io rendering lib, pricing API client, LLM SDK). No preference from user.
- **Cost**: No budget; prefer free tiers and cheap LLM providers.
- **Scope**: University project — simplicity and reliability over scale.
- **AWS credentials**: App needs IAM credentials for the Price List API (read-only, free tier).

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Repo analysis = README + file scan (not full code) | Fast, cheap, catches 80% of infra signals | — Pending |
| Draw.io output = in-app preview + .drawio download (no editor) | Simple, reliable, matches how draw.io files are used | — Pending |
| Cost = real AWS Price List API with defaults + region picker | Free API, accurate prices, minimal input from user | — Pending |
| Inference = LLM with rules fallback | Best accuracy with a safety net | — Pending |
| Auth = optional login, generation allowed as guest | University demo doesn't need forced auth; history is a nice-to-have | — Pending |
| Idea input = freeform default + optional guided questionnaire | Both paths, keep default frictionless | — Pending |
| Cost simulator = user-count slider with per-service scaling | Interactive, understandable, live recalculation | — Pending |
| LLM provider = cheap/free tier | Low traffic, structured JSON extraction is easy for these models | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-07 after initialization*
