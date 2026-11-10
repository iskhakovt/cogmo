import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as R from "remeda";
import { vendoredGrammarPath } from "./vendored-grammar.js";
import { assertOwnPrivateDir } from "./worker-wasm/child-bundle.js";

/**
 * The gates bundle (design/skills.md → The gates in verify): `gates.mjs`, an
 * esbuild bundle of `gates-cli.ts`, and the two files it loads by path beside
 * it, web-tree-sitter's runtime and the vendored grammar. Two builds write it:
 * the server build into `dist/skills-gates/` (`tsup.config.ts`), and
 * {@link buildGatesBundleFromSource} into a temporary directory named by its
 * digest, for a server running from source.
 */

/** The bundle's directory under the server build's output. */
export const GATES_BUNDLE_DIR = "skills-gates";

/** The bundle's files, in the order {@link gatesBundleDigest} reads them. */
export const GATES_BUNDLE_FILES = [
  "gates.mjs",
  "tree-sitter-python.wasm",
  "web-tree-sitter.wasm",
] as const;

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

/**
 * The sha256, in hex, of the bundle in `dir`: each of its files' names and
 * bytes, in {@link GATES_BUNDLE_FILES} order. Throws naming a file that cannot
 * be read.
 */
export async function gatesBundleDigest(dir: string): Promise<string> {
  const contents = await Promise.all(GATES_BUNDLE_FILES.map((f) => readFile(join(dir, f))));
  return R.reduce(
    R.zip(GATES_BUNDLE_FILES, contents),
    (hash, [file, content]) => hash.update(`${file}\0${content.length}\0`).update(content),
    createHash("sha256"),
  ).digest("hex");
}

/**
 * Build the bundle from this source tree into a temporary directory named by
 * its digest, so processes share one copy per version of the sources, and
 * return that directory. The first process to publish a digest wins; a later
 * one drops its own build and uses the winner's only if it is this user's
 * private directory, since anyone can create a name in the shared temporary
 * directory first. Throws when the build or the filesystem fails, or the
 * winner's directory is not one this user can trust.
 *
 * @public The boot's from-source publish of the bundle calls it (design/skills.md → The gates in verify → Delivery).
 */
export async function buildGatesBundleFromSource(): Promise<string> {
  const root = await realpath(tmpdir());
  const buildDir = await mkdtemp(join(root, "cogmo-gates-build-"));
  try {
    await buildGatesBundle({
      serverRoot: fileURLToPath(new URL("../../", import.meta.url)),
      outDir: buildDir,
    });
  } catch (e) {
    await rm(buildDir, { recursive: true, force: true });
    throw e;
  }
  const digest = await gatesBundleDigest(buildDir);
  const outDir = join(root, `cogmo-gates-${digest.slice(0, 16)}`);
  try {
    await rename(buildDir, outDir);
  } catch (e) {
    const code = e instanceof Error && "code" in e ? e.code : undefined;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw e;
    await rm(buildDir, { recursive: true, force: true });
    await assertOwnPrivateDir(outDir, "the gates bundle");
  }
  return outDir;
}
