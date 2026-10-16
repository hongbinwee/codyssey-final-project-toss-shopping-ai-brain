# Shopping Brain isolated implementation — 2026-10-16

Source base: main 782e67cd6efd815bc615830070e652b4b775567c
Branch: feature/brain-core. **Never write to main or existing Commerce migrations/data.**

## Implemented (code in branch)
- `src/brain/page-context.ts`: clean allowlisted client navigation hints, never in trusted system prompt.
- `src/brain/personalization.ts`: fixed-denominator heuristic candidate scorer, requirements/Commerce G2 gate, evidence ownership, missing important aspects and current request precedence; prices comparable when the user provided no budget.
- `src/brain/memory.ts`: test double and explicit server-proof contract; **not a production DB**.
- `src/brain/persistent-store.ts`: conversation ownership, idempotent user-message append, 10-minute pending preference proposal, one-use user confirmation within a transaction, persisted preference read/delete by authenticated actor. Production generic memory `put` intentionally throws.
- `src/brain/pg-adapter.ts`: dependency-injected postgres.js query and transaction boundary; **caller must supply a separate AI-owned connection**, never the global Commerce `sql`.
- `src/brain/read-flow.ts`: safe read-only sequence (owner -> user message -> memory -> intent -> retriever -> ranking) with step timings. Intent/retriever are injected ports and still require live implementations.
- `db/brain/001_brain_memory.sql`: independent AI-owned schema, composite tenant-bound foreign keys, NOT registered in Commerce phase migrations.
- `tests/brain-sandbox/brain-integration.test.mjs`: fake SQL and research flow regressions (NOT an actual PostgreSQL integration test).

## Isolated QA
On a separate local Node 22.16.0/TypeScript 5.8.3 sandbox, the equivalent standalone Brain source passed `tsc --noEmit` and 24/24 tests. The branch also contains its own tests. **Do not label full repository check, PostgreSQL, LangGraph, RAG, LLM or E2E PASS without running them independently on the branch.**

To run branch-specific tests on Node 24+:
```sh
node --experimental-strip-types --test tests/brain-sandbox/*.test.mjs
npm run check
```
These tests use an in-memory simulated SQL driver, not production DB.

## Important blocked gates before enabling real users
1. **No active LangGraph runtime:** `@langchain/langgraph` is absent from current root package and lock. Do not manually edit lock or activate graph until dependency install and typed compile are independently checked.
2. **No actual PostgreSQL migration executed.** Only opt-in, newly provisioned AI-owned database with an approved migration procedure. Never use Commerce `DATABASE_URL` or protected scratch. Verify FKs, tenant isolation, concurrent proof consumption, rollback, restart and cleanup.
3. **No API routes/UI for conversation creation, preference approval or deletion.** Caller must pass server-verified `actorUserId`; receiving a client string is NOT authentication. `proposePreference` must not be called as proof of user consent; explicit confirmation still required.
4. **No real Retriever Adapter/LLM Intent Adapter/grounded response generator.** Evidence IDs and facet scores are trusted adapter input only. Amazon/RAG team must map Commerce IDs, verified whole-product review counts and provenance. Until verified counts exist, G2 candidates remain reference-only.
5. **No Commerce write integration**. Existing AI_LIVE_DEMO stays READ-only. A future Graph cannot bypass Commerce Tool risk/version/idempotency/server approval boundaries.
6. The personalized heuristic weights/coverage are experimental. Compare with non-personalized baseline, holdout coverage, accuracy, missing facts and preference reversal before claiming recommendation quality.
7. Operational memory requires retention/deletion policy, access audit, role separation and user-facing controls. Adding `shopping_brain` tables alone is not sufficient.
8. No endpoint or `feature/brain-core` merge into main until independently reviewed and verified.

## Immediate next work
- Test full source/lock in an isolated repository checkout with Node 24.
- Implement and run separate Postgres environment and explicit schema setup/teardown.
- Install LangGraph with generated lockfile; compile a small checkpointed StateGraph against `read-flow` (do not reinterpret Graph checkpoint as authorization).
- Implement authenticated server-owned conversation API, preference-approval UI, LLM Intent Adapter and grounded explanation.
- Wire team Retrieval and controlled Cart approval when ready; compare p50/p95 latency and personalization A/B.
