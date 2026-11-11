import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { vendoredGrammarPath } from "./vendored-grammar.js";

/**
 * The gates bundle (design/skills.md → The gates in verify): `gates.mjs`, an
 * esbuild bundle of `gates-cli.ts`, and the two files it loads by path beside
 * it, web-tree-sitter's runtime and the vendored grammar. Two builds write it:
 * the server build into `dist/skills-gates/` (`tsup.config.ts`), and
 * `gates-bundle-source.ts` into a temporary directory named by its digest,
 * for a server running from source. The server imports these only then, and
 * dynamically: a deployed server has no esbuild. What it needs of the bundle
 * at runtime is `gates-files.ts`.
 */

/**
 * `yaml`'s CommonJS build requires `process`, which an ESM bundle cannot
 * resolve without a `require`; esbuild's `__require` shim uses this one.
 */
const REQUIRE_BANNER =
  'import { createRequire as __gatesCreateRequire } from "node:module";\nconst require = __gatesCreateRequire(import.meta.url);';

/**
 * Write the bundle's three files into `outDir`, creating it: `gates.mjs`
 * from `src/skills/gates-cli.ts` under `serverRoot`, the server package's
 * directory, with every dependency inlined, minified and with no source map;
 * then `web-tree-sitter.wasm` from its package and the vendored grammar
 * beside it.
 */
export async function buildGatesBundle(opts: {
  serverRoot: string;
  outDir: string;
}): Promise<void> {
  await mkdir(opts.outDir, { recursive: true });
  await build({
    entryPoints: { gates: join(opts.serverRoot, "src", "skills", "gates-cli.ts") },
    outdir: opts.outDir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node26",
    minify: true,
    sourcemap: false,
    banner: { js: REQUIRE_BANNER },
    logLevel: "warning",
  });
  const fromServer = createRequire(resolve(opts.serverRoot, "package.json"));
  await Promise.all([
    copyFile(
      fromServer.resolve("web-tree-sitter/web-tree-sitter.wasm"),
      join(opts.outDir, "web-tree-sitter.wasm"),
    ),
    copyFile(vendoredGrammarPath(opts.serverRoot), join(opts.outDir, "tree-sitter-python.wasm")),
  ]);
}
