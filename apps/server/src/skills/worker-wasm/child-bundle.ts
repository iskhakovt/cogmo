import { join } from "node:path";
import { build } from "esbuild";

/**
 * Bundle the tier-1 child: `child-entry.ts` as `tier1-child.mjs` and
 * `pyodide-worker.ts` as `tier1-pyodide-worker.mjs`, side by side in
 * `outDir`, every dependency inlined and `py/*.py` embedded as text. The
 * child runs under `--permission` with read access to its own directory, the
 * Pyodide distribution (which it loads by path) and its package
 * directories, so it can resolve nothing from `node_modules`, and it cannot
 * run under tsx, whose esbuild service the permission model forbids. The
 * `.mjs` extension makes them ES modules without a `package.json` lookup,
 * which could fall outside the grants.
 *
 * Two callers: the build writes the bundle into `dist/` beside the bundled
 * host (`tsup.config.ts`), and the host running from source writes it into a
 * temporary directory on its first spawn (`host.ts`).
 */
export async function buildTier1Child(opts: { sourceDir: string; outDir: string }): Promise<void> {
  await build({
    entryPoints: {
      "tier1-child": join(opts.sourceDir, "child-entry.ts"),
      "tier1-pyodide-worker": join(opts.sourceDir, "pyodide-worker.ts"),
    },
    outdir: opts.outDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    loader: { ".py": "text" },
    sourcemap: true,
    logLevel: "warning",
  });
}
