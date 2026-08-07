# STATE

## Project Reference

- **Core Value**: Given a repo or idea, produce a correct AWS service map with a downloadable draw.io diagram and a realistic monthly cost estimate.
- **Current Focus**: Phase 1 — prove the output side (draw.io XML + embed preview) with canned data before any external integration.
- **Milestone**: v1 (21 requirements, 6 phases)
- **Guest-first**: no phase before 6 requires a session; auth is strictly additive.

## Current Position

- **Phase**: 1 — Pipeline Skeleton (Canned Input + Foundation)
- **Plan**: (none yet — phase not planned)
- **Status**: Not started
- **Progress**: [■■□□□□□□□□] 0/6 phases

## Performance Metrics

- **Phase count**: 6 (granularity: standard)
- **Requirement coverage**: 21/21 mapped (see REQUIREMENTS.md Traceability)
- **Plans complete**: 0/0

## Accumulated Context

### Key Decisions

- Stack fixed by research (HIGH confidence): Next.js 16 + Node 22 LTS + AI SDK v7 (`@ai-sdk/deepseek` `deepseek-v4-flash` primary, Gemini/Groq fallbacks) + zod 4 + better-sqlite3 ^12 + better-auth + draw.io embed iframe. Node 22 is non-negotiable (AI SDK v7 hard-requires ≥22).
- **Keystone contract**: `ServicePlan` (shared zod schema) — every stage emits/consumes it. LLM never emits XML or prices.
- Build order is dependency-driven: 1 canned output → 2 real inputs → 3 deterministic rules → 4 LLM enhancement → 5 cost → 6 auth last.
- **Open pricing-source decision** (resolve in Phase 5 research): public AWS Bulk offer files (no credentials) vs `@aws-sdk/client-pricing` Query API (needs IAM). Research lean: bulk files primary + defaults fallback.
- Version pins that matter: `better-sqlite3@^12` (not 13 — outside better-auth peer range), `deepseek-v4-flash` model ID (old IDs retired 2026-07-24).

### Requirements Mapping

- Phase 1: DIAG-01..04 · Phase 2: INPT-01..03 · Phase 3: INF-01, INF-02, INF-05 · Phase 4: INF-03, INF-04 · Phase 5: COST-01..04, SIM-01, SIM-02 · Phase 6: AUTH-01..03

### Research Flags (need `/gsd-research-phase`)

- **Phase 1**: mxGraph XML format + draw.io AWS icon style names; pricing data source decision (IAM needed or not)
- **Phase 5**: per-service price-file structure for each catalog service's quantity model
- **Phase 4** (light): provider JSON-mode specifics

### Next Actions

1. Approve roadmap (user)
2. `/gsd-plan-phase 1`

### Blockers

- None — research complete (HIGH confidence). Phase 1 flag: verify icon style names during implementation; fallback `shape=image` data URIs.

## Session Continuity

- 2026-08-07: Project initialized; research complete; roadmap created (6 phases, 21/21 coverage).
- Next session: plan Phase 1 after user approval.
