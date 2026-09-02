# AWS Architect — Pipeline & Code Flow

How a request moves through the code, stage by stage — including the boundaries, gates, and fallbacks defined by flaw resolutions 1–8 (`Problems.md`). Mirrors the module layout in `.planning/research/ARCHITECTURE.md`.

<!-- GSD:flow-start -->

## Big picture

```
 User input (repo URL | freeform description)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  POST /api/analyze  (voice of input + validation@boundary)  │
└───────────────┬─────────────────────────────────────────────┘
                ▼
  Stage 1: INPUT NORMALISATION       (parse URL | take description)
                ▼
  Stage 2: EVIDENCE EXTRACTION       (repo: RepoFetcher; freeform: none)
                │   ┌─ insufficient-signal gate (flaw 8) ─┐
                │   │   no key files + README < 100 chars  │──► return advisory:
                │   └──────────────────────────────────────┘   "describe instead" (prefill)
                ▼
  Stage 3: INFERENCE                  RuleEngine (baseline, never fails)
                │                     LLM enhance (if key) → schema gate (flaw 5)
                │                     merge → grounded, catalog-validated ServicePlan
                ▼
  Stage 4: DIAGRAM (pure fn)          ServicePlan → deterministic mxGraph XML
                ▼
  Stage 5: COST                       PriceService (region, cache) → CostService rows + formulas
                ▼
                │───────────────────────────┐
                ▼                           ▼
  Stage 6: RESPOND                   7. CLIENT RENDER
   {service_plan, diagram_xml,        draw.io iframe · cost table · slider (client math) ·
    cost_rows}                         .drawio download · region switch (re-fetch) · save/reopen
```

---

## Stage 1 — Input normalisation

**Code:** `routes/analyze.ts` (validation at the HTTP boundary)
**Stage 2–6 in `Problems.md` terms:** input choice.

- Accept `{ input: { kind: 'github_url' | 'description', value: string } }`.
- Validate: URL format, host allowlist (github.com only — SSRF guard), input length caps (e.g. description ≤ 8,000 chars; URL ≤ 2,000).
- Set `input_kind` here — it is frozen for the whole request and stored with history (flaw 7 decision: `input_kind` ≠ `grounding`).

---

## Stage 2 — Evidence extraction

**Code:** `services/repoFetcher.ts` → emits `RepoSignals`

### Repo path (flaw 1 bounds applied here)

```
repo URL
  → GET /repos/{owner}/{repo}          (default branch; 1 call)
  → GET .../git/trees/{ref}?recursive=1 (1 call, full path list; cap 50k paths)
  → select key files (allowlist, root or depth ≤1):
       README* · package.json · requirements.txt · pyproject.toml · go.mod ·
       Cargo.toml · Gemfile · composer.json · pom.xml · build.gradle · *.csproj ·
       Dockerfile · docker-compose.{yml,yaml} · serverless.{yml,yaml} ·
       .github/workflows/*.yml · vercel.json · netlify.toml · terraform/*.tf · template.yaml
  → cap: 20 files; skip over-limit by priority (README → manifests → container/CI)
  → fetch each via GET /contents/{path} (.raw media type) — 64KB raw read cap per file
```

**Post-fetch processing (flaws 1):**
- **Structured files (JSON/YAML/TOML, XML):** *compact, never raw-truncate.*
  - JSON: stdlib `JSON.parse` → keep first ~40 top-level keys → re-stringify (well-formed).
  - YAML: `yaml` lib — `parseDocument` → first ~40 top-level entries → `stringify` (well-formed).
  - TOML/XML: line trim (~200 lines) + drop final line if mid-tag/table.
  - Unparseable → keep only `{ name, sizeBytes }`, set `parse_errors[]`.
- **Prose** (README, plain lists): line truncation at 64KB (no structure to preserve).
- Set `truncated` flag if any cap was applied.

**Emits:** `{ input_kind:'repo', keyFiles:[{path, kind, content|compact}], truncated, parseErrors[], readmeLength }`

### Freeform path

- No fetch. `RepoSignals` is empty; the description text itself is the evidence for Stage 3.
- `grounding` is set to `'description'` here (flaw 4).

### Insufficient-signal gate (flaw 8)

```
if (input_kind == 'repo'
    && keyFiles has NO manifest/container/CI file
    && readmeLength < 100 chars)
  → NOT an inference-failure fallback: abort at extraction
  → response: { status:'insufficient_signal',
                message:"Couldn't extract enough from this repo — describe it instead",
                prefill: { repoName, readmeSnippet } }
```

The user is prompted (not silently guessed) to switch to freeform, pre-filled. A result is never produced from near-zero signal.

---

## Stage 3 — Inference

**Code:** `services/ruleEngine.ts`, `services/llmClient.ts`, `services/inference.ts`

```
evidence (RepoSignals | description)
   │
   ├─► RuleEngine.analyze(evidence) ───────────► baseline ServicePlan (never fails, zero keys)
   │
   ├─► if !llmConfigured() → skip LLM (silently)
   │
   ├─► LLMClient.structured(evidence, SCHEMA)    temp 0, ≤3 retries, generateObject(zod)
   │        └─► output must conform to the single zod `ServicePlan` schema (flaw 5)
   │
   ▼
   InferenceService.merge(baseline, validate(llm))
```

**Schema + validation gate (flaw 5) — provider-agnostic:**
- One fixed contract: the zod `ServicePlan` schema. Every provider runs through the *same* `generateObject(schema)`.
- Single gate: `SP.safeParse(llmResult)` **and** catalog-allowlist check (~30–40 service enum).
- Any failure → **discard LLM result, return baseline**. No provider-specific thresholds.
- A provider that can't emit the schema via `generateObject` is out of rotation — never tuned around.

**Grounding & confidence (flaw 4):**
- `grounding: 'repo' | 'description'` rides on `service_plan.metadata`.
- Repo-grounded → confidence tier High/Medium from rules↔LLM consensus.
- Description-grounded → **capped at "Low confidence"** regardless of internal agreement → UI banner: *"Inferred from your description only — not verified against code."*

**Output:** validated `ServicePlan`:
`{ input_kind, pattern: <1 of 5–8 templates>, slots: {slotName: {serviceId, confidence, evidence}}, customEdges[], metadata:{grounding, truncated, parseErrors}, services:≤12 }`

- Single-deployable rule (flaw 2): only root/depth-≤1 manifests were seen by the fetcher, so classification always picks **one** pattern — the strongest root-level deployable. No composition.
- Template slot max ≤ 12 distinct services (bounds Stage 5 cost, flaw 3).

---

## Stage 4 — Diagram

**Code:** `src/lib/diagram.ts` — pure function `generateDiagramXml(plan, sdkEvidence?) → mxGraph XML`

Transforms a validated `ServicePlan` into standard, production-ready `.drawio` XML with collision-free layout, Well-Architected color-coded containers, orthogonal edge routing, and mathematical viewport centering.

```
ServicePlan (components, awsMappings, relationships)
   │
   ├─► Step 4.1: Deduplication & Normalization
   │      - Duplicate generic mappings in same tier (e.g. multi-ALB/SecretsManager)
   │        consolidated into master nodes; relationships re-routed.
   │      - normalizeServiceName: maps IDs to official names ("Amazon ECS", "AWS Secrets Manager").
   │      - wrapServiceName: wraps labels >16 chars into balanced lines (width ≤100px).
   │
   ├─► Step 4.2: Tier Classification & Layout (computeLayout)
   │      - Partitions services into 5 Well-Architected tiers:
   │        edge (banner) | vpc_public (DMZ) | vpc_compute (private) | vpc_data (isolated) | external.
   │      - Dynamic bucketHeight(rows) computes container dimensions wrapping children with padding.
   │      - Subnet columns: 4 for VPC subnets, 6 for edge, 2 for external.
   │
   ├─► Step 4.3: Mathematical Centering
   │      - Computes tight bounding box (minX, minY, maxX, maxY) of all containers & nodes.
   │      - Sets canvas size with uniform padding (CANVAS_PAD_X=64, CANVAS_PAD_Y=56).
   │      - Translates every container and node by exact offset (shiftX, shiftY) → 0px margin differential.
   │
   ├─► Step 4.4: Orthogonal Edge Routing (routeEdges)
   │      - Stepped gutter waypoints: midY = (srcBot + dstTop) / 2 prevents node pass-throughs.
   │      - Horizontal branching bus: cleanly splits compute-to-data connections across tier gutters.
   │      - Solid edges (#232F3E, 1.5px) for explicit evidence; dashed (#6B7280, 8 8) for inferred topology.
   │      - Staggered label offsets with opaque white badges (labelBackgroundColor=#FFFFFF) prevent strikethrough.
   │
   ▼
Emits: valid .drawio mxGraph XML (<mxfile>, <diagram>, <mxGraphModel>, containers, nodes, edges)
```

---

## Stage 5 — Cost

**Code:** `services/prices.ts` (PriceService), `services/cost.ts` (CostService)

### At analysis time (flaw 3)
- **On analysis:** fetch Price List API **once per (region, service)** for the ~≤12 services in the plan; cache raw unit prices server-side (in-memory, keyed `region:serviceCode:usageType`, TTL 24h).
- Defaults from `SERVICE_DEFAULTS.ts` (each with a `source` annotation — free-tier limit or stated "small-app baseline", flaws 6) fall back when the API is unavailable. Baseline quantities are **never derived from repo content** — always labeled assumptions.

### Quantity formulas
- CostService returns per-service `{ unit, unitPrice, quantityFormula, monthly }` where `quantityFormula` is like `users * 5000` (requests), `log2(users) * 1GB` (storage), or a fixed floor.
- Client keeps the formulas + prices to recompute live (Stage 7 slider).

### Region switch (flaw 3 — on-demand, bounded)
```
region changed on cost tab
  → cost panel shows "Loading prices…", slider disabled
  → POST /api/prices { services (≤12), region }
  → PriceService: cache hit? → instant
    miss? → fetch only the planned services (~≤10 GetProducts, within token-bucket burst) → ~1-2s typical, ≤3s worst case
  → enable slider with new prices
```
- No pre-warming of other regions; default region = analysis region (us-east-1) → common path never re-fetches.

---

## Stage 6 — Response

**Code:** `routes/analyze.ts`, `routes/prices.ts`

Response to the client (all server-side compute, no secrets):
```
{
  input_kind, grounding,
  service_plan,             // validated ServicePlan (≤12 services, pattern, slots)
  diagram_xml,              // mxGraph XML for the iframe + .drawio download
  cost_rows: [{service, unit, unitPrice, quantityFormula, monthly}],
  warnings: [truncated, parse_errors, grounding disclaimer, insufficient?]
}
```

Error paths:
- Insufficient signal (Stage 2 gate) → advisory payload, no plan/diagram/cost.
- LLM failure → baseline plan still returned (Stage 3).

---

## Stage 7 — Client render (in browser)

**Code:** `src/components/*`, `src/app/page.tsx`

| UI element | Behavior |
|------------|----------|
| **Architecture Workspace** | Embedded draw.io iframe (`embed.diagrams.net/?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json&fit=1`). Handshake: `init` event triggers `{action:'load', xml, autosize:1}` followed by `{action:'center'}`. Re-centers automatically on window resize. |
| **Workspace Sizing** | Responsive container bounded at `max-w-6xl xl:max-w-7xl` with `mx-auto` on desktop to prevent edge-to-edge stretching, with large vertical viewport (`h-[74vh] min-h-[580px] max-h-[860px]`). |
| **Fullscreen Mode** | Toolbar toggle switches the diagram workspace into an immersive `100vw × 100vh` modal canvas. |
| **Download .drawio** | Client-side Blob download of `diagram_xml` string; opens directly in Diagrams.net / draw.io desktop without server round-trip. |
| **External Editor** | Direct link button to `https://app.diagrams.net` for advanced external editing. |
| **Loading Visualizer** | Calm central breathing core orb with `Layers` icon, ambient glow, concentric ripple rings, orbital SVG dashes, and live progress percentage counter. |
| **User slider (100→1M)** | **Pure client math** from cached `cost_rows` formulas — no network per tick. |
| **Region picker** | Triggers `POST /api/prices` (Stage 5); spinner + disabled slider while loading. |
| **Grounding banner** | If `grounding='description'`: *"Inferred from your description only — not verified against code."* |
| **Assumptions disclosure** | Expandable list of every cost default + its `source` (flaw 6). |
| **Insufficient-signal UI** | Prompt + button switching input to freeform, pre-filled. |

## Side flows — Auth & History

**Code:** `routes/auth.ts`, `routes/history.ts`, `services/auth.ts`, `db.ts`

### Save
```
logged-in, "Save analysis"
  → POST /api/history
     { input_kind, input, grounding, service_plan, diagram_xml, cost_snapshot }
  → cost_snapshot = frozen { region, generated_at,
        services:[{code, unitPrice, quantityFormula, monthly}], grandTotal }
  → INSERT analyses(id, user_id, input_kind, input, grounding,
                    service_plan, diagram_xml, cost_snapshot, created_at)
```

### Reopen (flaw 7 — frozen, never recomputed)
```
  → GET /api/history → list of user's own rows (user-scoped)
  → open one → return stored service_plan + diagram_xml + cost_snapshot verbatim
  → slider/region recompute client-side over the FROZEN snapshot units ONLY
  → no Price List call, no LLM call, no inference re-run
```

### Auth
- `better-auth` email/password; sessions in SQLite; guest generation totally unchanged (Phase 6 adds zero to the core loop).

---

## Rate / cache / external notes (how the flow stays within bounds)

| Resource | Guard |
|----------|-------|
| GitHub API | PAT via env (5k req/hr) + per-`owner/repo@sha` evidence cache; unauthenticated path still works (60/hr). |
| LLM | ≤3 retries; no key → rules-only. |
| AWS Pricing | 24h TTL cache; ≤12 services/region; burst ~10 (5/s refill) fits the whole batch. |
| draw.io embed | Server sends XML; iframe does the rendering — no bundling of mxGraph. |

<!-- GSD:flow-end -->

---
*Last updated: 2026-08-12 — consolidated from `.planning/research/ARCHITECTURE.md` and flaw resolutions 1–8.*