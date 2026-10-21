import { cpSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { defineConfig, type Options } from "tsup";

const OUT_DIR = "dist";

/**
 * The tier-1 worker reads its Python from `py/` beside its own module, so the
 * `.py` files go next to the built `worker-entry.js`, subpackages included.
 * Tool caches (`.ruff_cache/`, `__pycache__/`) and config stay behind.
 */
function copyWorkerPython(outDir: string): void {
  cpSync("src/skills/worker-wasm/py", join(outDir, "py"), {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return statSync(source).isDirectory()
        ? !name.startsWith(".") && name !== "__pycache__"
        : name.endsWith(".py");
    },
  });
}

/**
 * The build for an output directory. The worker's Python is copied into the
 * same directory, so a build elsewhere (`--out-dir`, `tsup-config.test.ts`)
 * gets its own copy and leaves `dist/` alone.
 */
export function tsupOptions(outDir: string): Options {
  return {
    // Each key is a bundle's path under the output directory, so every bundle
    // sits at its root beside the shared chunks. The Dockerfile's ENTRYPOINT
    // runs `dist/main.js` with `dist/otel.js` preloaded.
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
    outDir,
    clean: true,
    sourcemap: true,
    // Bundle the workspace `@cogmo/contracts` (shipped as TS source) into the
    // output — it has no built JS to resolve at runtime. Its own runtime deps
    // (`@orpc/contract`, `zod`) are declared in this package's `dependencies` so
    // tsup externalizes them and the bundled contract code resolves them at
    // runtime — `@orpc/contract` is imported only by that bundled code, not by
    // `src/`, so don't drop it as "unused".
    noExternal: [/^@cogmo\//],
    onSuccess: async () => copyWorkerPython(outDir),
  };
}

// `overrides` carries the CLI's flags; `pnpm build` passes none.
export default defineConfig((overrides) => tsupOptions(overrides.outDir ?? OUT_DIR));
