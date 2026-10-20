import { defineConfig } from "tsup";

export default defineConfig({
  // Each key is a bundle's path under `dist/`, so every bundle sits at the
  // dist root beside the shared chunks. The Dockerfile's ENTRYPOINT runs
  // `dist/main.js` with `dist/otel.js` preloaded.
  entry: {
    index: "src/index.ts",
    main: "src/main.ts",
    otel: "src/otel.ts",
    // Tier-1 skills worker. `host.ts` spawns it from `./worker-entry.js`
    // relative to the bundle the host is bundled into.
    "worker-entry": "src/skills/worker-wasm/worker-entry.ts",
  },
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Bundle the workspace `@cogmo/contracts` (shipped as TS source) into the
  // output — it has no built JS to resolve at runtime. Its own runtime deps
  // (`@orpc/contract`, `zod`) are declared in this package's `dependencies` so
  // tsup externalizes them and the bundled contract code resolves them at
  // runtime — `@orpc/contract` is imported only by that bundled code, not by
  // `src/`, so don't drop it as "unused".
  noExternal: [/^@cogmo\//],
});
