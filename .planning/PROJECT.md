# AWS Architect

## What This Is

A webapp where a user submits a GitHub repo OR a plain project idea/description, and the app infers the AWS services that deployment would need, generates a draw.io deployment diagram, and produces a monthly cost estimate. Users can generate and download everything without logging in; a simple login exists for saved history. Built for a university SGP project — expected traffic is low.

## Core Value

Given a repo or idea, produce a correct AWS service map with a downloadable draw.io diagram and a realistic monthly cost estimate.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] User can paste a GitHub repo URL and the app reads the README + key files to infer AWS services. Key files = fixed allowlist at root or depth ≤1: README (any case/extension); manifests `package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle, *.csproj`; container/CI `Dockerfile, docker-compose.{yml,yaml}, serverless.{yml,yaml}, .github/workflows/*.yml, vercel.json, netlify.toml, terraform/*.tf, template.yaml`. Caps: 20 files, 64KB raw read/file, 50k-path cap on the tree listing. Structured files (JSON/YAML) are compacted to the first ~40 top-level entries and re-serialized as well-formed output before feeding the LLM — never raw-truncated mid-structure; unparseable files degrade to filename-only signal. Over-limit files are skipped by priority (README → manifests → container/CI) and the result is flagged `truncated`/`parse_errors` in the UI
- [ ] User can paste a freeform project description and get the same pipeline (guided questionnaire optional, default freeform)
- [ ] Inference engine is LLM-based with a rule-based keyword fallback, outputting a structured list of AWS services
- [ ] Inference classifies the repo into one of a closed set of architecture patterns (5–8 templates) and maps inferred services into that pattern's named node slots — the LLM never emits a freeform service list with no slot/edge structure. Single-deployable assumption: only root/depth-≤1 manifests count as deployable evidence; nested per-service manifests never create additional deployables; exactly one pattern per analysis (slot total ≤ 12 distinct services by construction)
- [ ] Diagram generator consumes (pattern template + filled slots) to emit nodes AND edges; unclassifiable/hybrid repos fall back to closest-matching pattern plus a flagged "custom" edge list for manual review
- [ ] App generates a draw.io diagram and shows an in-browser preview plus a downloadable `.drawio` file
- [ ] Cost estimate uses the real AWS Price List API (free) with region picker; shows per-service and monthly total. Baseline usage defaults come from a documented source table (`SERVICE_DEFAULTS.ts` + `DEFAULTS.md`): each default carries a `source` — an AWS free-tier limit (Lambda 1M req/mo, S3 5 GB, API Gateway 1M req/mo, DynamoDB 25 GB, CloudFront 1 GB egress, nano/micro-class instances, etc.) or an explicit "small-app baseline" assumption. The cost screen shows an expandable Assumptions list with each default + source; baselines are never derived from repo content and are always presented as assumptions, never fact
- [ ] Price List API is hit once per (region, service) during analysis only; raw unit prices are stored server-side (in-memory cache, keyed `region:serviceCode:usageType`, TTL 24h)
- [ ] Cost simulator: user-count slider (100 → 1M) scales service quantities and recalculates cost live — entirely client-side math over the cached unit prices already sent to the frontend, never a new Price List call; only a region change or a fresh analysis re-queries the API. Region change fetches only the distinct services in the ServicePlan (≤12, bounded by template slot max) with ≤10 concurrent `GetProducts` calls → ~1–2s typical, ≤3s worst case at max slots, then 24h cached; the cost panel shows "Loading prices…" with the slider disabled during the fetch. No pre-warming of other regions; default region = analysis region (us-east-1) so the common path never re-fetches
- [ ] User can generate and estimate without logging in; optional login saves analysis history. Schema: `analyses(id, user_id?, input_kind, input, grounding, service_plan JSON, diagram_xml TEXT, cost_snapshot JSON, created_at)` — `input_kind` records what was pasted ('repo' | 'description'), `grounding` records what inference ran on (they may differ: a repo whose repo-content path failed and fell back to its description is `input_kind='repo', grounding='description'`). Saved analysis is a frozen snapshot: reopening renders the stored plan + diagram + costs, never re-queries prices or re-runs inference; the slider scales client-side from snapshot quantities only
- [ ] Every analysis carries `grounding: 'repo' | 'description'`; freeform/description-grounded results are capped at the "Low confidence" tier with a banner "Inferred from your description only — not verified against code"; repo-grounded results show a High/Medium tier per rules/LLM consensus
- [ ] LLM output has one fixed contract: the zod `ServicePlan` schema, identical for every provider via `generateObject`; a single `safeParse` + catalog-allowlist gate precedes any use; failure → rules baseline, no provider-specific tuning
- [ ] If extraction yields no allowlist manifest/container/CI file AND README content < 100 chars → explicit "insufficient signal" state with no inference attempted: prompt the user to switch to the freeform description path, pre-filled with repo name + README snippet; never a silent low-confidence guess

### Out of Scope

- Editable in-app diagram editor (moving/relabeling nodes) — preview is read-only, download is the output
- Public shared diagram links — not needed for a university demo
- Full code scan of every source file — README + config/key files is the intended depth
- Monorepo / multi-service composition (multiple deployables composed into a multi-pattern diagram) — single-deployable repos only; a monorepo is analyzed as its strongest root-level deployable; flagged future work
- Price-list pre-warming for multiple regions — prices fetched on demand for the selected region only
- Live price/usage re-check on saved history — history is a frozen snapshot by design
- Deriving usage baselines from repo content — documented assumptions + slider only
- CI/CD pipeline or production-grade multi-tenant deployment — local/university-hosted demo

## Context

- University SGP project; traffic and usage are minimal, so per-call costs and API rate limits are non-issues.
- The AWS Price List API (Query + Bulk) is free of charge. Rate limits: token bucket ~10 burst, refill ~5/sec per account+region. Prices change rarely, so a 24h server-side cache (fetched once per region/service at analysis time) keeps the API out of the hot path — slider recalculation is pure client-side math. The closed template set bounds each analysis to ≤12 distinct services, so a region-change batch fits within the ~10 burst and completes in ~1–2s typical.
- Draw.io diagrams are mxGraph XML — the official draw.io embed library can render them in-browser. Output is template-driven: a closed pattern set gives fixed slots + edges instead of freeform node lists.
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
| Cost = cache unit prices server-side | On analysis, fetch Price List API once per (region, service); store raw unit prices in an in-memory cache keyed `region:serviceCode:usageType` with 24h TTL (prices don't change intraday). Token bucket (10 burst, 5/sec) only applies to the batch fetch. Region change or new service set triggers a re-fetch, never a slider tick | — Pending |
| Cost simulator = client-side over cached prices | Slider (100 → 1M) recalculates using per-service scaling functions (linear for requests, sub-linear for storage, fixed floors where apt) over the cached unit prices already sent to the frontend — zero Price List calls on slider move | — Pending |
| Inference = LLM with rules fallback | Best accuracy with a safety net | — Pending |
| Diagram = pattern-first, template-driven | Mandatory classification step between inference and drawing: closed set of 5–8 pre-defined patterns (named node slots + directional edges + layout hint). LLM outputs best-matching pattern + service-per-slot; generator consumes template + filled slots to emit nodes AND edges. No flat service lists → nodes; hybrids get closest pattern + flagged custom edge list for manual review | — Pending |
| Auth = optional login, generation allowed as guest | University demo doesn't need forced auth; history is a nice-to-have | — Pending |
| Idea input = freeform default + optional guided questionnaire | Both paths, keep default frictionless | — Pending |
| LLM provider = cheap/free tier | Low traffic, structured JSON extraction is easy for these models | — Pending |
| Key-file fetch bounded by allowlist + caps (20 files, 64KB raw read, structured files compacted to first ~40 top-level entries and re-serialized well-formed; unparseable → filename-only signal; priority skip + `truncated`/`parse_errors` flag) | Depth/size bounds must be deterministic; compact-then-truncate avoids feeding malformed YAML/XML to the LLM; filename-only fallback still feeds the rules baseline | — Pending |
| Monorepo composition = Out of Scope; strongest root-level deployable wins | Pattern templates assume one deployable; composing templates is out of the demo's value | — Pending |
| Region switch = on-demand re-fetch of only planned services (≤12, bounded by slot max); ~1–2s typical, ≤3s worst case; no pre-warm | Service count is bounded by the template set, not the catalog; the ~10 burst handles the whole batch; pre-warming wastes API calls | — Pending |
| Freeform results capped by `grounding='description'` at "Low confidence" tier + UI banner | No code to verify against — must stay distinct from repo-grounded results | — Pending |
| Output contract = single zod `ServicePlan` schema; uniform `safeParse` + catalog-allowlist gate | Provider-agnostic; fallback behavior identical across providers; swap = env key/model only | — Pending |
| Cost defaults = sourced table (`SERVICE_DEFAULTS.ts` + `DEFAULTS.md`) + UI Assumptions disclosure | Unsourced numbers undermine the core value; defaults must be transparent and labeled as assumptions | — Pending |
| History = exact frozen snapshot (service plan + diagram XML + costs) at save time | Reproducible demo; re-querying would contradict the cache design | — Pending |
| Insufficient signal → explicit advisory + prompt to freeform instead of a low-confidence guess | No silent near-empty extraction producing a normal-looking result | — Pending |

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
*Last updated: 2026-08-12 after architecture review (cost cache + pattern-first diagrams + flaw resolutions 1–8)*
