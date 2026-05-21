`listExpiredBoundaryPending` now compares `expires_at` to its cutoff via
Drizzle's `lt(col, date)` operator instead of a raw `sql\`${col} <
${cutoff}\`` template. The previous form passed a JS `Date` straight
through to postgres-js's prepared-statement bind phase, which calls
`Buffer.byteLength` on each parameter and rejects anything non-string
with `ERR_INVALID_ARG_TYPE`. The `boundary-janitor` cron — which is the
sole caller and fires every minute — errored on every tick, so expired
`boundary_pending` rows accumulated instead of being cleaned up. Typed
operators apply the column's `mapToDriverValue` before bind (`Date →
toISOString()` for `timestamp` columns), so postgres-js receives a
string and the query runs as intended.

The class is now spelled out in the project's `sql\`\`` rule
(`.claude/rules/code-style.md`): raw `sql\`\`` skips the column mapper,
so any JS value that isn't a string lands in postgres-js's binder
unchanged. PGLite — used by the unit tier — accepts a JS `Date` in that
slot and silently coerces, which is why the existing
`listExpiredBoundaryPending` unit test passed against the in-memory
WASM Postgres while the same query throws against the production
driver. To close that gap, an e2e smoke (`src/test/smoke.e2e.test.ts`)
now inserts an expired `boundary_pending` row and calls the store
method through the real postgres-js driver, pinning the contract that
typed operators preserve the wire-format invariant.
