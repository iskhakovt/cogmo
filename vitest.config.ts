import { defineConfig } from "vitest/config";

/** Files that load Pyodide (3–6s cold-start per WASM init). Routed to
 * the `unit-pyodide` project so their parallelism is capped. */
const PYODIDE_HEAVY_UNIT_GLOBS: readonly string[] = [
  "src/skills/runner.test.ts",
  "src/skills/runner.register.test.ts",
  "src/skills/authoring-bootstrap.test.ts",
  "src/skills/worker-wasm/**/*.test.ts",
  "src/skills/pyodide-version.test.ts",
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
          // Caps parallelism so Vitest's default `maxForks = os.cpus()`
          // doesn't oversubscribe disk/CPU during WASM cold-start. `2`
          // matches CI's effective parallelism (2-core runners).
          name: "unit-pyodide",
          environment: "node",
          include: PYODIDE_HEAVY_UNIT_GLOBS,
          poolOptions: { forks: { maxForks: 2, minForks: 1 } },
          hookTimeout: 30_000,
          testTimeout: 30_000,
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
