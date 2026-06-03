import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// Two tiers, split by extension. `.test.ts` is pure logic with no DOM (the chat
// stream/history converters) and runs in Node. `.test.tsx` is a component or
// hook test and runs in real Chromium via the Playwright provider — assertions
// see a true layout/event loop, so a11y roles, focus, and keyboard handling are
// exercised the way a browser actually runs them. The browser project extends
// vite.config.ts so JSX and styling transform exactly as the built app does.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: "./vite.config.ts",
        test: {
          name: "browser",
          include: ["src/**/*.test.tsx"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
