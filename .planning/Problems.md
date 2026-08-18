## Flaws / Underspecified Areas in the Current Plan

**1. GitHub repo fetching has no depth/size bound defined**
"README + key files" isn't scoped. What counts as a "key file" in a monorepo with 40 services? What's the file size cap before you truncate or skip? Without this, either the GitHub API fetch is slow/expensive on large repos, or the LLM context gets flooded with irrelevant files. Needs an explicit file-selection heuristic (e.g., max depth 2, manifest files + top-level configs only, hard byte cap per file).

**2. Multi-service / monorepo detection isn't addressed**
The whole pipeline assumes one repo = one deployable unit = one architecture pattern. A monorepo with a frontend, an API, and a worker is common and breaks the single-pattern-template assumption entirely. Either explicitly scope this out ("single-service repos only") or the pattern classifier needs a "multi-service" escape hatch that composes multiple pattern templates — undecided right now.

**3. Region picker interacts with the Price List API cache scheme awkwardly**
If the user changes region on the slider/diagram screen *after* the initial analysis, does that trigger a fresh Price List API batch call for the new region? The plan caches per (region, service) but doesn't say whether region-switching is a "cheap cache lookup if pre-warmed" or "wait for a live API round-trip" — this affects perceived responsiveness of a supposedly "live" cost UI.

**4. Freeform idea input has no grounding check**
When a user types "a real-time chat app," the LLM infers services with zero code to verify against. There's no confidence floor or hallucination guard for freeform-only inputs — this path is strictly weaker signal than repo analysis but the plan treats both paths as equally reliable outputs. Worth capping freeform-only confidence similarly to the "no explicit config" case, and surfacing that distinction in the UI.

**5. No versioning/staleness handling for LLM provider swaps**
Plan says "researcher validates best fit" for LLM provider but doesn't define a stable output contract independent of provider choice. If DeepSeek's structured JSON reliability differs from Gemini Flash's, the fallback-trigger threshold (schema validation failure → rules engine) needs provider-specific tuning that isn't flagged as a task anywhere.

**6. Cost estimate defaults aren't sourced anywhere in the plan**
"Sensible per-service defaults" for the base estimate (before the slider moves) — where do these baseline usage assumptions come from? Industry benchmarks? Arbitrary guesses? Without a documented default-assumption table per service type, the "monthly cost estimate" has no stated basis and will look arbitrary/wrong to anyone evaluating the demo.

**7. History/auth data model isn't scoped at all**
"Optional login saves analysis history" — no schema, no decision on whether saved history includes the diagram file, the cost snapshot at time of analysis, or both, and whether re-opening history re-fetches live prices or shows the frozen snapshot (this last one actually matters given the caching decision above — snapshots should almost certainly be frozen, not live-recalculated, but this isn't stated).

**8. No fallback for repos with zero usable signal**
Empty README, no manifests, obfuscated/generated code — the plan has fallback logic *within* the inference step (LLM → rules) but no fallback for the case where extraction itself yields near-empty `RepoSignals`. This should surface as an explicit "insufficient signal" user-facing state rather than silently producing a low-confidence guess that looks like a normal result.

- Items 1, 2, and 8 are the most likely to actually break the demo (large/monorepo/empty-signal repos are realistic test cases a professor might try).
- Item 6 is the one most likely to undermine credibility of the "core value" proposition even if everything else works — an unsourced cost number is worse than no cost number.
