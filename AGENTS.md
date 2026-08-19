<!-- GSD:project-start source:PROJECT.md -->
## Project

**AWS Architect**

A webapp where a user submits a GitHub repo OR a plain project idea/description, and the app infers the AWS services that deployment would need, generates a draw.io deployment diagram, and produces a monthly cost estimate. Users can generate and download everything without logging in; a simple login exists for saved history. Built for a university SGP project — expected traffic is low.

**Core Value:** Given a repo or idea, produce a correct AWS service map with a downloadable draw.io diagram and a realistic monthly cost estimate.

### Constraints

- **Tech stack**: Undecided — researcher will pick (framework, draw.io rendering lib, pricing API client, LLM SDK). No preference from user.
- **Cost**: No budget; prefer free tiers and cheap LLM providers.
- **Scope**: University project — simplicity and reliability over scale.
- **AWS credentials**: App needs IAM credentials for the Price List API (read-only, free tier).
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended | Confidence |
|------------|---------|---------|-----------------|------------|
| **Node.js** | 22 LTS | Runtime | Only version satisfying the whole stack: `next` ≥20.9, AI SDK v7 and all `@ai-sdk/*` v4 providers require ≥22, `better-sqlite3` v12 requires 20+. Pin 22, not 24 — LTS, matches engines of every dep. | HIGH |
| **Next.js** (App Router) + **React 19** + **TypeScript** | next 16.3.0 | Full-stack framework | One process serves UI + API routes. Server-side code is **mandatory** here: AWS IAM credentials, LLM keys, and GitHub calls must never reach the browser. Next.js Route Handlers give us that with zero extra backend. Standard 2026 React framework; React 19.2 bundled. | HIGH |
| **Vercel AI SDK** (`ai`) | 7.0.56 | LLM abstraction | `generateObject` + zod schema = structured JSON extraction with schema enforcement and auto-retry, one code path for every provider. This directly satisfies the "structured JSON extraction" decision; provider swaps are an env-var change. Standard for TypeScript LLM apps in 2026. | HIGH |
| **`@ai-sdk/deepseek`** | 3.0.24 | Primary LLM provider | Cheapest usable API (~$0.28/M input, ~$0.42/M output for flash — LOW confidence on exact price, verify at api-docs.deepseek.com). Official AI SDK provider handles DeepSeek's `json_object` quirks (the naive openai-compatible path hits a real bug — see What NOT to Use). Model: **`deepseek-v4-flash`** — `deepseek-chat`/`deepseek-reasoner` were retired 2026-07-24. | HIGH (model name) / LOW (price) |
| **`@ai-sdk/google`** | 4.0.37 | Fallback LLM provider | `gemini-2.5-flash` has a real free tier (no card). Strongest structured output of the three: Gemini `responseSchema` guarantees JSON. Google's JS provider for the AI SDK maps zod directly to responseSchema. Free tier excludes commercial use and may train on data — fine for a university demo. | HIGH (SDK) / MEDIUM (exact free-tier quotas — cut Dec 2025, Pro models moved behind billing Apr 2026, numbers in third-party tables conflict) |
| **`@ai-sdk/groq`** | 4.0.24 | Zero-budget fallback | Genuinely free tier, no card, ~30 RPM per model — ample for a demo. Structured outputs: strict `json_schema` on a few models, `json_object` on all. | HIGH (SDK) / MEDIUM (exact RPM — org-level, model-dependent) |
| **zod** | 4.4.3 | Schema validation | Single source of truth: the same schema drives `generateObject` output validation AND request/response validation at the API boundary. AI SDK v7 peer range is `^3.25.76 \|\| ^4.1.8` → zod 4.x is supported. | HIGH |
| **`@aws-sdk/client-pricing`** | 3.1105.0 | Real AWS prices | Official AWS SDK v3 Pricing client (`PricingClient` + `GetProductsCommand`, `TERM_MATCH` filters). Server-side only (needs IAM creds). API is free; rate limit ~5 req/s is ample. | HIGH |
| **better-auth** | 1.6.26 | Optional email/password login | Modern standard for TypeScript auth; email/password is first-class (`emailAndPassword.enabled`), sessions/CSRF/password hashing handled correctly (never hand-roll auth). Guest-first: no middleware blocking — only `/history` requires a session. SQLite via built-in Kysely adapter (see below). Works with Next 14–16. | HIGH |
| **better-sqlite3** | ^12.11.1 | Database | Zero-config single-file SQLite; synchronous API is fine at this scale. **Pin ^12, not 13** — better-auth 1.6.26 declares peer `better-sqlite3@^12.0.0`; v13.0.3 (latest) is outside that range and would emit peer conflicts. Stores auth tables (better-auth) + `analyses` history table. | HIGH |
| **draw.io embed** (no npm package) | embed.diagrams.net | Diagram preview | Official, documented embed mode: `<iframe src="https://embed.diagrams.net/?embed=1&proto=json&saveAndExit=0&noSaveBtn=1&noExitBtn=1">`, wait for the `init` event, then `postMessage({action:'load', xml:'<mxfile>…'})`. Read-only-ish preview (buttons hidden) and accepts raw draw.io XML. No bundling of mxGraph source — that path breaks under bundlers (`document.write`). | HIGH |
### Supporting Libraries
| Library | Version | Purpose | When to Use | Confidence |
|---------|---------|---------|-------------|------------|
| tailwindcss | 4.x | UI styling | Recommended default for the UI layer; v4 is the 2026 standard (CSS-first config). Skip if you prefer plain CSS — not load-bearing. | MEDIUM |
| (none — native `fetch`) | — | GitHub repo fetch | `fetch` to `api.github.com` suffices: `GET /repos/{owner}/{repo}` → default branch; `GET /repos/{owner}/{repo}/readme` (Accept: `application/vnd.github.raw`); `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1` → file list; `GET /contents/{path}` for key files (package.json, Dockerfile, compose, serverless.yml). Unauthenticated limit 60 req/hr per IP — fine for a demo. | HIGH |
| (none — in-memory `Map`) | — | Pricing cache | Cache `GetProducts` results keyed by service+region to avoid hammering the API and to keep the slider recomputation instant. No cache lib needed. | HIGH |
| (none — React `useMemo` + state) | — | Cost slider | Slider quantity → live cost is pure client-side math over the fetched unit prices. No state library. | HIGH |
### Development Tools
| Tool | Purpose | Notes |
|------|---------|-------|
| Node 22 LTS | Runtime | `.nvmrc`/`.node-version` = `22`. Do not use Node 24 for the demo. |
| `npx @better-auth/cli generate` | Generate auth SQL schema | Runs the SQL schema for users/sessions/accounts against SQLite. Then hand-write the `analyses` table (one `CREATE TABLE`). |
| TypeScript 5.x | Language | Strict mode. Types flow: zod schema → `generateObject` result → API response → diagram XML. |
| `.env.local` | Secrets | `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (read-only IAM user, policy: `pricing:GetProducts` etc.), `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `GITHUB_TOKEN` (optional), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`. |
| IAM user (AWS console) | Pricing API access | Free-tier account suffices. Policy: `pricing:DescribeServices`, `pricing:GetAttributeValues`, `pricing:GetProducts` on `*`. No billing plan needed. |
## Installation
# Runtime: Node 22 LTS (required by AI SDK v7 / @ai-sdk/* v4)
# Scaffold
# Core
# kysely is pulled in by better-auth automatically (built-in Kysely adapter)
# Auth schema (then add your own `analyses` table)
# Run
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Next.js full-stack | Vite SPA + Express/Fastify backend | If you want client/server separation or a non-Node backend. For this app it's two processes where one suffices — avoid. |
| Node + `@aws-sdk/client-pricing` | Python + boto3 | If the team is Python-strong. Otherwise keep one language; boto3 is not easier here. |
| better-sqlite3 | Prisma + SQLite, Postgres | If you need multi-table relational logic or migrations at scale. One auth-generated schema + one history table doesn't justify an ORM. |
| better-auth | Auth.js (next-auth v5) | next-auth's Credentials provider is notoriously fiddly (custom JWT sessions, callbacks). better-auth's email/password is declarative. Use next-auth only if you need its huge OAuth provider list. |
| Vercel AI SDK | Raw `openai` SDK for DeepSeek+Groq, `@google/genai` for Gemini | If you want zero abstraction. You'd write two different call paths and hand-roll JSON validation — the AI SDK does it in one. |
| `generateObject` + zod | Prompt "return JSON" + `JSON.parse` | If you want flaky output and regex scraping. Never for structured extraction feeding downstream code. |
| embed.diagrams.net iframe | viewer.diagrams.net | viewer.diagrams.net is read-only (URL-hosted diagrams) but its XML-load params are less documented. Embed mode is the officially documented postMessage API and accepts raw XML — use it; verify viewer params only if you need truly zero chrome. |
| @ai-sdk/groq (direct) | OpenRouter aggregator | OpenRouter adds a middleman with its own markups/limits. The three direct providers here are already free or near-free. |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `deepseek-chat` / `deepseek-reasoner` model IDs | **Retired 2026-07-24** — they now 400/route nowhere. Current IDs are `deepseek-v4-flash` / `deepseek-v4-pro`. | `deepseek-v4-flash` |
| `@ai-sdk/openai-compatible` pointed at DeepSeek with `generateObject` | Known failure (vercel/ai#7913): DeepSeek requires the literal word "json" in the prompt for `json_object` mode, and its API rejects `json_schema` response_format for final messages. `@ai-sdk/deepseek` ships the correct handling. | `@ai-sdk/deepseek` |
| Bundling mxGraph / draw.io source (`app.min.js` from jgraph CDN, y-mxgraph) | Heavy, pollutes globals, and `document.write` CSS injection crashes under Next/Vite. Maintenance nightmare for a preview-only feature. | embed.diagrams.net iframe |
| ReactFlow / Cytoscape / Mermaid | We render one read-only diagram; these build editors or render different formats. draw.io XML is the output contract — render it with the official viewer. | embed.diagrams.net |
| Prisma / Postgres / Redis / Docker | Order-of-magnitude overkill for 2 tables and a university demo. | better-sqlite3 file |
| axios / isomorphic-git / octokit | Native `fetch` and the GitHub REST API do everything (README + ~6 key files). A git clone is slower and heavier. | native `fetch` |
| zustand / redux | Slider + results state is local component state. | `useState` / `useMemo` |
| NextAuth (Auth.js v5) for email/password | Credentials provider requires hand-rolled session callback plumbing and JWT config. | better-auth |
| Hand-rolled bcrypt/session auth | Security is exactly what you never simplify away. Password hashing, session rotation, CSRF — do not write these. | better-auth |
## Stack Patterns by Variant
- Use Groq free tier as primary (`@ai-sdk/groq`), Gemini free tier as fallback. One-line env change in the provider factory; the zod schema and `generateObject` call stay identical.
- Make DeepSeek the primary (it is, above). DeepSeek charges pennies; a demo's worth of calls is cents.
- Replace the embed iframe with a self-hosted draw.io viewer or pre-rendered PNG/SVG export of the diagram. Flag: this loses the interactive preview; acceptable only for a recorded demo.
- Add `GITHUB_TOKEN` env var — done in one line, raises to 5,000 req/hr. If GitHub itself is down/unreachable, fall back to rule-based inference on the freeform description path (no repo content).
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `better-auth@1.6.26` | `better-sqlite3@^12.0.0` (peer) | Latest better-sqlite3 is **13.0.3** — outside the peer range. Pin `^12.11.1` to avoid peer warnings/conflicts. (v13 is likely API-compatible via kysely's SqliteDialect but unverified — don't gamble.) |
| `ai@7.0.56` | `zod@^3.25.76 \|\| ^4.1.8` | zod 4.4.3 satisfies. Use zod 4, not 3. |
| `ai@7.0.56`, `@ai-sdk/*@4.x` | Node ≥ 22 | Hard engine requirement. Node 20 will refuse to install. |
| `next@16.3.0` | Node ≥ 20.9, React 19.x | React 19.2 comes with the scaffold; TypeScript 5.x. |
| `better-auth@1.6.26` | `next@^14–16`, `react@^18–19` | Satisfied by the Next 16 / React 19 scaffold. |
| `@aws-sdk/client-pricing@3.1105.0` | Node ≥ 20 | Fine on Node 22. Pricing API `GetProducts` uses `location` filter values like `"US East (N. Virginia)"` — you need a region-code → location-name map for the region picker. |
## Sources
- npm registry (verified 2026-08-07): `next@16.3.0`, `ai@7.0.56`, `@ai-sdk/deepseek@3.0.24`, `@ai-sdk/google@4.0.37`, `@ai-sdk/groq@4.0.24`, `@ai-sdk/openai-compatible@3.0.25`, `@google/genai@2.16.0`, `zod@4.4.3`, `better-auth@1.6.26`, `better-sqlite3@13.0.3` (latest) / `12.11.1` (recommended), `@aws-sdk/client-pricing@3.1105.0` — **HIGH**
- drawio.com/docs/reference/embed-mode + github.com/jgraph/drawio-integration — embed mode iframe + postMessage protocol (init/load/save), `proto=json`, button-hiding params — **HIGH**
- docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/pricing + api docs for `GetProducts`/`DescribeServices` — **HIGH**
- api-docs.deepseek.com (JSON Output guide, model-name migration notice) — `deepseek-v4-flash` current, `deepseek-chat` retired 2026-07-24 — **HIGH**
- vercel/ai issue #7913 — DeepSeek `generateObject` json_object gotcha and the shipped fix — **MEDIUM** (issue thread, closed/merged)
- console.groq.com/docs/structured-outputs — json_schema vs json_object modes, model support — **HIGH**; Groq free-tier RPM tables (third-party) — **LOW**
- ai.google.dev structured-output docs + free-tier rate-limit pages — Gemini responseSchema/zod; free-tier covers Flash only, Pro moved behind billing Apr 2026 — **MEDIUM** (exact quotas conflict across sources; live page authoritative)
- better-auth.com/docs/adapters/sqlite — built-in Kysely adapter + `@better-auth/cli generate` — **HIGH**
- pilotcore.io AWS Price List API guide — IAM policy shape, Query API endpoints — **MEDIUM**
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd:quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd:debug` for investigation and bug fixing
- `/gsd:execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd:profile-user` to generate your developer profile.
> This section is managed by `generate-Codex-profile` -- do not edit manually.
<!-- GSD:profile-end -->
