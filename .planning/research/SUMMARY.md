# Project Research Summary

**Project:** AWS Architect (repo/idea → AWS deployment diagram + cost estimate webapp)
**Domain:** AI-assisted cloud architecture diagram generator + cost estimator (university demo scale)
**Researched:** 2026-08-07
**Confidence:** HIGH for stack and architecture; MEDIUM-HIGH for features and pitfalls

## Executive Summary

This is a thin-client, single-monolith-server webapp that turns a GitHub repo URL or a freeform English description into (1) a downloadable `.drawio` AWS architecture diagram rendered in-browser, and (2) a realistic monthly AWS cost estimate from real price data. All four research files converge on one architecture: everything that touches secrets (LLM keys, AWS credentials) or needs caching (GitHub fetches, AWS prices) lives server-side; the client only renders forms, the diagram, and live slider math. The keystone is a single typed JSON contract — `ServicePlan` — that every stage emits and consumes. The LLM emits a small validated service list; diagram XML and cost rows are generated deterministically from it. The LLM must never emit XML or prices directly.

Recommended stack: **Next.js 16 (App Router) + React 19 + TypeScript on Node 22 LTS**, **Vercel AI SDK v7** with `generateObject` + zod 4 for schema-enforced structured LLM output (**DeepSeek `deepseek-v4-flash`** primary, Gemini Flash / Groq free tiers as fallbacks), **better-sqlite3 ^12 + better-auth** for optional login/history, **@aws-sdk/client-pricing or the public AWS bulk price files** for real prices, and the **draw.io embed iframe** (postMessage protocol) for preview. The single strongest reliability pattern: a deterministic rule engine runs first as the no-keys baseline, the LLM enhances it, and output is validated against a fixed ~30–40 service catalog — so the app still works with zero API keys, and hallucinated services never reach the diagram or price table.

Key risks, all with known mitigations: (1) unreliable LLM JSON output → catalog validation + flat zod schema + retry-then-rule-fallback chain; (2) GitHub unauthenticated 60 req/hr wall on shared school IPs → server-side PAT + per-repo cache; (3) AWS pricing region-name vs code confusion and missing cost dimensions (transfer, NAT) → static code↔name map, on-demand-only pricing with stated assumptions, per-service cost models; (4) `.drawio` files draw.io refuses to open → by-construction XML emitter + golden-file tests; (5) secrets/SSRF → server-side-only keys, host allowlist, rate limiting. The build order is dependency-driven: prove the output side (diagram XML + embed) with canned data first, then real inputs, then rules, then LLM, then cost, then auth last.

## Key Findings

### Recommended Stack

Next.js full-stack monolith (UI + API routes in one process) is the unanimous recommendation: server-side code is mandatory (secrets, caching, rate limits) and a separate backend would be two processes where one suffices. Node 22 LTS is non-negotiable — AI SDK v7 hard-requires ≥22. Version pins matter: `better-sqlite3@^12` (v13 is outside better-auth's peer range) and `deepseek-v4-flash` (the old `deepseek-chat`/`deepseek-reasoner` model IDs were retired 2026-07-24 and now 400).

**Core technologies:**
- **Node.js 22 LTS + Next.js 16 (App Router) + React 19 + TypeScript**: runtime + full-stack framework — one process serves UI + API routes; keeps all secrets server-side with zero extra backend
- **Vercel AI SDK v7 (`ai@^7.0.56`) + `generateObject` + zod 4**: schema-enforced structured JSON with auto-retry; one code path for every provider (provider swap = env change)
- **`@ai-sdk/deepseek` (model `deepseek-v4-flash`)**: cheapest primary LLM (~pennies per demo); **`@ai-sdk/google` (gemini-2.5-flash, real free tier, best schema enforcement)** and **`@ai-sdk/groq` (genuinely free, no card)** as zero-budget fallbacks
- **zod 4.4.3**: single source of truth — same schema drives LLM output validation and API boundary validation
- **better-sqlite3 ^12.11.1 + better-auth 1.6.26**: zero-config SQLite (2 tables) + declarative email/password auth; never hand-roll auth
- **@aws-sdk/client-pricing 3.1105.0** (Query API, read-only IAM) — see gap: ARCHITECTURE/PITFALLS prefer the public **Bulk API** files (no credentials at all); resolve in Phase 5 research
- **draw.io embed iframe** (`embed.diagrams.net`, postMessage `init`→`load`): 100% faithful preview of our own XML; never bundle mxGraph (breaks under bundlers)

### Expected Features

Competitor landscape (Cloudcraft, AWS Pricing Calculator, Infracost, Cloudviz, diagrams.so) confirms the P1 set. The differentiator nobody else combines: repo URL → editable diagram + monthly cost in one click, guest-first, no user AWS credentials.

**Must have (table stakes, P1):**
- Freeform description input (default, frictionless)
- Repo URL input with README + manifest analysis (the differentiator; heuristic, bounded file set)
- LLM inference → validated service list with rule-based fallback (reliability floor)
- Draw.io diagram with official AWS icons + in-browser preview + `.drawio` download
- Cost estimate from real AWS prices: region picker, per-service + monthly total
- Scale simulator slider (100 → 1M users) with live client-side recalculation
- Guest generation (no login required)

**Should have (P2):**
- Per-service rationale notes ("why S3") — trivial once structured JSON exists
- Optional auth + saved history (re-open past analyses)

**Defer (v2+):**
- AI-modify ("replace RDS with DynamoDB"), IaC generation/upload, multi-cloud, free-tier accounting, PNG/SVG export, full in-app diagram editor (explicit anti-feature — draw.io is free and already the output format)

### Architecture Approach

Thin-client SPA backed by one stateless monolith. `ServicePlan` (shared zod schema) is the contract every boundary crosses: rule engine and LLM both emit it, DiagramService and CostService both consume it. Rules run first (guaranteed baseline, zero keys), LLM enhances, merge by confidence. Diagram XML is generated by construction (deterministic grid layout, no layout library). Server returns prices + quantity formulas; client does all slider math (no network per tick). Auth is a strictly additive last slice.

**Major components:**
1. **RepoFetcher** — GitHub REST: one `git/trees` call + targeted fetch of README/manifests; never a clone
2. **InferenceService** — RuleEngine → LLM → validate → merge into one `ServicePlan`; LLM down = degrade to rules, never break
3. **DiagramService** — pure function `ServicePlan → mxGraph XML` (grid layout, AWS icon styles, escaped labels)
4. **PriceService + CostService** — prices (fetched + cached, defaults as fallback) × per-service quantity models → cost rows
5. **AuthService + SQLite** — optional email/password, history CRUD, guest path never depends on it
6. **Frontend** — input form, results tabs, draw.io embed wrapper, region picker, slider, download

### Critical Pitfalls

1. **Unvalidated LLM output / hallucinated AWS services** — fix with a fixed ~30–40 service catalog (service code enum) that both rules AND LLM emit, validated before any pricing/diagram work (Pitfall 1, Phase 3)
2. **Cheap-LLM JSON assumed reliable (5–12% mismatch)** — flat zod schema, defensive JSON extraction, one corrective retry, then rule fallback; prefer Gemini `responseSchema` (Pitfall 2, Phase 3)
3. **GitHub 60 req/hr wall on shared school IPs** — one server-side PAT (5,000/hr) + per-repo cache; ~7 analyses/hour breaks unauthenticated (Pitfall 4, Phase 2)
4. **AWS pricing region code vs full-name `location` filter + hidden cost dimensions** — static code↔name map; on-demand-only with stated assumptions (no silent zero transfer/NAT); per-service cost models (Pitfalls 6/8, Phase 5)
5. **`.drawio` file draw.io refuses to open / preview never renders** — by-construction XML emitter + golden-file test + manual open in draw.io desktop; embed mode (not the scan-the-DOM viewer script) sidesteps the load-order/CSP class entirely (Pitfalls 9/10, Phase 4)
6. **Secrets in client / SSRF via repo URL** — server-side-only keys, IAM limited to `pricing:*` read, host allowlist (github.com only), timeouts, rate limiting (Pitfalls 11/12, Phases 1–2)

## Implications for Roadmap

The six slices below come directly from ARCHITECTURE's dependency-driven build order, cross-checked against PITFALLS' pitfall-to-phase mapping (which uses the same numbering). The logic: 1→2 proves the output side with fake data before real data; 3→4 is cheap deterministic truth before paid probabilistic enhancement; 5 is placed after the pipeline is stable so cost consumes a settled contract; 6 is last because auth multiplies test surface and adds zero core value.

### Phase 1: Pipeline Skeleton with Canned Input (+ Foundation)
**Rationale:** De-risks the two hardest integrations (mxGraph XML format + draw.io embed postMessage protocol) with zero external dependencies, plus foundation (scaffold, Node 22 pin, IAM policy, env secrets) before any API integration exists. If this slice can't render a pretty AWS diagram in-browser, everything else is moot.
**Delivers:** `ServicePlan` schema, `DiagramService`, draw.io embed wrapper, `.drawio` download, results page with a hardcoded plan.
**Addresses:** diagram + preview + download features.
**Avoids:** secrets-handling pitfall, unopenable-`.drawio` pitfall, viewer-script-order pitfall (use embed mode).

### Phase 2: Real Inputs (Repo + Freeform)
**Rationale:** Real repos produce diagrams; ends-to-end wiring proven with a hardcoded "package.json + Dockerfile ⇒ 3 services" hack before any inference logic.
**Delivers:** RepoFetcher (tree + targeted fetch), freeform path, `POST /api/analyze`; server-side PAT + per-repo cache.
**Addresses:** repo URL + freeform description features.
**Implements:** RepoFetcher component.
**Avoids:** GitHub 60/hr wall, large-file `.raw` media-type footgun, SSRF (host allowlist).

### Phase 3: Rule Engine (Deterministic Inference)
**Rationale:** Cheapest, most reliable inference; app becomes fully demoable offline-ish with zero API keys. The service catalog + validator is the core deliverable here, not an afterthought.
**Delivers:** `ruleEngine.ts` pattern table, catalog enum, confidence scoring; golden-set tests.
**Addresses:** LLM inference + rule fallback feature (the fallback half).
**Avoids:** hallucinated-service and prompt-injection pitfalls (validation-first design).

### Phase 4: LLM Enhancement + Diagram Polish
**Rationale:** Paid probabilistic pass on top of the deterministic baseline; skippable without breaking the demo. Provider JSON-mode specifics (DeepSeek `json_object` quirks — use `@ai-sdk/deepseek`, not the openai-compatible path).
**Delivers:** `llmClient.ts` (temperature 0, ≤3 retries), validator, merger, `generateObject` + zod; golden-file diagram tests + manual draw.io-open check.
**Addresses:** the LLM half of inference; per-service rationale notes come free with the schema.
**Avoids:** JSON parse reliability pitfall (retry → rules fallback chain).

### Phase 5: Cost Engine
**Rationale:** Second half of the core value; deliberately last-of-core so it consumes a stable, well-tested `ServicePlan`. Second risky integration (AWS price data shape) — needs per-service research (see flags).
**Delivers:** PriceService (bulk files + disk cache + defaults), CostService with per-service quantity models, region picker, scale slider, cost tab.
**Addresses:** cost estimate, region picker, scale simulator features.
**Avoids:** region-name-vs-code pitfall, free-tier-as-$0 pitfall (on-demand + disclaimer), hidden-cost-dimensions pitfall (stated assumptions, per-service models).

### Phase 6: Auth + History (Optional)
**Rationale:** Orthogonal to the pipeline; guest path is a hard requirement and must work regardless. Last because it multiplies every other component's test surface.
**Delivers:** better-auth register/login, sessions, history CRUD + page, "log in to save this result" prompt.
**Addresses:** optional auth + saved history (P2).
**Avoids:** history auth-boundary mistakes, guest abuse (per-IP rate limit on generation).

### Phase Ordering Rationale
- **1 → 2 is "prove the output side with fake data, then feed it real data"** — the XML/embed integration is the project's biggest unknown and must not be discovered in the same phase as GitHub fetch.
- **3 → 4 is "cheap deterministic truth before paid probabilistic enhancement"** — rules-first makes the LLM a bonus, not a dependency, and gives the validator ground truth to check the LLM against.
- **5 is placed after 2–4** so CostService consumes a stable contract instead of chasing a moving pipeline; the slider/region UX depends on the quantity model designed with the cost engine.
- **6 is last** because auth contributes zero to the core loop and the pipeline must never reference the user.
- **Guest-first everywhere:** no feature in Phases 1–5 requires a session.

### Research Flags

Phases likely needing `/gsd-research-phase` during planning:
- **Phase 1:** mxGraph XML format specifics + exact draw.io AWS icon style names (`shape=mxgraph.aws4.*`) — verify each icon in the draw.io editor; fall back to `shape=image` + SVG data URI. Also the AWS bulk-files-vs-Query-API decision.
- **Phase 5:** per-service price-file structure (EC2 = per instance type × region; Lambda = per-request + per-GB-s; S3 = per-GB tiers) — map each supported service's `unit` + `perUser` quantity model to a specific file/field before writing CostService.
- **Phase 4 (light):** provider-specific JSON-mode details (Gemini `responseSchema`, Groq/DeepSeek `response_format`) — mostly covered by STACK research; verify at implementation.

Phases with standard patterns (skip research-phase):
- **Phase 2:** GitHub REST contents API is well-documented; patterns are standard.
- **Phase 3:** keyword/pattern rule engines are textbook.
- **Phase 6:** better-auth email/password + SQLite is declarative and documented.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry + official docs 2026-08-07; version-compat matrix explicit (Node 22, sqlite ^12, DeepSeek model rename) |
| Features | MEDIUM-HIGH | Competitor features verified via vendor sites; AI-diagram category moves fast and is MEDIUM |
| Architecture | HIGH | Patterns corroborated by official draw.io embed docs, GitHub REST docs, AWS price docs; anti-patterns well evidenced |
| Pitfalls | MEDIUM-HIGH | Core API facts from official docs (HIGH); failure-rate figures (DeepSeek JSON mismatch) and free-tier details from secondary sources (LOW-MEDIUM) |

**Overall confidence:** HIGH

### Gaps to Address

- **AWS pricing data source conflict:** STACK recommends `@aws-sdk/client-pricing` Query API (needs read-only IAM creds); ARCHITECTURE and PITFALLS recommend the public Bulk API offer files (no credentials at all, larger files, cached). Both work; decision affects Phase 1 foundation (whether an IAM user is even needed). Resolve in Phase 5 research — opinionated lean: bulk files primary + defaults fallback (zero-credential path, matches "no AWS credentials needed from user" positioning), Query API only if on-demand lookups prove necessary.
- **DeepSeek pricing exact figures** (LOW confidence) — verify at api-docs.deepseek.com at implementation; demo budget impact is pennies regardless.
- **Gemini free-tier quotas** (MEDIUM, sources conflict) — live page authoritative; DeepSeek primary makes this a fallback-only concern.
- **Draw.io icon style names** unverified — treat Phase 1 as a spike with fallback to `shape=image` data URIs.
- **Cost estimate accuracy** — validate against AWS Pricing Calculator for one known stack (EC2+RDS+S3) within ~2x; the stated-assumptions contract (no transfer, on-demand) is the honest baseline.
- **`deepseek-v4-flash` behavior** — verified as the current model ID, but its exact JSON-mode reliability is unmeasured; the rules-fallback chain absorbs this risk by design.

## Sources

### Primary (HIGH confidence)
- npm registry (verified 2026-08-07): next@16.3.0, ai@7.0.56, @ai-sdk/* v4, zod@4.4.3, better-auth@1.6.26, better-sqlite3@12.11.1/13.0.3, @aws-sdk/client-pricing@3.1105.0
- drawio.com docs (embed mode, postMessage protocol) + jgraph/drawio-integration
- docs.aws.amazon.com — Price List API (Query + Bulk), pricing CLI reference
- api-docs.deepseek.com — JSON mode, model-name migration (`deepseek-v4-flash` current; `deepseek-chat` retired 2026-07-24)
- GitHub REST docs — contents API size table, rate limits (60/hr unauth, 5,000/hr token), May 2025 changelog
- better-auth.com/docs — SQLite Kysely adapter

### Secondary (MEDIUM confidence)
- vercel/ai issue #7913 — DeepSeek `generateObject` `json_object` gotcha (closed/merged)
- ai.google.dev structured-output docs + free-tier rate limits (quotas cut Dec 2025, Pro behind billing Apr 2026)
- TokenMix / Agenta structured-output guides — DeepSeek JSON 5–12% mismatch, Gemini schema <0.5%
- Pilotcore AWS Price List guide — `location` display-name filter, bulk endpoints
- Cloudcraft / Infracost / Cloudviz / AWS Pricing Calculator feature pages
- diagrams.so, Visual Paradigm, awslabs/diagram-as-code — AI diagram patterns
- jgraph/drawio LICENSE (Apache 2.0 — not the GPL trap), Snyk mxGraph CVE-2019-13127 (escaping discipline)

### Tertiary (LOW confidence)
- Groq free-tier RPM tables (third-party, org-level variance)
- Usage.ai / CostGoat — EC2 free-tier change (2025-07-15, multiple agreeing sources)
- DeepSeek exact per-token pricing — verify at api-docs.deepseek.com

---
*Research completed: 2026-08-07*
*Ready for roadmap: yes*
