`vitest.config.ts` migrates the `unit-pyodide` project from the
`poolOptions: { forks: { maxForks: N } }` shape to the unified
top-level `maxWorkers: N`. Vitest 4 [reworked the pool architecture](https://vitest.dev/guide/migration#pool-rework)
— `maxThreads` / `maxForks` / `singleThread` / `singleFork` all collapse
to `maxWorkers` and `isolate`, and the legacy keys now print a
deprecation banner on every run.

The user-facing env override matches: `PYODIDE_MAX_FORKS` →
`PYODIDE_MAX_WORKERS`. The default (2) is unchanged, comments inside
the project pointer adjusted to mirror Vitest's new vocabulary.
