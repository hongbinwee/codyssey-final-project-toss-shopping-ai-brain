# Brain v9 — canonically fenced LangGraph checkpoint publication

**Isolation requirement:** only `feature/brain-core`. No push/merge to `main`, no Commerce migration, no live database destructive write, no autonomous Cart/Checkout/Cancel.

## Scope and implementation

The previous v7/v8 implementation used a session advisory lock, independent observer validation, and after-node checks. That design could lose ownership in the time-of-check/time-of-use gap before PostgresSaver writes. Pinned `@langchain/langgraph-checkpoint-postgres@1.1.0` persists checkpoints, incremental writes and blobs on independently managed database connections, so a caller-side pre-check is not a transactional fence.

**v9 uses isolated checkpoint generations + one row-locked canonical publication.** This provides the required **visible-state fencing** without reimplementing the upstream PostgresSaver:

- `db/brain/002_brain_fencing.sql` creates `shopping_brain.turn_fence` (per-conversation monotonic generation, active attempt, latest published action) and `shopping_brain.turn_receipts` (immutable action digest, generation/attempt, PENDING/COMPLETED, optional result+physical checkpoint thread).
- `scripts/brain-migrate.ts` applies 001 then 002 ONLY after explicit `BRAIN_MIGRATE_APPROVED=1` and separate AI database isolation guard. Existing Commerce migrations are untouched.
- `src/brain/fenced-turns.ts` atomically claims the next generation and private, randomly generated physical Checkpoint thread. Completed same-action receipt replays; same action ID with different message rejects.
- `src/brain/graph.ts` injects the latest **published result** into a new isolated graph run to carry forward prior Shopping Plan. Source user message still uses the logical conversation ID and remains idempotent by client Action ID. Only after `compiled.invoke` fully returns, with validated result and lock ownership, is the attempt published.
- `FencedTurns.publish` locks `turn_fence`, compares `(generation,active_attempt_id)`, writes the completed receipt and updates `published_action_id` in the SAME SQL transaction. Old generations fail this CAS. Unpublished checkpoint rows, writes and blobs remain in the abandoned attempt thread, unable to overwrite the newer physical thread or published pointer.
- `graph.getOwnedState` resolves the canonical pointer, loads that **exact physical thread** from PostgresSaver, then cross-checks its message+action ID against the published receipt. It never returns an uncommitted attempt's result.
- `src/brain/runtime.ts` enables FencedTurns for authenticated Brain HTTP in its AI-only DB. Existing isolated test paths without fencing preserve compatibility, but do NOT imply multi-worker canonical fencing.

## Properties and explicit limits

| Claim | Outcome |
| --- | --- |
| Only a current-generation completed result becomes canonical | Protected by atomic DB CAS |
| Stale previous worker's checkpoint / writes / blob updates can overwrite successor | No; each attempt uses its own physical checkpoint thread |
| Previous completed Shopping Plan persists to next turn | Graph seeds from the canonical completed result; requires real multi-turn QA |
| A failed/interrupted turn remains invisible as completed | Canonical pointer remains on previous completed action |
| Same completed Action ID and same body replays | Receipt is returned without model/RAG invocation |
| Same Action ID, different body | Explicit conflict |
| Provider / remote LLM exactly once | **NOT PROVIDED**; a retried read-only operation may invoke the provider again |
| Automatic Commerce writes exactly once | **NOT PROVIDED**; Cart/Checkout/Cancel remain disabled |
| Existing v8 conversations automatically migrated | **NO**. Populated legacy checkpoint is preserved and safely blocked pending explicit migration review |
| All abandoned checkpoint blobs/attempts automatically erased | **NO**. Define retention, erasure and cleanup before production |

The physical Saver can still write to an abandoned generation after loss of ownership. Those writes are **not canonical**, but may consume storage. The mechanism does NOT guarantee `put()` and `putWrites()` each atomically check ownership, and should be described as **canonical result fencing**, not global suppression of all writes. All participants must share one authoritative AI PostgreSQL instance.

The only in-scope user-visible side effect is the append-only source user message, protected with unique `(conversation_id,client_action_id)`. Other external operations remain read-only. User-authenticated ownership checks precede state access and action claim.

## QA plan and acceptance gates

1. Isolated disposable `brain_ci` migration and idempotent row creation; verified 001→002.
2. V9 multi-turn 500,000→300,000 KRW budget carryover, required conditions, new product category reset, unique per-attempt checkpoint IDs, same-action replay and cross-user isolation.
3. Actual `SIGKILL` Node worker in RAG; no canonical result for incomplete generation, replacement generation succeeds with one source message.
4. Inject `PostgresSaver.put()` acknowledgment loss after a committed partial checkpoint; canonical previous result unchanged, new attempt publishes, revision progresses once.
5. Race: kill old worker's advisory-lock DB session mid-RAG, let next worker publish, release old worker, verify old result stays PENDING and cannot replace new.
6. SQL stale-generation CAS and client Action ID mismatch; old generation is rejected without modifying latest pointer.
7. Failure-mode 429/504 explicitly retried with saved memory/shopping plan; typed API errors, no hidden paid retry.
8. Full existing Brain CI (typecheck, frontend build, isolated unit, PostgreSQL, HTTP/Mock RAG, Chromium). Legacy Commerce broad unit audit remains **non-gating**; cannot claim full Commerce PASS.

**DO NOT claim final PASS until CI on the final branch HEAD has succeeded.** State the exact run SHA and the observed test counts; redact connection secrets.

## Follow-up gates before a public release

- **Legacy v8 migration:** human-approved read-only inventory of populated logical conversation checkpoints and deterministic import of validated last completed result into v9 receipts. Never silently reset a stored plan. This release blocks legacy un-migrated conversations with a generic safe error.
- **Security/privacy:** distributed rate limiting and CSRF, checkpoint attempt retention and automatic cleanup design, account-wide erasure/tombstone procedure, backup retention and remote provider privacy. Full-erasure API not installed here.
- **Operational:** database cluster failover / network partition / PITR, data ownership validation and raw checkpoint authorization; current CI uses one isolated PostgreSQL service.
- **Quality:** real RAG audited provenance + candidate/variant mapping, live model evaluation and cost/latency p50/p95, independent blind review, accessibility/mobile testing, 5+ real users. Existing mock latency is not real model performance.
- **Approval-gated actions:** require Commerce's own idempotency and user confirmation before adding Brain write tools, regardless of v9 read-only fencing.
