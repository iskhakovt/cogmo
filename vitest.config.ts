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
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.integration.test.ts"],
          globalSetup: "./test/integration-setup.ts",
          testTimeout: 60_000,
          hookTimeout: 600_000,
          env: {
            NODE_ENV: "test",
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
