# Architecture Research

**Domain:** AWS deployment diagram + cost estimation webapp (repo/idea → service map → draw.io diagram + monthly cost)
**Researched:** 2026-08-07
**Confidence:** HIGH

## Standard Architecture

### System Overview

The product is a thin-client SPA backed by one monolith server. The entire analysis pipeline (GitHub fetch → inference → diagram XML → cost) runs server-side because every stage either needs secrets (LLM key), needs caching (AWS prices), needs to be callable with no credentials at the app layer (draw.io embed iframe is the only client-rendered piece), or feeds saved history. The client is responsible only for forms, live slider arithmetic, and rendering the diagram XML in a draw.io embed iframe.

```
┌────────────────────────────────────────────────────────────────────┐
│                          BROWSER (SPA)                              │
│  ┌────────────┐  ┌──────────────┐  ┌───────────────────────────┐   │
│  │ Input form │  │ Results page │  │ draw.io embed <iframe>    │   │
│  │ repo URL / │  │ (diagram tab │  │ https://embed.diagrams.net│   │
│  │ description│  │  / cost tab) │  │  (postMessage protocol)   │   │
│  └─────┬──────┘  └──────┬───────┘  └────────────┬──────────────┘   │
│        │  HTTP/JSON     │   slider/region       │  load XML          │
└────────┼────────────────┼───────────────────────┼───────────────────┘
         ↓                ↓ (re-fetch cost)       ↑
┌────────┼────────────────┼───────────────────────┼───────────────────┐
│        │         API LAYER (monolith server)    │                   │
│  ┌─────┴─────┐  ┌───────────────┐  ┌────────────┴────────────┐      │
│  │ AuthRoute │  │ AnalyzeRoute  │  │ PriceRoute              │      │
│  │ /login    │  │ POST /analyze│  │ POST /prices            │      │
│  │ /register │  │ POST /history│  │ (servicePlan + region)   │      │
│  └─────┬─────┘  └──────┬────────┘  └────────────┬────────────┘      │
├────────┼───────────────┼────────────────────────┼───────────────────┤
│        │       SERVICE LAYER                    │                   │
│  ┌─────┴──────┐  ┌─────┴──────────┐  ┌──────────┴───────────┐       │
│  │ AuthService│  │ RepoFetcher    │  │ PriceService         │       │
│  │ (sessions) │  │ (GitHub REST)  │  │ (public bulk files + │       │
│  └────────────┘  └─────┬──────────┘  │  cache, defaults)    │       │
│                        ↓              └──────────┬───────────┘       │
│  ┌────────────┐  ┌─────┴──────────┐  ┌──────────┴───────────┐       │
│  │ DB (SQLite)│  │ InferenceSvc   │  │ CostService          │       │
│  │ users,     │  │ RuleEngine →   │  │ (prices × quantities)│       │
│  │ analyses   │  │ LLM → merge    │  └──────────┬───────────┘       │
│  └────────────┘  └─────┬──────────┘             │                   │
│                        ↓                        ↓                   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │             DiagramService (ServicePlan → mxGraph XML)        │   │
│  └──────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
         External: GitHub API · LLM provider · AWS pricing CDN
```

The keystone of the whole system is one JSON contract: **`ServicePlan`**. Every upstream stage (rule engine, LLM) produces it; every downstream stage (diagram, cost) consumes it. Define the schema first, in a shared module, and never let a stage pass anything else across a boundary.

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| **Web server / API layer** | HTTP routes: `POST /api/analyze`, `POST /api/prices`, `POST /api/register`, `POST /api/login`, `GET/POST/DELETE /api/history`. Validation at the boundary (URL format, input size caps). | Express/FastAPI-style monolith, JSON in/out |
| **RepoFetcher** | Parse `owner/repo` from URL → one `git/trees` call for the full path list → fetch only README + key files (package manifests, Dockerfile, compose, serverless.yml, IaC). Emits `RepoEvidence` (file type marker + contents). Never a full clone. | GitHub REST via HTTP client; size/rate caps |
| **RuleEngine** | Deterministic keyword/pattern match over evidence: `lambda`/`serverless.yml` → Lambda; `Dockerfile`+compose → ECS/Fargate; `pg` → RDS; etc. Always runnable with zero API keys. | Static pattern table → `ServicePlan` |
| **LLMClient** | Provider-agnostic structured-JSON call (JSON mode / responseSchema), temperature 0, bounded retries (max 3). Returns candidates for merge. | HTTP to cheap/free provider; key from env |
| **InferenceService** | Orchestrates rules + LLM into one validated `ServicePlan`: run rules first (guaranteed baseline), run LLM, validate both against schema, merge by service id with confidence scoring. | Pipeline: extract → infer → validate → merge |
| **DiagramService** | Pure function `ServicePlan → mxGraph XML`. Deterministic grid layout by service category; AWS icon styles; XML escaping of labels. No diagramming library needed — it is a string/XML builder. | XML builder; category → row/col layout |
| **PriceService** | Given `[services] + region` → unit prices. Primary source: public AWS bulk offer files (no credentials), fetched per (service, region) and cached; per-service default prices as fallback when a file is unavailable. | HTTP fetch + cache keyed by service+region |
| **CostService** | `ServicePlan + prices + quantity model → cost rows` `[{service, unit, unitPrice, quantity, monthly}]`. Quantity model is per-service (e.g., Lambda = requests × users × 3). Returns formulas so the client slider can recompute live. | Pure arithmetic; no I/O |
| **AuthService** | Email/password (bcrypt) + session cookie. Optional — generation works without it. Guests get no server persistence; logged-in users get history CRUD. | bcrypt + signed session cookie, SQLite |
| **DB** | `users`, `analyses` (input, servicePlan, diagramXml, cost snapshot, timestamps, nullable user_id). SQLite — one file, zero ops. | SQLite |
| **Frontend** | Form (repo URL / freeform text), results tabs (diagram / cost), region picker, user-count slider, download button (`.drawio` = blob of the XML), login + history pages. | SPA framework + draw.io embed iframe wrapper |

### The ServicePlan Contract

```jsonc
{
  "inputType": "github_url" | "description",
  "region": "us-east-1",                  // default, user-editable
  "services": [
    {
      "id": "aws-lambda",
      "name": "AWS Lambda",
      "category": "compute",              // drives diagram row
      "confidence": 0.9,                  // source: rule | llm | both
      "evidence": ["serverless.yml found"],
      "quantityModel": { "unit": "invocations", "perUser": 5000 }
    }
  ],
  "warnings": ["No Dockerfile found — container services unverified"]
}
```

## Recommended Project Structure

```
project/
├── shared/                   # Contract types used by BOTH server and client
│   ├── schemas.ts            # ServicePlan, CostRow, Diagram XML type (zod/pydantic)
│   └── services.ts           # service id → category, icon, default price, quantity model
├── server/
│   ├── routes/               # analyze.ts, prices.ts, auth.ts, history.ts
│   ├── services/
│   │   ├── repoFetcher.ts    # GitHub REST: tree + targeted file fetch
│   │   ├── ruleEngine.ts     # keyword/pattern → ServicePlan
│   │   ├── llmClient.ts      # provider call (JSON mode) + retry
│   │   ├── inference.ts      # rules + LLM → merged, validated ServicePlan
│   │   ├── diagram.ts        # ServicePlan → mxGraph XML
│   │   ├── prices.ts         # bulk-file fetch + cache + defaults
│   │   ├── cost.ts           # prices × quantities → cost rows
│   │   └── auth.ts           # register/login/session, history CRUD
│   ├── db.ts                 # SQLite init, migrations (one table at a time)
│   └── index.ts              # app bootstrap, static file serving
├── client/
│   ├── pages/                # input, results, history, login
│   ├── components/
│   │   ├── DrawioPreview.tsx # iframe + postMessage wrapper (init→load)
│   │   └── CostTable.tsx     # rows + slider arithmetic (client-side only)
│   └── api.ts                # typed fetch wrappers
└── data/                     # runtime cache (price files, repo evidence) — gitignored
```

### Structure Rationale

- **shared/**: `ServicePlan` is the single contract every boundary crosses. One schema module prevents the classic drift where rules emit `{svc: "lambda"}` and the diagram expects `{service: "lambda"}`. Non-negotiable.
- **server/services/**: one file per stage mirrors the pipeline (fetch → infer → diagram/cost). Each service is independently testable with canned inputs — no server needed to test rule engine or diagram builder.
- **data/**: price files are ~0.5–10 MB each per service+region; caching to disk avoids refetching on restart and survives the AWS CDN being slow. Gitignored so demo secrets/artifacts don't leak.

## Architectural Patterns

### Pattern 1: Rules-first, LLM-enhances (fallback direction is inverted)

**What:** Run the deterministic rule engine first and treat its output as the guaranteed baseline. Run the LLM against the *same evidence* as an enhancement pass. Merge both into one `ServicePlan`; a service is kept if either source found it (weighted by confidence), and every LLM-only claim is downgraded if it conflicts with hard evidence.

**When to use:** Any product where a cheap deterministic path exists and an LLM is a quality bonus, not the core. This is the pattern that makes the demo survivable: no API key, no budget, no network to the LLM provider — the app still works and still produces a diagram.

**Trade-offs:** Slightly more code than "call LLM, parse, done". Payoff: zero-trust external dependency, deterministic behavior for tests, and the rule output doubles as ground truth to validate the LLM against.

**Example:**
```typescript
async function infer(evidence: RepoEvidence): Promise<ServicePlan> {
  const baseline = ruleEngine.analyze(evidence);            // never fails
  if (!llmConfigured()) return baseline;
  try {
    const llm = await llmClient.structured(evidence, SCHEMA); // JSON mode, ≤3 retries
    return merge(baseline, validate(llm));                    // union, score by source
  } catch {
    return baseline;                                          // LLM down = degrade, don't break
  }
}
```

### Pattern 2: Deterministic diagram generation (no diagramming library)

**What:** The `.drawio` file is plain `mxGraphModel` XML. Generate it directly: assign each service a grid cell by category (row) and index (column), emit `<mxCell>` vertices with AWS icon styles, escape all user-derived labels. No mxGraph/maxGraph/dagre dependency, no layout engine.

**When to use:** Read-only output with a fixed structure (the requirement). A graph layout engine is only justified if diagrams must be arbitrary graphs.

**Trade-offs:** Grid layout is not "beautiful" — acceptable, it's a generator. The icon style names (`shape=mxgraph.aws4.*`) render in draw.io desktop/web/embed because they are bundled there — verify each icon during implementation; fallback to `shape=image` + AWS icon SVG data URI, which renders everywhere.

**Example (what the builder emits):**
```xml
<mxGraphModel dx="1000" dy="700" grid="1" gridSize="10">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="n1" value="API Gateway" style="shape=mxgraph.aws4.api_gateway;whiteSpace=wrap;html=1;"
            vertex="1" parent="1">
      <mxGeometry x="40" y="40" width="70" height="70" as="geometry"/>
    </mxCell>
    <mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;" edge="1" source="n1" target="n2" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>
```

### Pattern 3: Server returns prices + formulas, client does live slider math

**What:** `POST /api/prices` returns per-service rows with the unit price *and* the quantity formula (`{unit, unitPrice, quantity: users * perUser}`). The user-count slider and region picker recompute entirely client-side from those rows — the server is only re-called on region change (prices differ by region).

**When to use:** Any "interactive estimator" — avoids an API round-trip per slider tick, keeps the UX instant, and makes the server stateless for cost.

**Trade-offs:** If quantity models change, cached cost rows go stale — fine here because the client re-fetches on region change and on each new analysis.

### Pattern 4: draw.io embed iframe for preview (not a rendering library)

**What:** Load `https://embed.diagrams.net/?embed=1&ui=min&proto=json` in an iframe; on the `init` message, post `{action: 'load', xml: <our XML>}` to `https://embed.diagrams.net`; show a download button that serializes the same XML as a `.drawio` blob. ~20 lines of wrapper code, renders 100% faithfully because it *is* the draw.io editor.

**When to use:** Self-hosted rendering libraries (maxGraph, mxGraph fork) exist but cost far more integration effort for zero user-visible gain — the app already requires internet for GitHub/LLM, so an external iframe adds no new constraint.

**Trade-offs:** Depends on `embed.diagrams.net` availability; hides the editor chrome with `chrome=0`/`ui=min` for a preview feel. Do NOT use `app.diagrams.net` for embed mode — official docs: embed mode is only supported on `https://embed.diagrams.net`.

## Data Flow

### Request Flow: Analyze (repo URL)

```
User pastes https://github.com/foo/bar + clicks Analyze
    ↓
POST /api/analyze {url}
    ↓
RepoFetcher: GET /repos/foo/bar → default branch sha
    ↓             GET /repos/foo/bar/git/trees/{sha}?recursive=1   (1 call: full path list)
    ↓             GET .../contents/{README, package.json, Dockerfile, docker-compose.yml,
    ↓                     serverless.yml, ...}                      (~5–8 calls, only files found)
    ↓
RepoEvidence { files: [{path, type, content}] }
    ↓
InferenceService → RuleEngine (baseline) + LLM (enhance, if key present) → merge
    ↓
ServicePlan (JSON contract)
    ↓
┌───────────────┬───────────────────────────────┐
↓               ↓                               ↓
DiagramService  PriceService                    (response to client)
↓               ↓
mxGraph XML     prices → CostService → cost rows
↓               ↓
response: { servicePlan, diagramXml, costRows }
    ↓
Client renders: draw.io iframe (load XML) · cost table · download .drawio button
```

### Request Flow: Cost re-calc (slider / region)

```
Slider moved (100 → 10,000 users)  →  pure client-side: rows.map(r => r.monthly = r.unitPrice * f(users))
Region changed                     →  POST /api/prices {servicePlan.services, region} → PriceService
                                       (cache hit | fetch bulk file | defaults) → new cost rows
```

### Request Flow: Save to history (logged-in only)

```
Save clicked → POST /api/history {input, servicePlan, diagramXml, costRows}
    → AuthService verifies session cookie → INSERT INTO analyses (user_id, ...)
History page → GET /api/history → rows listed → open = POST /api/prices with stored servicePlan (fresh cost)
```

### State Management

- **Server:** stateless except SQLite + disk cache. Sessions via signed HttpOnly cookie. Price cache and repo-evidence cache (keyed by `owner/repo@sha`) live in `data/`.
- **Client:** results are ephemeral component state; the ServicePlan is the payload the cost tab and slider read. No global store library needed — a single `useAnalysis()` hook holds `{servicePlan, diagramXml, costRows}`.

### Key Data Flows

1. **Evidence → ServicePlan (the pipeline spine):** every input (repo or description) collapses to `RepoEvidence` or raw text, then to one `ServicePlan`. All inference variants converge on this — it is the only place rules and LLM meet.
2. **ServicePlan → Diagram XML:** pure, deterministic, no I/O. Testable by golden-file: same plan in, byte-identical XML out.
3. **ServicePlan → Cost rows → slider:** prices are server truth; quantity arithmetic is client math. The slider never touches the network.

## Build Order (dependency-driven)

| # | Slice | Builds | Depends on | Demo value |
|---|-------|--------|------------|-----------|
| 1 | **Pipeline skeleton with canned input** | `ServicePlan` schema, `DiagramService`, draw.io embed wrapper, `.drawio` download, results page | nothing (hardcoded plan) | De-risks the two hardest integrations (mxGraph XML format + embed protocol) with zero external deps. If this slice can't render a pretty AWS diagram in-browser, everything else is moot — so it's first. |
| 2 | **Real inputs** | RepoFetcher (GitHub tree + targeted fetch), freeform description path, `POST /api/analyze` | 1 | Real repos produce diagrams. Rule engine not needed yet — a hardcoded "package.json + Dockerfile ⇒ 3 services" hack proves the end-to-end wiring. |
| 3 | **Rule engine** | `ruleEngine.ts` with the service-pattern table, confidence scoring | 2 | Deterministic inference, no API keys. The app is now fully demoable offline-ish. |
| 4 | **LLM enhancement** | `llmClient.ts` (JSON mode, retry), validator, merger | 3 | Better diagrams on real descriptions; rules remain the fallback. Skippable without breaking the demo. |
| 5 | **Cost engine** | PriceService (bulk files + cache + defaults), CostService, region picker, slider, cost tab | 2 (needs ServicePlan, not LLM) | The second half of the core value. Second risky integration (AWS price file schemas) — by now the pipeline is stable enough to absorb it. |
| 6 | **Auth + history** | register/login, sessions, history CRUD, history page | 2 (whole pipeline) | Nice-to-have; orthogonal to the pipeline. Last because it adds zero value to the core loop and the guest path must work regardless. |

**Phase ordering rationale:** 1 → 2 is "prove the output side with fake data, then feed it real data". 3 → 4 is "cheap deterministic truth before paid probabilistic enhancement". 5 is deliberately placed after 2–4 so the cost engine consumes a stable, well-tested contract instead of chasing a moving pipeline. 6 is last because auth multiplies every other component's test surface and the university demo's core value is untouched by it.

**Research flags for phases:**
- Phase 1: needs the mxGraph XML format spec + exact draw.io AWS icon style names (`shape=mxgraph.aws4.*`) — verify each icon in the draw.io editor, fall back to `shape=image` data-URI icons.
- Phase 5: needs per-service price-file structure (EC2 = price per instance type × region; Lambda = per-request + per-GB-s; S3 = per-GB tiers). Map each supported service's `unit` + `perUser` quantity model to a specific file/field before writing CostService.
- Phase 4: needs provider selection + JSON-mode specifics (Gemini `responseSchema`/`responseMimeType`, Groq/DeepSeek OpenAI-style `response_format`). Pydantic/Zod schema first.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 0–100 users (university demo) | Monolith + SQLite + disk cache. Nothing else. One server process, one DB file. |
| 100–1k users | Add a GitHub token via env (5,000 req/hr instead of 60) — the shared server IP will hit the unauthenticated limit first during classroom demos. Cache repo evidence per `owner/repo@sha` (huge win: the same repo is analyzed repeatedly). Swap disk cache for SQLite/Redis only if it actually hurts. |
| 1k+ users | Move price-fetching to a scheduled job (daily refresh of a small curated price table) instead of on-demand fetch; queue LLM calls. Not a real concern for this project. |

### Scaling Priorities

1. **First bottleneck: GitHub unauthenticated rate limit (60 req/hr per server IP).** One analysis ≈ 6–9 API calls, so ~7 analyses/hour breaks it. Fix: env-configured token + repo-evidence cache. Cheap, do it in Phase 2.
2. **Second bottleneck: LLM latency/cost.** A single analysis is 1 LLM call at low traffic — fine. If a demo day spikes, the rules-only path keeps working; cap LLM retries at 3.

## Anti-Patterns

### Anti-Pattern 1: Asking the LLM to emit draw.io XML directly

**What people do:** One prompt: "output a draw.io diagram for these AWS services".
**Why it's wrong:** XML is structurally unforgiving — one unescaped `<` or a hallucinated attribute and draw.io refuses the file. You cannot validate XML by eyeballing it, and every retry costs tokens. This is the #1 way this kind of project dies.
**Do this instead:** LLM emits a small validated JSON `ServicePlan` (schema-enforced); the diagram XML is generated deterministically by `DiagramService`. Same for cost: LLM picks services, never prices.

### Anti-Pattern 2: No schema validation on LLM output

**What people do:** `JSON.parse(llmText)` and trust it.
**Why it's wrong:** LLMs wrap JSON in markdown fences, drop fields, invent keys. A single malformed response crashes the pipeline at the worst moment (the demo).
**Do this instead:** Strip code fences, parse, validate against the schema (Pydantic/Zod). On failure: one retry with the validation error as feedback, then fall back to the rule engine's output. Max 3 attempts, then fail explicitly.

### Anti-Pattern 3: Hitting AWS pricing per request without a cache

**What people do:** Call `GetProducts` (or re-download the bulk file) for every cost calculation.
**Why it's wrong:** Price files are large and change at most weekly; Query API has token-bucket limits (~10 burst, 5/sec refill). Under demo-day traffic this either slows the app to a crawl or 429s it.
**Do this instead:** Fetch once per (service, region), cache to `data/` with a TTL (24 h is generous). Keep hardcoded default prices as the zero-cache fallback so cost never 404s.

### Anti-Pattern 4: Putting the pipeline in the browser

**What people do:** Do everything client-side (like InfraSketch) to avoid running a server.
**Why it's wrong here:** LLM keys can't live client-side (anyone can read them), signed AWS calls can't be made client-side, and saved history requires a backend anyway. You end up with a proxy endpoint that *is* a server, plus CORS pain.
**Do this instead:** Accept the monolith from day one. Thin client, all secrets and caching server-side.

### Anti-Pattern 5: Building auth before the pipeline

**What people do:** "We need login first, everything else hangs off it."
**Why it's wrong:** Auth multiplies test surface (sessions, passwords, CSRF) and contributes zero to the core value. The guest path is a hard requirement anyway.
**Do this instead:** Ship the whole pipeline guest-first; add auth as the final slice. The pipeline never references the user.

### Anti-Pattern 6: String-concatenating XML with unescaped user data

**What people do:** `` `<mxCell value="${repoName}" .../>` ``.
**Why it's wrong:** Repo names, descriptions, and README snippets end up in diagram labels. Raw interpolation produces malformed XML or, worse, injected XML nodes.
**Do this instead:** Escape every label (or use an XML builder), truncate long text (draw.io labels > ~200 chars break layout), and strip control characters.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| GitHub REST API | `GET /repos/{owner}/{repo}` (default branch), `GET .../git/trees/{sha}?recursive=1` (full file list, 1 call), `GET .../contents/{path}` (base64 content, raw media type for >1 MB) | Unauthenticated: 60 req/hr per IP; with token: 5,000/hr. May 2025 changelog tightened unauthenticated limits — always ship the env-token path. Private repos require a token; out of scope. |
| LLM provider (Gemini Flash / Groq / DeepSeek) | Server-side HTTP, temperature 0, JSON mode / responseSchema, ≤3 retries, key in env var | Structured-output support is now standard across these providers; STACK research picks the specific one. Rules engine must remain the no-key path. |
| AWS Price List (Bulk API) | Public HTTPS GET, no credentials: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{service}/current/{region}/index.json`; service list at `.../offers/v1.0/aws/index.json` | Files are 0.5–10 MB — fetch once, cache to disk, refresh daily. Query API (`GetProducts`, signed, IAM creds) is the alternative only if on-demand lookups are needed — the bulk path avoids AWS credentials entirely (corrects the PROJECT.md assumption that creds are required). |
| draw.io embed | `<iframe src="https://embed.diagrams.net/?embed=1&ui=min&proto=json">` + postMessage: wait `init` → post `{action:'load', xml}` → (read-only preview) → download `.drawio` blob client-side | Embed mode ONLY on `embed.diagrams.net` (not `app.diagrams.net`). Post to target origin `https://embed.diagrams.net` and check `evt.origin` on receive; a browser debugger breakpoint on the receive handler can corrupt postMessage events (known issue) — don't debug that way. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| API layer ↔ services | Direct function calls | Monolith; no message bus. Routes stay thin (validate → call service → respond). |
| InferenceService ↔ RuleEngine / LLMClient | Same `ServicePlan` type | The only place both sources meet — the merge function lives here, not in routes. |
| DiagramService / CostService ↔ ServicePlan | Read-only pure functions | Both must stay side-effect-free for golden-file tests. |
| Server ↔ Client | REST JSON | Client never talks to GitHub/LLM/AWS directly — only `/api/*`. |
| PriceService ↔ data/ cache | Disk read/write | Cache key: `{service}:{region}`; TTL 24 h; defaults as final fallback. |

## Sources

- draw.io embed mode (official): https://www.drawio.com/docs/reference/embed-mode/ · https://github.com/jgraph/drawio-integration (protocol: init → load → save/exit; embed only on embed.diagrams.net) — HIGH
- mxGraph EOL / draw.io internal fork / maxGraph successor: https://www.jointjs.com/blog/mxgraph-to-jointjs-conversion · https://maxgraph.github.io/maxGraph/ · https://github.com/jgraph/drawio/issues/3673 — HIGH (mxGraph archived), MEDIUM (maxGraph specifics)
- AWS Price List API: bulk files public (no creds) + Query API signed, IAM policy `pricing:GetProducts` etc.: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_pricing_GetProducts.html · https://pilotcore.io/blog/how-to-use-aws-price-list-api-examples · https://repost.aws/questions/QUl-xh04YoTQO9BGUTEWMqMA/pricing-api-requires-credentials — HIGH
- GitHub REST: contents + readme + rate limits (60/hr unauthenticated, 5,000/hr token, May 2025 tightening): https://docs.github.com/en/rest/repos/contents · https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api — HIGH
- LLM structured output patterns (JSON mode + validation + bounded retry + fallback chain): https://www.aiwisdom.dev/articles/prompt-engineering/structured-outputs-from-llms · https://viral.software/structured-output-llm-guide · https://appscale.blog/en/blog/structured-output-engineering-reliable-json-from-llms-2026 — MEDIUM (multiple 2026 sources agree)
- Precedents generating native `.drawio` mxGraph XML with official AWS icons: Diagrams.so (https://diagrams.so), InfraSketch (https://infrasketch.cloud, open source: https://github.com/pandey-raghvendra/infrasketch) — MEDIUM (validates output model, not cited docs)
- Draw.io embed postMessage debugging gotcha (target origin + debugger corruption): https://stackoverflow.com/questions/78344150 — MEDIUM

---
*Architecture research for: AWS Architect (repo/idea → AWS service map → draw.io diagram + cost estimate)*
*Researched: 2026-08-07*
