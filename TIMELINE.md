# Weekly Report Timeline (13-07-2026 → 18-10-2026)

Template per report: **Module** table → **Work done** (this week) → **Plans for next week** → **References** → signatures.
W1 and W2 are already submitted — content below matches them so the sequence stays consistent.

| # | Work-done dates | Theme | What to write in the report |
|---|-----------------|-------|-----------------------------|
| W1 | 13-07 → 20-07 | Requirements & problem statement | **DONE.** Requirement gathering; 4 modules scoped (A Architecture Advisor, B Cost Monitoring, C Resource Optimization, D Security Scanner); comparative study (Cost Explorer, CloudHealth, Cloudability); tech stack finalized (Node.js, React, TimescaleDB, AWS SDK v3, Bedrock); PRD + requirement IDs; 13-week roadmap |
| W2 | 20-07 → 26-07 | SRS & design | **DONE.** Full SRS (functional + non-functional); feasibility study (technical/operational/economic); use-case diagrams; Level-0/1 DFDs; three-tier architecture outline; draw.io XML output contract + closed-pattern template decision |
| W3 | 27-07 → 02-08 | Phase 1 — pipeline skeleton | Scaffolded repo (Next.js frontend, Node/Express backend, TimescaleDB) + folder structure; ESLint/Prettier + CI; `ServicePlan` TypeScript + zod schema as the single output contract; draw.io (mxGraph) XML generator; in-browser embed preview on hardcoded data; `.drawio` download verified in real draw.io |
| W4 | 03-08 → 09-08 | Phase 1 finish + real inputs | Golden-file XML tests (deterministic output); Phase 2: GitHub REST integration — README + manifest fetch (package.json, Dockerfile, docker-compose, serverless.yml); input validation + SSRF host allowlist; per-repo cache. Repo URL path produces first real diagram |
| W5 | 10-08 → 16-08 | Phase 2 finish + rule engine | Freeform description path, both inputs converging on one `POST /api/analyze` pipeline; Phase 3: keyword/pattern rule engine → fixed AWS service catalog; schema validation gate before diagram/cost — app fully works with zero API keys |
| W6 | 17-08 → 23-08 | Phase 3 finish + LLM pass | Golden-set tests (10 varied inputs, every service in catalog); Phase 4: LLM inference over Bedrock via `generateObject` + zod; catalog allowlist gate; hallucinated-services rejection sample; retry → rules fallback |
| W7 | 24-08 → 30-08 | LLM hardening + diagram polish | Provider fallback chain (DeepSeek/Gemini/Groq class) + graceful degradation tests; confidence tiers + "description-only" banner; diagram polish (official AWS icons, pattern templates, node/edge rendering). Module A feature-complete end-to-end |
| W8 | 31-08 → 06-09 | Cost engine (Module A) | Real AWS price data (Bulk offer files / Pricing Query API + cache, defaults fallback); region picker; per-service cost table + monthly total; user-count slider (100 → 1M) with live client-side recalculation; assumptions/disclaimer disclosure. Module A: input → diagram → cost complete |
| W9 | 07-09 → 13-09 | Module B — cost monitoring | Daily Cost Explorer ingestion; 7-day rolling average per service; spike flags (> avg × 2.0); spike ranking by $ impact; 30-day trend chart; email alert path |
| W10 | 14-09 → 20-09 | Module C — resource optimization | Daily scans: idle EC2, unattached EBS, unused EIPs, oversized RDS, missing S3 lifecycle, idle ELBs; $ savings estimate per finding; sort by savings; dismiss action |
| W11 | 21-09 → 27-09 | Module D — security scanner | 12 CIS-aligned checks (public S3, open SG ports, IAM MFA, root account, wildcard policies, unencrypted RDS/EBS, CloudTrail…); severity ranking; remediation steps; diff vs previous scan |
| W12 | 28-09 → 04-10 | Integration & polish | Unified 4-module dashboard; email delivery wiring (SES); guest-first throttle + auth/history (better-auth + SQLite) if time permits; E2E + performance pass; demo walkthrough debug |
| W13 | 05-10 → 11-10 | Testing & hardening | Unit/integration/E2E coverage; requirement traceability (verify each requirement ID); bug-fix sprint; SRS/design docs finalized to match shipped build |
| W14 | 12-10 → 18-10 | Final submission | Project report compilation; weekly-report consistency check; viva/presentation prep; deployment/run notes for the mentor demo |

## Suggested references by phase
- **W3–W4:** mxGraph/draw.io docs (drawio.com), GitHub REST API docs.
- **W5–W7:** AWS Well-Architected — Operational Excellence pillar; Anthropic prompt-engineering guide (structured JSON).
- **W8:** AWS Pricing API docs (Bulk + Query); AWS free-tier limits (defaults source).
- **W9–W11:** AWS Cost Explorer API; Compute Optimizer docs; CIS AWS Foundations Benchmark.
- **W12–W14:** IEEE Std 830-1998 (SRS); OWASP/secure-session practices (auth).