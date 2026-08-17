The dev/test container pins move to `inngest/inngest:v1.41.1` and `gitea:1.27.2`, which the npm sweep couldn't reach.

Inngest is the load-bearing half. The SDK went 4.5.1 → 4.18.1 in the 2026-08 sweep while the dev/test server stayed on v1.27.0, leaving roughly fourteen minors of client/server skew that only the integration tier exercises — connect mode, the coding orchestrator's `step.waitForEvent` paths, the durable-sleep timers. Gitea is the git-remote fixture behind the coding-delegation tests and is lower stakes, but it was pinned two years back.

Two places pin gitea, not one: `dev/containers.ts` and `verify-orchestrator.integration.test.ts` each name the image, so both move together rather than leaving the verify fixture a version behind. The docker tag is `1.27.2` without the `v` that the git tag carries.

Validated the way the entry asked for — the full integration tier against the new images, 27 files and 147 tests green.
