**Hindsight and Inngest are key-gated, and boot refuses a server that isn't.** An unkeyed Hindsight lets anything on its network read and write every memory bank; an unkeyed Inngest lets it post `adapter/direct/inbound` (a user turn) or `coding/task/plan-approved` (a plan approval).

- **Credentials:** `HINDSIGHT_API_KEY` is required and sent by both Hindsight clients; the server runs `ApiKeyTenantExtension` with the same value. `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are required unless `INNGEST_DEV` is set. All three accept `_FILE`.
- **Boot checks:** `checkHindsightAuth` and `checkInngestAuth` fail boot when a server answers an unauthenticated request or rejects Cogmo's key, using probes with no side effects. They run with the S3 bucket and Hindsight version checks for `cogmo serve`; `migrate-memories` and `backfill` run the Hindsight checks too.
- **Fail closed:** a deterministic verdict — rejected key, unkeyed server, version out of range, missing or wrong-region bucket — fails at once; an unreachable or inconclusive dependency is retried for up to 60 s, then boot fails with the last reason.
- **Config validation:** a `HINDSIGHT_URL` or `INNGEST_BASE_URL` containing `user:password@`, and a half-set S3 key pair, are rejected at startup.
- **Errors and logs:** request failures report their network cause, and credentials in quoted URLs are scrubbed from boot errors and retry logs.
- **Dev and test:** Hindsight containers enforce a fixed test key; `checks.integration.test.ts` pins the probe premises against the pinned images.

Keys don't cover every route: see `DEPLOYMENT.md` → *Securing internal services* (`--no-ui`, private ports, Redis and Postgres passwords).

**Breaking:** `cogmo serve` requires `HINDSIGHT_API_KEY` with a matching Hindsight tenant extension and, unless `INNGEST_DEV` is set, Inngest keys matching a keyed `inngest start`. A dependency unreachable for 60 s fails boot instead of logging a warning; credential URLs and a half-set S3 key pair are rejected.
