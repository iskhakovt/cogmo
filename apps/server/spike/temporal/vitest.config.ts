import { defineConfig } from "vitest/config";

/** Runs the Temporal spike alone: `pnpm exec vitest run --config spike/temporal/vitest.config.ts`. */
export default defineConfig({
  test: {
    include: ["spike/temporal/**/*.spike.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: "test",
      HINDSIGHT_URL: "http://localhost:8080",
      HINDSIGHT_API_KEY: "unit-test-hindsight-key",
      INNGEST_BASE_URL: "http://localhost:8288",
    },
  },
});
