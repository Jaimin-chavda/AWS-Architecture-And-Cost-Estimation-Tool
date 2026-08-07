# Roadmap

**Project:** AWS Architect
**Milestone:** v1 — repo/idea → AWS service map → draw.io diagram + monthly cost estimate
**Granularity:** standard (5-8 phases)

## Phases

- [ ] **Phase 1: Pipeline Skeleton (Canned Input + Foundation)** - ServicePlan contract, diagram XML generator, draw.io embed preview, `.drawio` download — proven with hardcoded data, zero external deps
- [ ] **Phase 2: Real Inputs (Repo + Freeform)** - GitHub repo fetch (README + key manifests, PAT + cache, SSRF allowlist) and freeform description, both converging on one analyze pipeline
- [ ] **Phase 3: Rule Engine (Deterministic Inference)** - keyword/pattern rule engine + fixed service catalog + validator; app fully works with zero API keys
- [ ] **Phase 4: LLM Enhancement + Diagram Polish** - `generateObject` + zod LLM pass merged over rules, catalog validation with retry→rules-fallback; golden-file diagram tests
- [ ] **Phase 5: Cost Engine** - real AWS prices (bulk files + cache + defaults), region picker, per-service cost rows, user-count slider with live recalculation
- [ ] **Phase 6: Auth + History (Optional)** - better-auth email/password login, saved analyses with re-open; guest path regression-verified

## Phase Details

### Phase 1: Pipeline Skeleton (Canned Input + Foundation)
**Goal**: A hardcoded sample analysis produces a working AWS deployment diagram — rendered in-browser and downloadable as a `.drawio` file that opens in real draw.io — before any external API exists.
**Depends on**: Nothing (first phase)
**Requirements**: DIAG-01, DIAG-02, DIAG-03, DIAG-04
**Success Criteria** (what must be TRUE):
1. Opening the results page renders a draw.io deployment diagram with official AWS icons in-browser (embed iframe) for a hardcoded `ServicePlan` — works with no GitHub/LLM/AWS calls or keys configured
2. User can download the diagram as a `.drawio` file that opens correctly in real draw.io (desktop or web) — not just in our own preview
3. The diagram is generated deterministically from one typed `ServicePlan` contract: same plan in, byte-identical XML out; the schema that later carries cost data already drives the diagram (diagram and cost can never diverge)
4. The app runs on Node 22 with all secrets (LLM keys, GitHub token, AWS creds if used) server-side in env files only — no keys in the client bundle or repo (IAM policy scoped to pricing read if the Query API path is taken)
**Plans**: TBD (research flag: verify mxGraph XML format + `shape=mxgraph.aws4.*` icon style names; fallback `shape=image` + SVG data URI. Resolve bulk-files-vs-Query-API decision)

### Phase 2: Real Inputs (Repo + Freeform)
**Goal**: User can paste a GitHub repo URL or a freeform description and get a diagram for their actual input; both paths feed one pipeline.
**Depends on**: Phase 1
**Requirements**: INPT-01, INPT-02, INPT-03
**Success Criteria** (what must be TRUE):
1. User pastes a GitHub repo URL → app fetches the README plus key manifests (package.json, Dockerfile, docker-compose, serverless.yml) and produces a diagram for that repo (hardcoded evidence→services mapping is acceptable until Phase 3)
2. User pastes a freeform project description → gets a result of the same shape without any GitHub access
3. Both input modes converge: the same analysis pipeline consumes both, and both produce the same downstream output (diagram, later cost) — one `POST /api/analyze` boundary
4. Malicious or invalid URLs are rejected (github.com host allowlist, no SSRF); repos with missing files or huge blobs degrade gracefully instead of erroring (README-only analysis, `.raw` media type, content caps)
5. A batch of ~10 repo analyses from one server IP succeeds without GitHub 403s (server-side PAT if configured + per-repo cache; unauthenticated path still works without a token)
**Plans**: TBD

### Phase 3: Rule Engine (Deterministic Inference)
**Goal**: The app infers a validated, structured AWS service list from repo files or descriptions using pure rules — no API keys required.
**Depends on**: Phase 2
**Requirements**: INF-01, INF-02, INF-05
**Success Criteria** (what must be TRUE):
1. Analyzing a repo with, e.g., a Dockerfile + docker-compose yields container services (ECS/Fargate); a `serverless.yml` yields Lambda — rule matches produce correct services with zero API keys configured
2. The app emits a structured service list (service code + quantity model + evidence + confidence) and validates it against the fixed ~30-40 service catalog BEFORE any diagram or cost generation — out-of-catalog services are rejected/dropped with a visible note
3. The full pipeline (input → inference → diagram) works with no LLM key and no LLM network access — rules output alone drives a valid diagram
4. Golden-set test: 10 varied inputs (repos + descriptions) all produce outputs whose every service is in the catalog enum — no free-text names ever reach downstream
**Plans**: TBD

### Phase 4: LLM Enhancement + Diagram Polish
**Goal**: A cheap/free LLM improves inference on top of the rules baseline, safely — hallucinated services never reach the diagram or cost table.
**Depends on**: Phase 3
**Requirements**: INF-03, INF-04
**Success Criteria** (what must be TRUE):
1. With an LLM key configured, a freeform description produces a richer service list than rules alone (services the rules missed are present, confidence-weighted merge)
2. LLM output is validated against the catalog: a deliberately wrong/hallucinated service sample is rejected, and the app falls back to the rule-based result instead of crashing or showing bogus services
3. If the LLM provider is down, unconfigured, or returns malformed JSON after ≤3 retries, the app silently degrades to the rules-only result — no error page, diagram still generated
4. Downloaded `.drawio` files open correctly in real draw.io (golden-file test + manual open check), and the preview renders in the real app shell (embed mode, not a bare-HTML spike)
**Plans**: TBD (light research flag: provider JSON-mode specifics for `generateObject`)

### Phase 5: Cost Engine
**Goal**: User sees a realistic monthly cost estimate from real AWS price data, adjustable by region and user scale — alongside the diagram they already get.
**Depends on**: Phase 2 (needs settled ServicePlan; consumes Phases 1-4 output)
**Requirements**: COST-01, COST-02, COST-03, COST-04, SIM-01, SIM-02
**Success Criteria** (what must be TRUE):
1. After analysis, the user sees a per-service cost breakdown and monthly total derived from real AWS price data (public bulk offer files primary, cached; hardcoded defaults as fallback) for the detected services
2. User selects a region via picker (default us-east-1) → prices and totals update for that region (code↔location-name map correct; prices visibly change)
3. User drags the user-count slider (100 → 1M) → service quantities scale per a per-service model (requests/user, GB/user, instance counts) and the total recalculates live with zero network round-trips per tick
4. The cost output is explicitly labeled an estimate: on-demand rates, stated assumptions (no data transfer, no NAT, no free-tier), and a known-stack estimate (EC2+RDS+S3) lands within ~2x of AWS Pricing Calculator
5. Services detected but not priced are shown separately with a note — never silently missing from the total
**Plans**: TBD (research flag: per-service price-file structure — EC2/Lambda/S3 — map each service's `unit` + `perUser` model to a specific file/field before writing CostService)

### Phase 6: Auth + History (Optional)
**Goal**: Optional email/password login saves analysis history; guests keep full functionality — auth is strictly additive.
**Depends on**: Phase 2 (whole pipeline must exist; auth contributes zero to the core loop)
**Requirements**: AUTH-01, AUTH-02, AUTH-03
**Success Criteria** (what must be TRUE):
1. Guest generation regression-verified: a user generates diagram + cost with no login and no session — the full pipeline works exactly as before auth existed
2. User can create an account with email/password and log in (better-auth, declarative)
3. A logged-in user can save an analysis (input, service list, diagram, cost) and re-open it from a history list — diagram and cost restore correctly
4. History is user-scoped: a logged-in user sees only their own analyses
5. Guest generation is throttled (per-IP rate limit on the analyze endpoint) so a burst of ~15 anonymous generations is limited — cheap LLM key stays safe
**Plans**: TBD

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Pipeline Skeleton (Canned Input + Foundation) | 0/0 | Not started | - |
| 2. Real Inputs (Repo + Freeform) | 0/0 | Not started | - |
| 3. Rule Engine (Deterministic Inference) | 0/0 | Not started | - |
| 4. LLM Enhancement + Diagram Polish | 0/0 | Not started | - |
| 5. Cost Engine | 0/0 | Not started | - |
| 6. Auth + History (Optional) | 0/0 | Not started | - |

## Research Flags for Plan-Phase

- **Phase 1**: mxGraph XML format spec + exact draw.io AWS icon style names (`shape=mxgraph.aws4.*`); verify each icon in the draw.io editor, fall back to `shape=image` + SVG data URI. Also resolve AWS pricing data source (bulk files vs Query API) — affects whether an IAM user is needed at all.
- **Phase 5**: per-service price-file structure (EC2 = per instance type × region; Lambda = per-request + per-GB-s; S3 = per-GB tiers) — map each supported service's `unit` + `perUser` quantity model to a specific file/field before writing CostService.
- **Phase 4** (light): provider JSON-mode specifics (DeepSeek `json_object` quirks, Gemini `responseSchema`) — verify at implementation.

---
*Roadmap created: 2026-08-07*
