import { defineConfig } from "vitest/config";

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
          exclude: ["src/**/*.integration.test.ts", "src/**/*.e2e.test.ts"],
          // PGlite `pushSchema` runs in `beforeAll` of every store test file
          // and takes 2–7s each under parallel CPU contention. The default
          // 10s hookTimeout flakes once enough store files exist.
          hookTimeout: 30_000,
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
        },
      },
    ],
  },
});
