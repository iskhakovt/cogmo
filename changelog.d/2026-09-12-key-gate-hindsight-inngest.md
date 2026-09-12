**Hindsight and Inngest are key-gated, and boot refuses a server that isn't.** Both were protected only by their network position: anything that could reach `HINDSIGHT_URL` read or wrote any memory bank, and anything that could reach `INNGEST_BASE_URL` could post `adapter/direct/inbound` (a user turn) or `coding/task/plan-approved` (a plan approval).

- **Hindsight:** `HINDSIGHT_API_KEY` is a new **required** env var (also `HINDSIGHT_API_KEY_FILE`). Both Hindsight clients send it as a bearer token — the class wrapper and the raw sdk client used for recall and reflect. The server must run `ApiKeyTenantExtension` with the same value in `HINDSIGHT_API_TENANT_API_KEY`.
- **Inngest:** outside `INNGEST_DEV`, `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are now required, and both accept `_FILE`.
- **Boot checks:** new `checkHindsightAuth` and `checkInngestAuth` hard-fail when a server answers an unauthenticated request, or rejects the key Cogmo holds. A key the server ignores is worse than no key, because it is believed to protect something. Probing leaves no trace: Hindsight gets a bank list, Inngest gets `GET /v1/events` plus an empty event batch.
- **Dev and test:** the Hindsight containers enforce a fixed test key, so every integration and e2e run exercises the authenticated path. `checks.integration.test.ts` pins the premises against the pinned images: keyed `inngest start` refuses both probes, `inngest dev` refuses neither.

Verified against the pinned images before writing code. Keys do not cover everything:
- **Inngest:** v1.41.1 still serves its dashboard and GraphQL API without auth, including the `invokeFunction` and `rerun` mutations. `DEPLOYMENT.md` → *Securing internal services* covers `--no-ui` and keeping ports 8288/8289 private.
- **Hindsight:** 0.9.1 leaves `/health`, `/version`, `/metrics` and `/docs` open.

**Breaking for existing deployments:** set `HINDSIGHT_API_KEY` in Cogmo and the tenant extension on Hindsight, and run Inngest keyed, before upgrading.
