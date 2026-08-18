# AWS Architect — Decisions Log

Every decision made for this project, with the "why". Source of truth: `.planning/PROJECT.md` (Key Decisions), `.planning/research/*` for the stack/architecture research, and Resolutions of the 8 pipeline flaws (`Problems.md`).

<!-- GSD:decision-start -->

## How to read

- **Status**: `Locked` = decided and not expected to change (research-backed); `Pending` = committed to, but will be validated in its phase; `Out of Scope` = consciously not built, boundary stated.
- Decisions are grouped: Pipeline & Architecture · Diagram · Inference & LLM · Input & Fetch · Cost · Auth & History · Stack.

---

## Pipeline & Architecture

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 1 | **Thin-client SPA + one monolith server; the pipeline never runs in the browser** | LLM keys, GitHub token, and price caching must stay server-side. Saved history needs a backend anyway. A "client-side proxy" is just a server with CORS pain. | Locked |
| 2 | **One JSON contract `ServicePlan` drives both diagram and cost** | Diagram and cost can never diverge. One shared zod schema module prevents shape drift across every boundary (rules, LLM, diagram, cost, history). | Locked |
| 3 | **Rules-first, LLM-enhances (fallback direction inverted)** | Deterministic rule engine gives a guaranteed no-key baseline; the LLM only improves it. No API key, no budget, no LLM network → the demo still works. | Locked |
| 4 | **LLM never emits diagram XML or prices** | XML is structurally unforgiving (one bad `<` = draw.io rejects the file). LLM outputs only a validated `ServicePlan`; diagram XML and prices are generated deterministically. | Locked |
| 5 | **LLM failure silently degrades to the rules baseline — ≤3 retries, never an error page** | Demo survivability: provider down/unconfigured/malformed output must not break the app. | Locked |
| 6 | **Frontend state = one `useAnalysis()` hook (`useState`/`useMemo`), no state library** | Results are ephemeral component state; a global store is added complexity for nothing. | Locked |
| 7 | **Server-side-only secrets, github.com host allowlist, timeouts, content caps, rate limiting** | SSRF and secret leaks are security boundaries — never simplified away. | Locked |

## Inference & LLM

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 15 | **Inference = LLM-based with rule-based keyword fallback** | Best accuracy with a deterministic safety net. | Locked |
| 16 | **Output contract = the single zod `ServicePlan` schema, identical for every provider via `generateObject`** | Provider-agnostic. A uniform `safeParse` + catalog-allowlist gate precedes any use; failure → rules baseline. **No provider-specific tuning thresholds.** | Locked |
| 17 | **Catalog allowlist (~30–40 fixed service enum)** | A hallucinated service never reaches the diagram or cost. Rule and LLM output are both validated against it. | Locked |
| 18 | **Primary LLM = DeepSeek `deepseek-v4-flash` via `@ai-sdk/deepseek`; Gemini Flash / Groq free tiers as fallbacks** | Cheapest usable API for a demo's worth of calls. The official provider handles DeepSeek's `json_object` quirks (naive openai-compatible path hits vercel/ai#7913). Provider swap = env key/model only. | Locked |
| 19 | **Freeform/description results are capped at the "Low confidence" tier** | Freeform has no code to verify against. `grounding='description'` results show a banner "Inferred from your description only — not verified against code". Repo-grounded results show High/Medium per consensus. | Pending |
| 20 | **Insufficient-signal = explicit advisory, not a silent guess** | If extraction yields **no allowlist manifest/container/CI file AND README < 100 chars**, no inference is attempted: prompt the user to switch to the freeform path, pre-filled with repo name + README snippet. | Pending |
| 21 | **LLM retries capped at 3; temperature 0; JSON mode / responseSchema** | Bounded cost, deterministic-ish output, no runaway loops. | Locked |

## Input & Fetch

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 22 | **Repo analysis = README + key files via GitHub REST, never a full clone** | Fast, cheap, catches the majority of infra signals (80%). One `git/trees?recursive=1` call for the file list + targeted `contents` fetches. | Pending |
| 23 | **Key-file fetch bounded by allowlist + caps** | Depth/size bounds must be deterministic. Key files = fixed allowlist at root or depth ≤1 (README; `package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml, build.gradle, *.csproj`; `Dockerfile, docker-compose.{yml,yaml}, serverless.{yml,yaml}, .github/workflows/*.yml, vercel.json, netlify.toml, terraform/*.tf, template.yaml`). **Caps: 20 files, 64KB raw read/file, 50k-path cap on the tree.** Over-limit files skipped by priority (README → manifests → container/CI), flagged `truncated`/`parse_errors`. | Pending |
| 24 | **Structured files (JSON/YAML) are compacted, never raw-truncated mid-structure** | Compact to the first ~40 top-level entries and re-serialise as well-formed output (stdlib `JSON.parse` for JSON; `yaml` lib for YAML). Unparseable files degrade to **filename-only signal** (`{name, sizeBytes}`) — still feeds the rules baseline. Never feed malformed YAML/XML to the LLM. | Locked |
| 25 | **Freeform description is the default input; guided questionnaire optional** | Both paths converge on one pipeline; keep the default frictionless. | Pending |
| 26 | **Server-side GitHub PAT via env (5,000 req/hr) + per-`owner/repo@sha` evidence cache; unauthenticated path still works (60 req/hr)** | The shared server IP hits the unauthenticated limit first during classroom demos (~7 analyses/hr). | Locked |
| 27 | **SSRF protection: host allowlist (github.com), timeouts, response caps** | Boundary security, not simplified away. Private-repo access is out of scope (needs a token). | Locked |

## Cost

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 28 | **Cost from the real AWS Price List API, on-demand + defaults + region picker** | Free API, accurate prices, minimal user input. Bulk files are public (no credentials) — corrects the earlier assumption that IAM creds are required. | Pending |
| 29 | **Unit prices cached server-side (in-memory, keyed `region:serviceCode:usageType`, TTL 24h)** | Prices change at most weekly; a 24h cache keeps the API out of the hot path. Slider recalculation is a pure function of cached prices. | Pending |
| 30 | **Region switch = on-demand re-fetch of only the planned services (≤12, within the ~10 burst) — ~1–2s typical, ≤3s worst case** | The service count is bounded by template slots, not the catalog, so one burst handles the whole batch. No pre-warming of other regions (wastes API calls). Cost panel shows "Loading prices…" and the slider is disabled during the fetch. Default region = analysis region (us-east-1), so the common path never re-fetches. | Pending |
| 31 | **Cost simulator = client-side math over cached prices/formulas** | Server returns unit price *and* the quantity formula (`users × perUser`); slider ticks recompute 100% client-side — zero network round-trips. | Locked |
| 32 | **Cost baselines are sourced + disclosed, never silent** | Every per-service default carries a `source` in `SERVICE_DEFAULTS.ts` (+ documented in `DEFAULTS.md`): an AWS free-tier limit (Lambda 1M req/mo, S3 5GB, API Gateway 1M req/mo, DynamoDB 25GB, CloudFront 1GB egress, nano/micro instances…) or an explicit "small-app baseline" assumption. The cost screen shows an expandable **Assumptions** list; defaults are **never derived from repo content** and always labeled as assumptions — an unsourced cost number would undermine the whole core value. | Locked |
| 33 | **"Not a bill" disclaimer; on-demand rates only; stated assumptions (no data transfer, no NAT, no free tier)** | Honest estimate framing; validated that a known EC2+RDS+S3 stack lands within ~2x of AWS Pricing Calculator. | Pending |
| 34 | **Unpriced services shown separately with a note — never silently missing from the total** | Transparency over silent omission. | Pending |

## Auth & History

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 35 | **Optional login; generation works fully as a guest; auth built last (Phase 6)** | Guest path is a hard requirement; auth multiplies test surface and adds zero to the core loop. | Locked |
| 36 | **better-auth email/password (declarative); never hand-rolled sessions/hashing/CSRF** | Security is exactly what you never simplify away. next-auth's Credentials provider is fiddly, so better-auth wins for email/password-first. | Locked |
| 37 | **SQLite via better-sqlite3 (pin ^12) + built-in Kysely adapter; two tables, no ORM** | One file, zero ops. `better-auth@1.6.26` declares peer `better-sqlite3@^12`, so pin ^12, not 13. Prisma/Postgres/Redis/Docker are order-of-magnitude overkill. | Locked |
| 38 | **History = exact frozen snapshot stored at save time** | Schema: `analyses(id, user_id?, input_kind, input, grounding, service_plan JSON, diagram_xml TEXT, cost_snapshot JSON, created_at)`. Reopening **never** re-queries prices or re-runs inference; the slider scales client-side from snapshot quantities only. Re-analysis = a new row. | Pending |
| 39 | **`input_kind` (what was pasted) and `grounding` (what inference ran on) are separate fields** | They can differ — a repo whose repo-content path failed and fell back to its description is `input_kind='repo', grounding='description'`. Separating them avoids the "user chose freeform" vs "repo degraded" ambiguity without a third enum state. | Locked |

## Stack

| # | Decision | Why | Status |
|---|----------|-----|--------|
| 40 | **Next.js 16 (App Router) + React 19 + TypeScript on Node 22 LTS** | One process serves UI + API routes; server-side code is mandatory (keys). Node 22 satisfies every dependency's engine constraint (AI SDK v7, `@ai-sdk/*` v4, `better-sqlite3`). | Locked |
| 41 | **Vercel AI SDK v7 + zod 4** | `generateObject` + zod schema = structured JSON with schema enforcement and auto-retry in one code path for every provider. zod 4 satisfies the `ai@7` peer range. | Locked |
| 42 | **`@aws-sdk/client-pricing` (GetProducts, Query API)** | Official SDK; server-side only. Preferred for on-demand lookups; public bulk files are the zero-credential alternative. | Locked |
| 43 | **Native `fetch` for GitHub; no octokit/axios/isomorphic-git** | GitHub REST does everything (README + key files); a clone is slower and heavier. | Locked |
| 44 | **tailwindcss 4 optional for UI (CSS-first config); not load-bearing** | Fine default; plain CSS is acceptable — this is not a decision that matters. | Locked |
| 45 | **Deployment = local/university-hosted demo; no CI/CD, no multi-tenancy** | Out of Scope — the project is a university demo with low traffic. | Out of Scope |

<!-- GSD:decision-end -->

---
*Last updated: 2026-08-12 — consolidated from PROJECT.md Key Decisions, research/**, and flaw resolutions 1–8.*