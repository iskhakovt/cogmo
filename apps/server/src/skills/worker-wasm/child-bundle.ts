import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

/**
 * Bundle the wasm child: `child-entry.ts` as `wasm-child.mjs` and
 * `pyodide-worker.ts` as `wasm-pyodide-worker.mjs`, side by side in
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
export async function buildWasmChild(opts: { sourceDir: string; outDir: string }): Promise<void> {
  await build({
    entryPoints: {
      "wasm-child": join(opts.sourceDir, "child-entry.ts"),
      "wasm-pyodide-worker": join(opts.sourceDir, "pyodide-worker.ts"),
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

/**
 * Throw unless `dir`, a bundle directory another process published under the
 * shared temporary directory, is one this user can trust: a real directory,
 * not a link, owned by this uid and closed to everyone else (`0o700`, as
 * `mkdtemp` creates it). Anything else may hold a planted child. A fatal
 * setup check: it runs only when the server runs from source.
 */
export async function assertOwnPrivateDir(dir: string): Promise<void> {
  const refuse = (reason: string) =>
    new Error(`refusing the wasm child bundle at ${dir}: ${reason}`);
  const stats = await lstat(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw refuse(`${dir} is not a directory of its own`);
  }
  if (stats.uid !== process.getuid?.()) {
    throw refuse(`${dir} is owned by uid ${stats.uid}, not this process's`);
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw refuse(`${dir} has mode ${(stats.mode & 0o777).toString(8)}, not 700`);
  }
}
