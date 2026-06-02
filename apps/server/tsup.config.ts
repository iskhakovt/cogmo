import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/main.ts",
    "src/otel.ts",
    // Tier-1 skills worker — loaded by `new Worker(<this file>)` from
    // `src/skills/worker-wasm/host.ts`. Must be a standalone module so the
    // worker thread can resolve it without the parent's import map.
    "src/skills/worker-wasm/worker-entry.ts",
  ],
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
