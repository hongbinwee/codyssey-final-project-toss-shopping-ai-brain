# EVALUATION_REPORT — Shopping Brain v2 audit checkpoint (2026-10-16)

## Identity, branch and truth in reporting
- All code/docs/test commits confined to `feature/brain-core`; DO NOT merge to `main`.
- No outside LLM was called, no RAG team's actual v4/v5 ZIP was mounted and no genuine Amazon review data was imported.
- Audit was performed in a **separate analytical pass by the same assistant**. That is code review, NOT a second independent human reviewer or blind adjudication. The latter is still explicitly pending.
- The 60-case dataset remains `EVALUATION_ONLY`, synthetic language only, never usable for actual product/review database or model training.

## Defects and disposition
| ID | Disposition | Result |
| --- | --- | --- |
| AUD-01 | **PARTIAL** | `intent-v2.json` expanded to 60; 45 development / 15 **candidate** holdout. `reviewer-blind-v2.json` contains cases without author gold. No independent reviewer adjudication yet. |
| AUD-02 | **FIXED & TESTED** | New-category `queryMode=SET` + `requirementsMode=ADD` no longer carries requirements from prior product. A unit regression demonstrates reset and same-task ADD. |
| AUD-03 | **OPEN** | Existing mock RAG HTTP fixtures simulate REAL-shaped provenance. Matching an upstream-reported audit ID does not independently certify source-wide review counts or a legitimate Amazon review. Must reconcile against verified external manifest before production. |
| AUD-04 | **PARTIAL** | `DATA_ISOLATION_POLICY.md` + `src/brain/data-isolation.ts` and negative tests forbid mixed data-class manifests at that validation boundary. This is not yet wired to future team ETL/vector ingestion. |
| AUD-05 | **PARTIAL** | Identical in-flight action coalescing, conflicting turn 409, tenant isolation and failed-retrieval restart/replay tested in PostgreSQL. Multiple replicas, 429/hard timeout, crash during node execution and retention remain open. |
| AUD-06 | **OPEN** | Ranking weights are heuristic; no verified source aspect score quality, statistically valid relevance/fairness evaluation, real user results. |
| AUD-07 | **OPEN** | Evidence-ID binding is structurally tested; review natural-language factual correctness not tested. |
| AUD-08 | **PARTIAL** | Separate versioned eval report and v1/v2 splits; live token cost and external LLM response time have NOT been measured. |
| AUD-09 | **PARTIAL** | PostgreSQL and Chromium now demonstrate that canonical preference DELETE succeeds while source message/checkpoint remain. The UI explicitly scopes deletion. Full user transcript/checkpoint erasure is NOT implemented. |

## Evaluation protocol details
- `eval/brain/intent-v1.json`: 12 initial synthetic examples retained for backwards compatibility.
- `eval/brain/intent-v2.json`: 60 synthetic cases, including budget carryover/replace/reset, requirement add/replace/clear, new category, preference override, quoted malicious-looking text, combined updates.
- `eval/brain/reviewer-blind-v2.json`: 60 **label-free** cases to give to a second independent reviewer. **Do not show them the answers before annotating.**
- `src/brain/evaluation-rubric.ts`: exact query and budget, order-insensitive but duplicate-sensitive hard constraints, key-order-insensitive current preference map. Mutation test deliberately changes budget/preferences and verifies failure.
- `scripts/brain-intent-eval.ts --gold-replay --dataset=v2`: exercises authored model-output fixtures against expected final plan. **This is NOT actual model accuracy** and high scores here do not validate a product recommendation.
- `--live`: only explicit opted-in external model call, not run here.

## Latest CI evidence (repository branch, disposable resources only)

[GitHub Actions run #38912870232](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/38912870232) — PASS for branch code through blind reviewer template addition.

| Scope | Result | Evidence qualification |
| --- | --- | --- |
| Isolated Brain unit/contracts | **64/64 PASS** | Mock/structural only |
| V1 gold replay | **12/12 PASS** | User-authored answer replay, NOT LLM |
| V2 gold replay | **60/60 PASS** | Assistant-authored answer replay, NOT LLM |
| Full TypeScript, production frontend build | PASS | Build integrity |
| Isolated PostgreSQL, checkpoint persistence/recovery | PASS | Fresh temporary CI database |
| Authenticated Brain HTTP and fake RAG protocol tests | PASS | Both mocked upstream |
| Playwright Chromium and injected model/RAG errors | PASS | Local Responses/RAG mock, not production |
| Existing Commerce broad non-gating unit audit | **625 PASS / 6 FAIL** | Untracked historical snapshot paths and missing DATABASE_URL; `restricted-reset.test.ts` NOT RUN |

Six legacy failures are not waived as “PASS”: `evidence-broker.test.ts`, `isolated-smoke.test.ts`, `isolated-suite.test.ts`, `mock-guard.test.ts`, `readonly-audit.test.ts` and the protected preflight fixture assertion. Review those suites separately with authorized fixtures; do not bring protected dump bytes into public CI.

## Release / integration gates still unmet
1. Independent human or independent model **blind label review** plus adjudication of disagreements; candidate_holdout is NOT yet a validated holdout.
2. Data manifest and synthetic/real isolation enforcement **in the actual ETL/RAG/vector-store loader**, once team's v4/v5 package is available.
3. Real model evaluation, cost, p50/p95, JSON validity, retry/429 and content quality on approved test budget.
4. Grounding and aspect score audit against legitimate source data; no fake real reviews.
5. Production privacy erasure, multiple-replica concurrency and full Commerce regression with authorized environment.

**Decision**: proceed with isolated feature-branch development and blind label review. NOT READY to merge, declare model-quality PASS, or ingest into real data.

## Follow-up — concurrency, restart and deletion semantics

[Brain QA run #38914618873](https://github.com/hongbinwee/codyssey_final-mission-main/actions/runs/38914618873) PASS: 64/64 Brain isolated contract tests, 5/5 PostgreSQL tests (including same-action coalescing, 409 contention, crash/retry, scoped deletion), authenticated HTTP, mock RAG and real Chromium UI. Chromium verifies that deleting a remembered price preference displays an explanation that previous conversations and task plans may still exist. Existing broad Commerce non-gating audit remains 625 PASS / 6 FAIL. Follow-up document: `docs/BRAIN_V6_CONCURRENCY_PRIVACY_QA.md`.

**Do not infer production multi-instance locking or full privacy erasure from these PASS results.** Tests use a disposable CI database. A separate audited design and clean-room operational erasure protocol remain a release blocker.
