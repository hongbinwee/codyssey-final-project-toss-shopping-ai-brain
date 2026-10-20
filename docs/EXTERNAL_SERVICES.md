# External catalog and RAG configuration

This repository includes the frontend, Commerce backend and Shopping Brain integration code. The DGX-hosted RAG service implementation, PostgreSQL catalog contents, source datasets and embeddings are managed separately and are not bundled here. External access requires an approved Tailscale connection and credentials provided privately by the server owner.

## Storage boundaries

- DATABASE_URL / DATABASE_PASSWORD_FILE: local business database containing users, carts and orders.
- BRAIN_DATABASE_URL: existing Brain database containing conversations, approved preferences and checkpoints. Keep it separate from the catalog and preserve it during dataset switches.
- CATALOG_DATABASE_URL / CATALOG_DATABASE_PASSWORD_FILE: external PostgreSQL catalog connection. COMMERCE_CATALOG_SOURCE=test_items2 selects the catalog schema. Never replace the business database URL with the external catalog URL.
- External catalog sessions enforce default_transaction_read_only and TLS verification. Migrations and seed commands must target a separate local development database, never DGX. Remote-catalog cart/order writes remain subject to the application's existing safety restrictions; do not bypass them.

## Private environment example

Start from .env.example; set real values only in a Git-excluded server environment file.

```dotenv
COMMERCE_CATALOG_SOURCE=test_items2
CATALOG_DATABASE_URL=postgresql://<approved-user>@<dgx-host>:5432/toss
CATALOG_DATABASE_PASSWORD_FILE=<private-password-file>
CATALOG_DATABASE_SSL_CA_FILE=<trusted-ca-file>
# Optional certificate pin in addition to normal chain/hostname verification:
CATALOG_DATABASE_SERVER_CERT_FILE=<verified-server-certificate-file>
# Set only when an administrator role has been explicitly approved:
CATALOG_DATABASE_APPROVED_ADMIN_ROLE=
BRAIN_ENABLED=1
BRAIN_RAG_MODE=remote
BRAIN_RAG_URL=https://<dgx-host>:8002/v1/rag/search
BRAIN_RAG_PROFILE=test_items2
BRAIN_RAG_CONTRACT=v4
BRAIN_RAG_DATASET_VERSION=<exact-server-dataset-version>
BRAIN_RAG_CATEGORY=
BRAIN_RAG_TOKEN=
BRAIN_DATABASE_URL=postgresql://<brain-user>@<local-host>:<port>/<existing-brain-db>
SESSION_SECRET=<private-random-secret>
LLM_API_KEY=<private-provider-key>
```

Set LLM_BASE_URL, LLM_API_FORMAT and LLM_MODEL for the approved provider. Set OPENAI_DECISIONS_API_KEY separately if using BRAIN_ROUTE_MODE=decisions. BRAIN_PUBLIC_ORIGIN must match the actual HTTPS origin. Six-user QA authentication requires the existing private QA_AUTH_FILE and session settings; no real login codes or hashes are distributed in this repository.

The target catalog has 1,500 products, 1,917 variants and 46,100 reviews across beauty, fashion, food and living. Confirm counts, exact dataset version and product/variant/review identifiers against the external service before declaring a deployment verified. The v4 contract name denotes the API format, not the active dataset's age. Supplied chunks and embeddings are reused; this integration does not require their regeneration.

## Verification and rollback

Check RAG /healthz and POST search with profile test_items2, then compare result identifiers and dataset version with read-only catalog queries. Validate authenticated product/detail/review and Brain API flows. LLM errors and review evidence coverage must be evaluated independently from DB/RAG connectivity. An unavailable external service must not be reported as a successful live test.

Keep previous private environment files and databases outside Git. Restore a previously verified local configuration to roll back; do not overwrite catalog data, user state or Brain history. Database provisioning and external access are prerequisites: this repository alone does not grant access or recreate the full DGX dataset.

## Submission provenance

Source branch: feature/brain-core. Source commit: 2a9cc6ccebcb92ea06f8d3528484d80c16dabefb. The submission preserves its reachable development history; the following packaging commit selects submission files without changing application behavior. Historical documents can describe earlier project states. README and the final user-test report will be prepared separately.
