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
});
