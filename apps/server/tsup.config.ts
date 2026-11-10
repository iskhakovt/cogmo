import { join } from "node:path";
import { defineConfig, type Options } from "tsup";
import { buildGatesBundle, GATES_BUNDLE_DIR } from "./src/skills/gates-bundle.js";
import { buildWasmChild } from "./src/skills/worker-wasm/child-bundle.js";

const OUT_DIR = "dist";

/**
 * The build for an output directory. The wasm child and the gates bundle are
 * bundled into the same directory, so a build elsewhere (`--out-dir`,
 * `tsup-config.test.ts`) gets its own copies and leaves `dist/` alone.
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
    },
    format: ["esm"],
    target: "node26",
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
    // The host imports the child bundler only when it runs from source.
    external: ["esbuild"],
    // The wasm child: `host.ts` forks `./wasm-child.mjs` relative to the
    // bundle the host is bundled into, so it goes at the output's root. It is
    // its own self-contained esbuild bundle, since under `--permission` it
    // can read nothing from `node_modules` (`child-bundle.ts`). The gates
    // bundle, which coding sessions on the skills repo run under `node`, goes
    // in its own directory beside it (`gates-bundle.ts`).
    onSuccess: async () => {
      await Promise.all([
        buildWasmChild({ sourceDir: "src/skills/worker-wasm", outDir }),
        buildGatesBundle({ serverRoot: ".", outDir: join(outDir, GATES_BUNDLE_DIR) }),
      ]);
    },
  };
}

// `overrides` carries the CLI's flags; `pnpm build` passes none.
export default defineConfig((overrides) => tsupOptions(overrides.outDir ?? OUT_DIR));
