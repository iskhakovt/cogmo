**The runtime image no longer ships a TypeScript compiler, PGlite, or react.** The image's `pnpm deploy` gains `--no-optional`, and `@inngest/ai` moves to 0.1.8. `node_modules` in the image goes 450 MB → 365 MB and the image itself 199 MB → 176 MB.

`--no-optional` is documented as skipping `optionalDependencies`, and that reaches further than it sounds: pnpm materialises auto-installed optional *peers* into a snapshot's `optionalDependencies` regardless of `peerDependenciesMeta.optional` (pnpm/pnpm#11155), so the flag covers them too. Every heavyweight passenger arrived that way — `typescript` and `@typescript/typescript-linux-x64` as optional peers of `inngest` and `@t3-oss/env-core`, `@electric-sql/pglite` and `react` as optional peers of `drizzle-orm` and `inngest`. The lockfile shows the mechanism directly: `drizzle-orm`'s snapshot lists `@electric-sql/pglite` under `optionalDependencies`.

Nothing load-bearing goes with them, because anything the runtime needs is also a direct dependency and survives on that edge — `postgres`, `@opentelemetry/api`, `express` and `hono` all remain. `drizzle-orm` declares `postgres` as an optional peer too, and it stays for exactly this reason. Inngest is served through `inngest/node`, so the optional `express` and `hono` adapters are not a path this app takes.

`@inngest/ai@0.1.7` needed the version bump rather than the flag: it declared `typescript` under plain `dependencies`, which `--no-optional` does not touch. 0.1.8 declares no dependencies at all and satisfies the `^0.1.3` that `inngest` asks for, so the bump also takes `@types/node@22.20.1` and `undici-types` out of the lockfile.

The flag applies at deploy time and leaves resolution alone, so the lockfile, the dev install and every test tier are untouched — PGlite in particular stays available to the unit tier, which runs its store tests against it.

This is the bulk of the runtime image's Trivy findings. `@typescript/typescript-linux-x64` is the Go-built `tsc`, and Go stdlib CVEs compiled into that binary accounted for ten HIGH and one MEDIUM. A scan of the image before and after resolves those eleven and introduces none.
