Integration tests now get a per-fork Inngest app id so the connect-mode gateway can't cross-deliver events between worker processes when multiple files participate in the same run.

`src/inngest/client.ts` reads `INNGEST_APP_ID` (default `"cogmo"`); `test/integration-setup-per-fork.ts` sets a unique `cogmo-test-<UUID>` value in each fork before module imports. Same trigger across forks reaches multiple apps, so pipeline's OTel metric assertions now poll `collectMetrics()` until both `cogmo.agent.iterations` and `cogmo.llm.tokens` appear in one snapshot (DELTA temporality drains on read; one call must observe everything).

While here, replaced ad-hoc `while (Date.now() - start < timeout) { check; sleep }` poll loops with `vi.waitFor` across pipeline, pipeline.mcp, skill-authoring, smoke.e2e, memory, reconcile-on-failure, backfill-profile-class, and migrate-untagged-memories.
