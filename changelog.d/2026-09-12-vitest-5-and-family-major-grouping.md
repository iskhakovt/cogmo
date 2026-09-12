### Vitest 5

Both apps move to Vitest 5 — `vitest`, `@vitest/coverage-v8` in `apps/server`, and `vitest`, `@vitest/browser`, `@vitest/browser-playwright` plus `vitest-browser-react` (2.3, the first release whose peer range admits Vitest 5) in `apps/web`.

The migration takes the new defaults rather than pinning the old behaviour back:

- **`clearMocks` is on.** Vitest calls `.mockClear()` on every spy before each test. Call history resets between tests; implementations and queued `*Once` values installed in `beforeAll` survive, so the factory-based stubs across `src/test/factories.ts` keep working unchanged. Written up in `design/testing.md` and `.claude/rules/testing.md` — the rule test authors need is "assert call counts inside the test that makes the calls."
- **Inline projects inherit the declaring config**, and share one Vite server where they don't modify it. The four server projects and the two web projects both resolve correctly under that; the web browser project keeps its explicit `extends: "./vite.config.ts"` because the React and Tailwind plugins live there.
- **Browser locators are exact and case-sensitive by default**, and `toHaveTextContent` is a strict equality check. Neither changes a web test — the component suite already matched on full strings.

Nothing in the repo tripped the other breaking changes: there are no snapshots to regenerate (no `.snap` file, no inline snapshot, no `toMatchScreenshot`), no `test.sequential` / `describe.sequential`, no `vi.mock` outside module scope, no custom matcher to re-declare against `Matchers<R, T>`, no `VITEST_POOL_ID` / `VITEST_WORKER_ID` reader that the switch to 1-based ids would move, and no import of a removed entry point. JUnit output stays pointed at `test-results/junit.xml`, which is what the three CI report steps read; `.vitest/` — where Vitest 5 puts everything it isn't told to place elsewhere — is now gitignored.

The engine floor is compatible: Vitest 5 wants `^22.12.0 || ^24.0.0 || >=26.0.0` and `engines.node` is `^24.15.0 || >=26.0.0`, a subset, so `engine-ranges.test.ts` stays green without touching the floor.

### Dependabot groups peer-coupled families across majors

The family groups — `vitest`, `opentelemetry`, `drizzle`, `inngest`, `octokit`, `noble` — drop their `minor`/`patch` bound and now cover majors too.

Vitest is the case that forced it. `@vitest/coverage-v8@5.0.0` declares `vitest: 5.0.0` exactly, so the four separate major PRs Dependabot opened for the Vitest 5 release (#476–#479) could not have been merged one at a time — each fails peer resolution on its own, and they only install as a set. The same shape holds for the other five families.

"Majors get individual review" survives: the unit is now one PR per family per major, which is the thing a reviewer can actually reason about. The `*` catch-alls stay minor/patch-only, so a major of anything outside a family still arrives as its own PR, and `@types/*` — grouped for noise, not coupling — keeps its minor/patch bound. The `vitest` group's patterns also cover `vitest-*`, which is where the third-party ecosystem packages live: `vitest-browser-react` had to widen its peer range before the core major could land, so it belongs in the same PR.
