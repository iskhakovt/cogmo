/** `design/testing.md` → Mutation Testing. */
export default {
  // pnpm's isolated layout hides plugins from Stryker's default search.
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  // Stryker's default is `threads`; the `unit` project runs on Vitest's `forks`.
  vitest: { configFile: "vitest.stryker.config.ts", pool: "forks" },
  mutate: ["src/sandbox/proxy/policy.ts", "src/secrets/store/index.ts"],
  // Each worker holds its own PGlite instances: about 5 GB of RSS across four
  // on the default modules.
  concurrency: 4,
  // Names no file, to skip the preprocessor that rewrites tsconfig paths leaving
  // the sandbox: it needs TypeScript's JS API (design/testing.md), and
  // `tsconfig.json` has no such paths.
  tsconfigFile: "tsconfig.stryker-preprocessor-disabled.json",
};
