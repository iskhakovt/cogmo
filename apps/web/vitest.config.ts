import { defineConfig } from "vitest/config";

// Node env — Phase 2a only unit-tests the pure chat converters (no DOM). The
// jsdom + @testing-library harness for component/hook tests lands in Phase 5.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
