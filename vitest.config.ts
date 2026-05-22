import { defineConfig } from "vitest/config";

/** Defaults to 2 — matches the parallelism of CI's 2-core runners.
 * Override with `PYODIDE_MAX_WORKERS=N` on bigger dev boxes if 2 leaves
 * perf on the table. */
const PYODIDE_MAX_WORKERS = (() => {
  const v = Number(process.env.PYODIDE_MAX_WORKERS);
  return Number.isFinite(v) && v >= 1 ? v : 2;
})();

/** Files that actually load Pyodide (3–6s cold-start per WASM init).
 * Routed to the `unit-pyodide` project so their parallelism is capped.
 * Membership rule: file must directly load Pyodide (`loadPyodide`,
 * `runOnWorker`) or transitively via `SkillRunner.invoke()` calls. Files
 * that only call `register()` (no Pyodide; tree-sitter classifier
 * instead) or assert on a pinned version (no WASM load) stay in `unit`. */
const PYODIDE_HEAVY_UNIT_GLOBS: readonly string[] = [
  "src/skills/runner.test.ts",
  "src/skills/runner.register.test.ts",
  "src/skills/worker-wasm/**/*.test.ts",
];

/** Shared by both unit projects. `HINDSIGHT_URL` + `INNGEST_BASE_URL` are
 * required by the runtime schema in `src/env.ts` — any test that touches
 * code importing the full `env` (e.g. `db/index.ts`, `health.ts`) needs
 * them populated. Unit tests mock the actual stores so the URLs are never
 * hit. */
const UNIT_ENV = {
  NODE_ENV: "test",
  HINDSIGHT_URL: "http://localhost:8080",
  INNGEST_BASE_URL: "http://localhost:8288",
  // Required, no default in production. Unit tests don't actually mount
  // anything; the value just satisfies the env schema.
  COGMO_SKILLS_DEPS_VOLUME: "cogmo-skills-deps-test",
} as const;

export default defineConfig({
  test: {
    reporters: ["default", "junit"],
    outputFile: { junit: "test-results/junit.xml" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          // Pyodide-heavy files routed to `unit-pyodide` (capped parallelism).
          exclude: [
            "src/**/*.integration.test.ts",
            "src/**/*.e2e.test.ts",
            ...PYODIDE_HEAVY_UNIT_GLOBS,
          ],
          // PGlite `pushSchema` runs in `beforeAll` of every store test file
          // and takes 2–7s each under parallel CPU contention. The default
          // 10s hookTimeout flakes once enough store files exist.
          hookTimeout: 30_000,
          env: UNIT_ENV,
        },
      },
      {
        test: {
          // Caps parallelism so Vitest's default `maxWorkers`
          // (`os.availableParallelism()`) doesn't oversubscribe disk/CPU
          // during WASM cold-start. `2` matches CI's effective parallelism;
          // bigger dev boxes can override via `PYODIDE_MAX_WORKERS`.
          //
          // `sequence.groupOrder` is what makes the per-project cap
          // possible: projects sharing a `groupOrder` share one worker
          // pool, so putting pyodide and unit in the same group would
          // force a single `maxWorkers` value across both tiers (either
          // pessimising `unit` by capping it at 2, or removing the
          // pyodide cap by inheriting unit's default — both bad).
          // Running pyodide in groupOrder 1 lets each tier keep its own
          // worker config. Sequential isn't a regression: empirically
          // CI's Unit Tests check is marginally faster than the
          // previous interleaved layout (no cross-tier disk/CPU
          // contention).
          name: "unit-pyodide",
          environment: "node",
          include: PYODIDE_HEAVY_UNIT_GLOBS,
          maxWorkers: PYODIDE_MAX_WORKERS,
          sequence: { groupOrder: 1 },
          hookTimeout: 30_000,
          // 60s covers full Pyodide cold-start + a non-trivial WASM run.
          // Tighter per-test budgets (e.g. host.test.ts's 15s wall-clock
          // cap test) still apply via inline `{ timeout }` overrides.
          testTimeout: 60_000,
          env: UNIT_ENV,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          globalSetup: "./test/integration-setup.ts",
          // 90s for the image-gen test in record mode (fal call + 2x LLM round trips).
          // Replay is much faster but one bound covers both modes.
          testTimeout: 90_000,
          hookTimeout: 600_000,
          env: {
            NODE_ENV: "test",
            // Surface transient container/network blips as hard failures
            // instead of letting withRetry mask them. See src/util/with-retry.ts.
            RETRY_DISABLED: "true",
          },
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["src/**/*.e2e.test.ts"],
          globalSetup: "./test/e2e-setup.ts",
          testTimeout: 120_000,
          hookTimeout: 600_000,
          env: {
            NODE_ENV: "test",
          },
        },
      },
    ],
  },
});
