## Slide 1 — Introduction & Motivation

**Description:** What the project is, why the problem matters, and why this topic was chosen.

**Bullets:**
- **What it is:** A webapp that converts a GitHub repo URL OR a freeform description into three deliverables: inferred AWS service map, downloadable draw.io deployment diagram, realistic monthly cost estimate from real price data.
- **The problem is manual:** Today, planning AWS means juggling the Console, Pricing Calculator, icon libraries, and spreadsheets — slow, error-prone, intimidating for students/solo devs/startups.
- **Costs bite later:** The real monthly bill is only discovered after building; architecture and cost are decided in different tools, at different times.
- **Why this topic:** Intersection of cloud architecture, LLM-based inference, and cost engineering — demonstrable single-click value: *paste input → diagram + price*.
- **Constraints:** University project — low traffic, zero budget, free tiers, simplicity over scale.

---

## Slide 2 — Problem Statement

**Description:** The specific gap this project fills.

**Bullets:**
- **Too many disconnected tools:** Diagram tools don't price; cost tools don't draw; none start from a repo or plain idea.
- **You must already know your architecture:** Existing tools (Cloudcraft, AWS Calculator, Infracost) need a live account, manual modeling, or IaC setup first.
- **Signup/credential walls:** Most tools demand an account, AWS credentials, or IaC before giving any value.
- **One-line problem:** *There is no simple way to paste a repo or idea and get both the AWS architecture diagram and a realistic monthly cost — without an account or AWS credentials.*

---

## Slide 3 — Proposed System & Objectives

**Description:** What we build and the testable objectives it must meet.

**Bullets:**
- Two input modes (repo URL / freeform) → one analysis pipeline.
- Deterministic **rule engine runs first** (works with zero API keys); a cheap **LLM enhances** it; output validated against a fixed service catalog.
- One typed JSON contract (`ServicePlan`) drives both diagram and cost — they can never diverge.
- Draw.io preview + downloadable `.drawio`; cost table with region picker + scale slider; guest-first with optional login for history.

**Objectives:**
1. **Input** — repo URL or description → `POST /api/analyze`.
2. **Inference** — structured, schema-validated service list from rules; LLM merges on top; out-of-catalog output rejected with fallback.
3. **Diagram** — deterministic draw.io XML with official AWS icons; preview + download.
4. **Cost** — real AWS prices, region picker, per-service breakdown + total, "not a bill" disclaimer.
5. **Scale Simulator** — user-count slider scales quantities and recalculates live, client-side.
6. **Auth & History** — full generation as guest; optional login saves/reopens own analyses.

---

## Slide 4 — Methodology

**Description:** SDLC approach, tools, and locked tech stack.

**Bullets:**
- **Agile / phase-driven delivery** — 6 dependency-driven phases, each a demoable slice; research done first to de-risk.
- **Ordering rationale:** prove output side with canned data (Phase 1) before real data; deterministic rules before paid LLM; auth last — guest path never depends on it.
- **Key tools:** GitHub REST API (no full clone) · AWS Price List Bulk API (public, no credentials) · draw.io embed iframe (official postMessage) · Vercel AI SDK `generateObject` for schema-enforced LLM output.
- **Tech stack (locked, HIGH confidence):** Next.js 16 + React 19 + TS on Node 22 LTS · AI SDK v7 + zod 4 · DeepSeek `deepseek-v4-flash` primary (Gemini/Groq free-tier fallbacks) · better-sqlite3 ^12 + better-auth · draw.io embed (never bundle mxGraph).

---

## Slide 5 — System Design

**Description:** ERD, use cases, and monolith architecture.

**Bullets:**
- **Data (SQLite, two tables):** `users` (id, name, email, password_hash) · `analyses` (id, user_id nullable, input, service_plan, diagram_xml, cost_snapshot) — one user → many analyses; guests persist nothing.
- **Guest (no session):** generate from repo/description, download `.drawio`, adjust region/slider.
- **Logged-in user:** all guest actions plus save / list / re-open / delete own analyses.
- **Architecture (thin SPA → monolith server):** browser (form, tabs, draw.io iframe, client-side slider math) → `/api/analyze`, `/api/prices`, auth + history routes → service layer (RepoFetcher → Inference → ServicePlan → Diagram/Cost/Auth) → SQLite + disk cache → GitHub · LLM · AWS pricing CDN (**browser never talks to externals directly**).
- **Keystone:** `ServicePlan` — the single typed contract every boundary crosses.

---

## Slide 6 — Implementation Highlights

**Description:** Key modules and the core algorithm (planned design).

**Bullets:**
- **RepoFetcher** — `owner/repo` → one `git/trees` call → fetch only README + key manifests; never a full clone.
- **RuleEngine** — deterministic keyword/pattern table with confidence scoring; zero API keys.
- **LLMClient** — provider-agnostic structured-JSON, temperature 0, bounded retries (≤3).
- **InferenceService** — rules first (guaranteed baseline) → LLM enhance → validate against catalog → merge; LLM failure silently degrades to rules, never an error page.
- **DiagramService** — pure function `ServicePlan → mxGraph XML`, deterministic grid layout.
- **PriceService + CostService** — bulk price files cached per (service, region); quantity models × unit price; client recomputes live.
- **AuthService + SQLite** — better-auth email/password, sessions, history CRUD.

**Key algorithm — fallback chain:**
- `baseline = ruleEngine(evidence)` (never fails) → `llm = llmClient(...)` (≤3 retries) → `merge(baseline, validate(llm))`; any failure returns baseline.
- **Catalog allowlist:** both rule and LLM output validated against a fixed ~30–40 service enum before any diagram/cost work.
- **Deterministic output:** diagram XML by construction (LLM never writes XML or prices); same input → byte-identical output.
- **Live slider math:** server returns prices + formulas once; ticks recompute 100% client-side.

---

## Slide 7 — Challenges Faced & Solutions

**Description:** Design decisions driven by known failure modes.

**Bullets:**
- **LLM JSON unreliability** → flat zod schema + catalog allowlist + rules fallback — a hallucinated service never reaches diagram or cost.
- **GitHub 60 req/hr rate wall** → server-side PAT + per-repo evidence cache; unauthenticated path still works.
- **AWS pricing region/location confusion + hidden cost dimensions** → static code↔location map, on-demand-only pricing with stated assumptions, "not a bill" disclaimer.
- **`.drawio` files draw.io refuses to open** → by-construction XML emitter + golden-file tests; official embed iframe.
- **Secrets exposure & SSRF** → server-side-only keys, github.com host allowlist, timeouts, content caps, rate limiting.
- **DeepSeek model-ID retirement (2026-07-24)** → current `deepseek-v4-flash`; provider swap is a one-line env change.
- **Anti-patterns avoided:** LLM never emits XML/prices · no unvalidated `JSON.parse` · price caching + defaults · pipeline never client-side · auth built last.

---

## Slide 8 — Conclusion & Future Scope

**Description:** The contribution and what comes after v1.

**Bullets:**
- **Contribution:** closes the diagram/cost silo — *paste repo or idea → validated AWS service map → editable draw.io diagram + realistic monthly cost*, guest-first, no user credentials.
- **Reliability by design:** rules-first baseline, catalog validation, retry→fallback chain, deterministic XML — engineered to not break at the demo.
- **Low cost by design:** free-tier LLMs, free public price data, one-process monolith, SQLite.
- **Planned delivery:** 6 dependency-driven phases, 21 v1 requirements, all traced; research complete at HIGH confidence; **Phase 1 (pipeline skeleton) is next.**

**Future scope (deferred):** AI-modify via natural language · IaC generation · PNG/SVG export · free-tier accounting · multi-cloud · guided questionnaire · per-service rationale notes · CI/CD cost-diff.
