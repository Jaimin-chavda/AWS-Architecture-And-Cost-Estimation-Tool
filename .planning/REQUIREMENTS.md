# Requirements

**Project:** AWS Architect
**Version:** v1
**Gathered:** 2026-08-07

## v1 Requirements

### Input

- [ ] **INPT-01**: User can paste a GitHub repo URL and the app fetches the README plus key manifests (package.json, Dockerfile, docker-compose, serverless.yml) for analysis
- [ ] **INPT-02**: User can paste a freeform project description and generate a result without any GitHub access
- [ ] **INPT-03**: Both input modes (repo URL, freeform description) converge on the same analysis pipeline and produce the same downstream output (diagram + cost)

### Inference

- [ ] **INF-01**: App produces a structured service list (service code + quantity model + optional links) from the repo files or description
- [ ] **INF-02**: A deterministic rule-based engine maps repo files and keywords to AWS services and runs first as a guaranteed baseline (works with zero API keys)
- [ ] **INF-03**: An LLM enhancement pass (cheap/free tier provider) runs after the rules and is merged with the rule output
- [ ] **INF-04**: LLM output is validated against a fixed AWS service catalog (allowlist); invalid services are rejected, and on validation failure the app falls back to the rule-based result
- [ ] **INF-05**: Service list is validated against a schema before any diagram or cost generation happens

### Diagram

- [ ] **DIAG-01**: App generates a draw.io deployment diagram (mxGraph XML) using the official AWS architecture icons
- [ ] **DIAG-02**: App shows an in-browser preview of the generated diagram (official draw.io embed iframe)
- [ ] **DIAG-03**: User can download the diagram as a `.drawio` file that opens correctly in real draw.io
- [ ] **DIAG-04**: Diagram and cost are generated from the same validated service list (single contract — they must never diverge)

### Cost Estimation

- [ ] **COST-01**: App fetches real AWS prices (Price List Bulk files or Query API) for the services in the list
- [ ] **COST-02**: User can select an AWS region via a picker (default us-east-1); prices and cost update for that region
- [ ] **COST-03**: App shows a per-service cost breakdown and a monthly total, using sensible per-service defaults for quantity when no usage is specified
- [ ] **COST-04**: Cost estimates price on-demand rates and carry a disclaimer that the estimate is not a bill (free-tier, transfer, and other charges excluded)

### Scale Simulator

- [ ] **SIM-01**: User can adjust a user-count slider (100 → 1M users) and see service quantities scale according to a per-service model (e.g. requests/user/month, storage/user)
- [ ] **SIM-02**: Total cost recalculates live as the slider moves

### Auth & History

- [ ] **AUTH-01**: User can generate diagrams and cost estimates as a guest without logging in
- [ ] **AUTH-02**: User can create an account with email/password and log in
- [ ] **AUTH-03**: Logged-in user's analyses (service list, diagram, cost) are saved and can be re-opened from a history list

## v2 Requirements (deferred)

- [ ] Per-service rationale notes ("why we chose this service") rendered as expandable notes
- [ ] Guided questionnaire as an alternate input mode (default stays freeform)
- [ ] PNG/SVG export alongside `.drawio`

## Out of Scope

- In-app diagram editor (drag/drop, move/relabel nodes) — read-only preview, users edit in draw.io. Reason: months of scope, draw.io is already the output format.
- Live AWS account scanning / "connect your AWS" — requires cross-account IAM roles and security review. Reason: enterprise scope, kills university timeline.
- IaC generation (CloudFormation/Terraform from diagram) — different problem entirely. Reason: v2+ research project.
- CI/CD integration (PR cost-diff comments) — requires GitHub Apps and webhooks. Reason: local demo is the target.
- Team collaboration / multi-user editing / shared links — real-time sync infrastructure. Reason: single-user history under optional login is enough.
- Savings Plans / Reserved Instance / discount modeling — requires account usage history. Reason: on-demand list prices only.
- Multi-cloud (Azure/GCP) — doubles icon sets and pricing APIs. Reason: AWS-only for the SGP.
- Full source code scan (every file) — README + manifests catches ~80% of infra signals. Reason: slow, expensive, low signal-to-noise.

## Traceability

| Phase | Requirements | Status |
|-------|--------------|--------|
| (pending roadmap) | | |

---
*Last updated: 2026-08-07 after research + scoping*
