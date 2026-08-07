# Feature Research

**Domain:** AWS deployment-diagram + cloud-cost-estimation webapp (repo/description → diagram + cost)
**Researched:** 2026-08-07
**Confidence:** MEDIUM-HIGH (competitor features verified via vendor sites + official docs; fast-moving AI-diagram space is MEDIUM)

## Feature Landscape

### Table Stakes (Users Expect These)

Users comparing against Cloudcraft, AWS Pricing Calculator, Infracost, and the AI diagram generators assume these exist. Missing them = product feels broken.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Freeform description input (plain English → architecture) | Every AI diagram tool (diagrams.so, Cloudairy, Visual Paradigm, Datadef) leads with this | LOW | Simplest input mode; one textarea + "Generate" |
| Repo URL input (GitHub) | The project's defining input; no competitor combines repo-analysis with cost+diagram, but repo/README analysis is a known pattern (Infracost scans IaC; Eraser does codebase diagrams) | MEDIUM | Fetch README + key manifests only (package.json, Dockerfile, compose, serverless.yml) — bounded file set |
| Diagram output using official AWS icon set | All diagram tools use official AWS icons (AWS Architecture Icons page; draw.io ships the AWS library; "RULE-02" in diagrams.so enforces it) | MEDIUM | Need service→icon mapping embedded in draw.io XML. **Pitfall:** draw.io has two icon `strokeColor` patterns (service-level vs resource-level) — get this wrong and icons render as empty colored squares (documented by the aws-architecture-diagram-skill author) |
| In-browser preview of the generated diagram | Nobody downloads blind; every tool renders before export | MEDIUM | draw.io embed library renders mxGraph XML directly |
| Downloadable `.drawio` file | Draw.io is the de-facto free editing tool; native editable output is expected (diagrams.so's core pitch, Cloudviz export list) | LOW | Native output format, not a conversion |
| Per-service cost breakdown + monthly total | Every cost tool has this (AWS Pricing Calculator, Infracost per-resource breakdown, Cloudcraft Budget with per-resource granularity) | MEDIUM | Table of service → qty → unit price → subtotal + total |
| Region picker | Prices vary up to ~50% between regions (ec2calc, AWS calculator region comparison); every cost tool requires it | LOW | Default us-east-1; pass region into Price List API queries |
| Cost estimate uses real AWS prices | Infracost/C3X/AWS calculator all source from AWS pricing APIs; stale hardcoded prices = broken trust | MEDIUM | AWS Price List API is free; mapping service→price attributes is the real work (see pitfalls in STACK/ARCHITECTURE research) |

### Differentiators (Competitive Advantage)

Where this product competes. Aligned with Core Value: "given a repo or idea, produce a correct AWS service map with a downloadable draw.io diagram and a realistic monthly cost estimate."

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Diagram + cost from a **repo URL** (not live account, not manual modeling) | Cloudcraft needs live AWS account scanning; AI diagram tools need a description; Infracost gives cost without diagram. Nobody does "paste repo → editable diagram + monthly cost". This is the demo moment | MEDIUM-HIGH | Repo analysis is the hard differentiator; keep it heuristic (README+manifests), not full code scan |
| Combined pipeline: one inference output feeds BOTH diagram and cost | Competitors are siloed (diagram tools don't price, cost tools don't draw). Fused output = one-click value | MEDIUM | Architecture depends on a single structured "service list" intermediate (see dependencies) |
| Scale simulator: user-count slider (100 → 1M) with live cost recalculation | Cloudcraft updates cost as you *edit the diagram*; nothing has a one-slider "what if 1M users" demo. Interactive, explainable, great for a university demo | MEDIUM | Requires per-service quantity models (requests, GB, instance count) tied to user count |
| No AWS credentials needed from the user | Cloudcraft/Cloudviz require cross-account IAM roles; this app uses its own read-only credentials for Price List API. Zero-friction try-before-signup | LOW | App-side IAM only |
| Generation without login | Cloudcraft free tier exists but nags; most AI tools gate on credits/accounts. Guest-first = frictionless demo | LOW | Auth is optional/adjacent (P2) |
| Per-service explanation of *why* each service was chosen | No competitor surfaces inference reasoning; makes LLM output inspectable and correctable ("we chose S3 because…") | LOW-MEDIUM | LLM returns rationale per service in the structured output; render as expandable notes |
| Native `.drawio` as primary output | diagrams.so does this but without cost; Cloudcraft exports PNG/SVG but not draw.io. Users get an editable artifact they already know | LOW | Read-only preview + download is fine (explicitly out-of-scope to build an editor) |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Full in-app diagram editor (drag/drop, move/relabel nodes) | Cloudcraft/Lucidchart have it; users expect to tweak | Months of scope (mxGraph editor wiring, undo, save-back). Draw.io is free and already the output format | Read-only preview + `.drawio` download; users edit in draw.io. PROJECT.md already scopes this out |
| Live AWS account scanning / "connect your AWS" | Cloudcraft's and Cloudviz's signature feature | Requires cross-account IAM roles, resource inventory logic, security review, handling private data — enterprise scope, kills the university timeline | Repo + description inputs only; never touch user accounts |
| IaC generation (CloudFormation/Terraform from diagram) | AWS Infrastructure Composer does it; it's the "obvious" extension | Completely different problem (1,100+ resource type models); diagram is a by-product, not the product | Ship diagram + cost; IaC generation is a v2+ research project |
| CI/CD integration (PR cost-diff comments, scheduled diagram refresh) | Infracost's core pattern; "power user" request | Requires GitHub Apps, webhooks, token handling | Local demo is the target; expose the pipeline as a function call, not a product |
| Team collaboration / multi-user editing / shared links | Enterprise expectation | Real-time sync infrastructure; already out of scope in PROJECT.md | Single-user history under optional login |
| Cost optimization recommendations ("you could save 40% by…") | Infracost Cloud's paid feature; obvious add-on | Needs FinOps policy engine (Rego etc.), paid-tier IP; no MVP value | The scale simulator already shows cost sensitivity — that's the "insight" |
| Savings Plans / Reserved Instance / discount modeling | AWS calculator in-console does it | Requires account usage history + commitment math; AWS lists it as advanced in-console-only feature | On-demand list prices only; label estimate as such |
| Multi-cloud (Azure/GCP) | Broadens audience | Doubles icon sets, pricing APIs, and inference knowledge | AWS-only for the SGP |
| Full source code scan (every file → services) | Feels thorough | Slow, expensive tokens, low signal-to-noise; README+manifests catches ~80% of infra signals | README + package manifests + Dockerfile/compose/serverless.yml (PROJECT.md decision) |

## Feature Dependencies

```
[Input: repo URL] ──┐
                    ├──> [Repo analysis: fetch README + manifests]
[Input: freeform description] ──┐
                                └──> [LLM inference → structured service list]
                                          │
[Rule-based fallback] <── (LLM fails/validation fails) ──┘
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
   [Diagram generation        [Cost engine               [Service rationale
    → draw.io XML]             → per-service pricing       notes]
                │              + monthly total]
                ▼                         │
   [In-browser preview]                  │
   [.drawio download]                    │
                                         ▼
[Region picker] ──> [Price List API lookups] ──> [Cost breakdown UI]
                                         ▲
                            [Per-service quantity model]
                                         ▲
                            [Scale simulator slider]

[Optional auth] ──enhances──> [History: saved analyses, re-open]
```

### Dependency Notes

- **[LLM inference → structured service list] is the backbone:** both diagram generation and the cost engine consume the *same* validated service list. This intermediate is the architecture's contract — diagram and cost must never infer services independently or they'll diverge. This is the single most important dependency for phase ordering.
- **[Repo URL input] requires [Repo analysis]:** URL alone yields nothing; the pipeline is URL → fetch → analyze → same service list as freeform. Both input modes must converge on the same downstream pipeline (PROJECT.md requirement).
- **[Rule-based fallback] requires [structured service list schema]:** fallback is only possible if the target schema (services + quantities + links) is defined first and shared with the LLM prompt. Fallback emits the same shape the LLM is asked to emit.
- **[Scale simulator] requires [per-service quantity model]:** the slider only works if each service has a quantity formula (e.g., Lambda: requests = users × 10; S3: storage GB = users × 0.5). Must be designed in the cost engine, not bolted on later.
- **[Region picker] requires [Price List API client]:** pricing lookups are region-scoped; picker is a parameter, not a standalone feature.
- **[Service rationale notes] enhance [diagram/cost outputs]:** low-cost add-on once the LLM already returns structured JSON — just add a rationale field to the schema.
- **[Optional auth] enhances [guest generation] but conflicts with nothing:** auth is strictly additive; guest path must never depend on it (guest-first per PROJECT.md).

## MVP Definition

### Launch With (v1)

Core Value is: repo-or-idea → correct service map → draw.io diagram + realistic monthly cost. Everything below is required to demo that value.

- [ ] Freeform description input (default, frictionless path)
- [ ] Repo URL input with README + manifest analysis (the differentiator)
- [ ] LLM inference → validated structured service list, with rule-based fallback (reliability floor)
- [ ] Draw.io diagram generation with official AWS icons (correct `strokeColor` patterns!)
- [ ] In-browser preview + `.drawio` download
- [ ] Cost estimate from AWS Price List API: region picker, per-service + monthly total, sensible defaults
- [ ] Scale simulator slider (100 → 1M users) with live recalculation
- [ ] Guest generation (no login required)

### Add After Validation (v1.x)

- [ ] Per-service rationale notes (why each service) — trivial once structured JSON exists; only add if demo feedback wants "explainability"
- [ ] Optional auth + saved history (re-open past analyses) — already in PROJECT.md Active; P2 because the core value works without it
- [ ] Guided questionnaire as an alternate input mode (default stays freeform) — PROJECT.md lists it as optional
- [ ] PNG/SVG export alongside `.drawio` — only if demo users ask for image export (draw.io can export, so LOW urgency)

### Future Consideration (v2+)

- [ ] Diagram regeneration from user edits (e.g., "replace RDS with DynamoDB") — AI-modify is every AI diagram tool's v2 (Visual Paradigm, Eraser); requires persistent analysis model
- [ ] Free-tier / always-free accounting in estimates (AWS calculator shows free-tier coverage) — nice trust signal, needs free-tier rules table
- [ ] Terraform/CloudFormation file upload as third input mode (Infracost pattern, diagram-as-code does CFN→diagram) — natural extension of repo analysis
- [ ] IaC generation from the diagram (anti-feature for v1, real product for v2)
- [ ] Multi-cloud — only if AWS path is fully proven

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Freeform description input | HIGH | LOW | P1 |
| Repo URL input + analysis | HIGH | MEDIUM | P1 |
| LLM inference + rule fallback | HIGH | MEDIUM | P1 |
| Draw.io diagram + preview + download | HIGH | MEDIUM | P1 |
| Cost estimate (Price List API, region, per-service + total) | HIGH | MEDIUM | P1 |
| Scale simulator slider | MEDIUM | MEDIUM | P1 |
| Guest generation | HIGH | LOW | P1 |
| Service rationale notes | MEDIUM | LOW | P2 |
| Optional auth + history | MEDIUM | MEDIUM | P2 |
| Guided questionnaire input | LOW | MEDIUM | P2 |
| PNG/SVG export | LOW | LOW | P3 |
| AI-modify (regenerate from edits) | MEDIUM | HIGH | P3 |
| Free-tier accounting | LOW | MEDIUM | P3 |
| IaC upload/parse | MEDIUM | MEDIUM | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Cloudcraft | AWS Pricing Calculator | Infracost | Cloudviz.io | AI diagram tools (diagrams.so, Cloudairy, VP) | Our Approach |
|---------|--------------|----------------------|-----------|-------------|-----------------------------------------------|--------------|
| Input: live AWS account scan | yes (Live Sync) | no | no | yes | no | **no** — repo/description instead (avoids IAM-role scope) |
| Input: repo/IaC | no | no | yes (Terraform/CFN/CDK) | no | paste-Terraform (diagrams.so) | yes — repo URL, README+manifests |
| Input: plain description | no | no | no | no | yes (all) | yes — freeform default |
| Diagram generation | manual drag-drop | no | no | auto from account | AI-generated | AI-generated draw.io XML |
| Diagram editing in-app | yes (full editor) | n/a | n/a | yes (toolbar) | yes (drag-drop after gen) | **no** — read-only preview, edit in draw.io |
| Cost estimation | yes (Budget, per-resource) | yes (150+ services) | yes (1,100+ resources) | no | no | yes — Price List API, defaults |
| Cost sources | live account billing | AWS Price List API | AWS pricing API | n/a | n/a | AWS Price List API (free) |
| Scale/what-if simulation | cost updates on edit | manual per-service config | usage file (static) | no | no | **one-slider user count → live recalc** |
| Region selection | yes | yes (comparison too) | via provider config | yes | no | yes, picker |
| `.drawio` export | no | n/a | n/a | yes (among others) | yes (diagrams.so native) | yes — native output format |
| PNG/SVG/PDF export | yes | n/a | n/a | yes | yes | v1.x add-on (draw.io can re-export) |
| Auth required | yes (SaaS account) | no (public tool) | yes (API key) | yes (trial signup) | credits/account | **guest-first**, auth optional |
| User needs AWS credentials | yes (account connect) | no | no | yes (cross-account role) | no | **no** — app's own read-only IAM |
| Cost optimization advice | no (Datadog CCM separately) | no | paid tier | no | no | no — slider shows sensitivity instead |
| History/versioning | version history | no | CI diffs | yes (change history) | no | optional auth → saved analyses |

## Sources

- Cloudcraft (Datadog) — product/solutions/pricing pages; SaaSworthy/G2 feature listings — https://www.cloudcraft.co/solutions, https://www.g2.com/products/cloudcraft/pricing (MEDIUM-HIGH)
- AWS Pricing Calculator — official features + cost-management docs (workload estimates, in-console vs public, region pricing) — https://aws.amazon.com/aws-cost-management/aws-pricing-calculator/features/, https://docs.aws.amazon.com/cost-management/latest/userguide/pricing-calculator.html (HIGH)
- Infracost — GitHub README + Spacelift/FinOpsForge overviews (1,100+ resources, usage files, PR diffs, paid guardrails) — https://github.com/infracost/infracost, https://spacelift.io/blog/terraform-cost-estimation-using-infracost (MEDIUM-HIGH)
- C3X comparison article — confirms Infracost feature gates (recommendations/CloudFormation paid) — https://c3x.dev/blog/infracost-alternative-open-source-terraform-cost-estimation (MEDIUM)
- Cloudviz.io — product page + docs (auto-generate, change history, export formats incl. draw.io, templates) — https://cloudviz.io/, https://docs.cloudviz.io (MEDIUM-HIGH)
- AWS Infrastructure/Application Composer — visual canvas + IaC sync + AI suggestions — https://aws.amazon.com/documentation-overview/aws-application-composer/, ranthebuilder.cloud wishlist (MEDIUM-HIGH)
- AI diagram generator landscape — diagrams.so (official icons, .drawio native, architecture warnings, Terraform→diagram), Visual Paradigm AI Studio (questionnaire flow), Cloudairy, Datadef, MockFlow, Eraser — https://diagrams.so/generate/aws-architecture, https://guides.visual-paradigm.com/ai-aws-architecture-diagram-generator/ (MEDIUM — fast-moving category)
- aws-architecture-diagram-skill — draw.io AWS icon `strokeColor` pattern documentation (icon correctness pitfall) — https://vidanov.github.io/aws-architecture-diagram-skill/ (MEDIUM-HIGH)
- awslabs/diagram-as-code — CFN→diagram, icon compliance, MCP (patterns for structured diagram output) — https://github.com/awslabs/diagram-as-code (MEDIUM)
- AWS Architecture Icons (official icon set + trademark guidelines) — https://aws.amazon.com/architecture/icons/ (HIGH)
- Cast AI + CloudForecast AWS Pricing Calculator guides — feature walkthroughs (groups, support costs, per-service config, 730h/month assumption) — https://cast.ai/blog/aws-pricing-calculator, https://www.cloudforecast.io/blog/aws-pricing-calculator (MEDIUM)

---
*Feature research for: AWS Architect (repo/idea → draw.io diagram + cost estimate)*
*Researched: 2026-08-07*
