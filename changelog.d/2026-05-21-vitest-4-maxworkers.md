`vitest.config.ts` swaps the `unit-pyodide` project's
`poolOptions: { forks: { maxForks } }` for Vitest 4's top-level
`maxWorkers`. Env override renamed `PYODIDE_MAX_FORKS` →
`PYODIDE_MAX_WORKERS`; default of 2 unchanged. Pyodide moves to
`sequence.groupOrder: 1` so it keeps its per-project worker cap
without forcing `unit` to inherit it.
