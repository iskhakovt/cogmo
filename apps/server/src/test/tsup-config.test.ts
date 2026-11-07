import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tsupOptions } from "../../tsup.config.js";

/**
 * `tsup.config.ts` against the layout the bundled skills host depends on.
 * `host.ts` forks the wasm child from `./wasm-child.mjs` relative to its
 * own module URL, so the build has to emit the child beside whichever bundle
 * the host lands in, with its Pyodide worker beside it. The child runs under
 * `--permission` with read access to its own directory and the Pyodide
 * distribution only, so neither file may import anything but Node's
 * built-ins. Only the label-gated e2e tier runs the image build, so this runs
 * the build itself: in-process, through tsup's API, so no bundled copy of the
 * config lands beside it in the source tree. Entries resolve from the cwd,
 * which Vitest sets to the server package.
 */

/** The specifier `host.ts` resolves against its module URL in the build. */
const CHILD_SPECIFIER = "./wasm-child.mjs";

/** The child's files, which `child-bundle.ts` emits side by side. */
const CHILD_FILES = ["wasm-child.mjs", "wasm-pyodide-worker.mjs"];

/** A full bundle; generous so a loaded runner doesn't fail it on time. */
const BUILD_TIMEOUT_MS = 120_000;

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cogmo-tsup-"));
  await build({ ...tsupOptions(outDir), silent: true });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function emittedBundles(): ReadonlyArray<string> {
  return readdirSync(outDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(outDir, f));
}

/** Every module specifier a bundle imports, static or dynamic. */
function importedSpecifiers(source: string): ReadonlyArray<string> {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].flatMap(
    ([, specifier]) => (specifier === undefined ? [] : [specifier]),
  );
}

/**
 * The start of every dynamic `import(` argument that is not a string literal,
 * which `importedSpecifiers` cannot see. An identifier character or `.` before
 * `import` makes it another call (`py.pyimport(module)`).
 */
function computedImports(source: string): ReadonlyArray<string> {
  return [...source.matchAll(/(?<![\w$.])import\s*\(\s*(?![\s"')])/g)].map(({ index, 0: call }) =>
    source.slice(index + call.length, index + call.length + 80),
  );
}

/** `pyodide-worker.ts` loads Pyodide by path from the granted distribution. */
const PYODIDE_IMPORT = /^pathToFileURL\(join\(\w+\.pyodideDistDir, "pyodide\.mjs"\)\)\.href\)/;

describe("tsup build", () => {
  it("emits the wasm child beside every bundle that forks it", () => {
    const spawners = emittedBundles().filter((f) =>
      readFileSync(f, "utf8").includes(`"${CHILD_SPECIFIER}"`),
    );
    const missing = spawners
      .flatMap((f) =>
        CHILD_FILES.map((child) => fileURLToPath(new URL(`./${child}`, pathToFileURL(f)))),
      )
      .filter((child) => !existsSync(child))
      .map((child) => relative(outDir, child));

    expect(spawners).not.toEqual([]);
    expect(missing).toEqual([]);
  });

  it("bundles the child self-contained, its Python embedded", () => {
    const sources = CHILD_FILES.map((f) => readFileSync(join(outDir, f), "utf8"));
    const external = sources
      .flatMap(importedSpecifiers)
      .filter((specifier) => !specifier.startsWith("node:"));

    expect(external).toEqual([]);
    const computed = sources.flatMap(computedImports);
    expect(computed.filter((arg) => !PYODIDE_IMPORT.test(arg))).toEqual([]);
    expect(computed.filter((arg) => PYODIDE_IMPORT.test(arg))).toHaveLength(1);
    // `cogmo_ctx` from the skills image's source, `py/task.py` and
    // `py/install_deps.py`, inlined by the `.py` text loader.
    expect(sources[1]).toContain("class SkillError(Exception):");
    expect(sources[1]).toContain("async def _cogmo_call_run(run, inputs, ctx):");
    expect(sources[1]).toContain("async def _install_wheels(mount, files):");
  });
});
