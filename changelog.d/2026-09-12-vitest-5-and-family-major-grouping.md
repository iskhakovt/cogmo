### Vitest 5

Both apps run Vitest 5 — `vitest` and `@vitest/coverage-v8` in `apps/server`; `vitest`, `@vitest/browser`, `@vitest/browser-playwright` and `vitest-browser-react` 2.3 (the lowest release whose peer range admits Vitest 5) in `apps/web`.

The suites run on Vitest 5's defaults rather than a compatibility shim:

- **`clearMocks` is on.** Vitest calls `.mockClear()` on every spy before each test. Call history resets between tests; implementations and queued `*Once` values installed in `beforeAll` survive, which is what keeps the factory-based stubs in `src/test/factories.ts` working across a whole file. The rule for test authors — assert call counts inside the test that makes the calls — is written up in `design/testing.md` and `.claude/rules/testing.md`.
- **Inline projects inherit the declaring config** and share one Vite server where they don't modify it. The web browser project carries an explicit `extends: "./vite.config.ts"` because the React and Tailwind plugins live there.
- **Browser locators are exact and case-sensitive**, and `toHaveTextContent` is a strict equality check. The component suite matches on full strings, so it needs no opt-out.

Nothing else in the breaking-change list applies here: there are no snapshots (no `.snap` file, no inline snapshot, no `toMatchScreenshot`), no `test.sequential` / `describe.sequential`, no `vi.mock` outside module scope, no custom matcher to declare against `Matchers<R, T>`, no reader of `VITEST_POOL_ID` / `VITEST_WORKER_ID`, and no import of a removed entry point. JUnit output stays at `test-results/junit.xml`, which the three CI report steps read. `.vitest/` — where Vitest 5 puts anything it isn't told to place elsewhere — is gitignored.

`engines.node` is unchanged. Vitest 5 accepts `^22.12.0 || ^24.0.0 || >=26.0.0`; ours is `^24.15.0 || >=26.0.0`, a subset, so `engine-ranges.test.ts` is satisfied.

### Dependabot groups peer-coupled families across majors

The family groups — `vitest`, `opentelemetry`, `drizzle`, `inngest`, `octokit`, `noble` — carry no `update-types`, so they cover majors alongside minors and patches.

A family exists in this config precisely because its members peer-pin each other, and an exact peer pin makes a single-package major unmergeable: `@vitest/coverage-v8@5.0.0` names `vitest: 5.0.0`, so it installs only as a set. Splitting such a family across PRs yields one PR per package and no PR that resolves.

Majors still get reviewed one at a time; the unit is a family rather than a package. The `*` catch-alls keep their minor/patch bound, so a major outside a family arrives as its own PR, and `@types/*` — grouped for noise reduction, not coupling — keeps its bound too. The `vitest` group's patterns extend to `vitest-*`, covering the third-party ecosystem packages (`vitest-browser-react`, `vitest-mock-extended`) that peer-depend on vitest and move with it.
