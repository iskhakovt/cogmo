import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../tsup.config.js";

/**
 * `tsup.config.ts` against the layout the bundled skills host depends on.
 * `host.ts` spawns the tier-1 worker from `./worker-entry.js` relative to its
 * own module URL, so the build has to emit the worker entry beside whichever
 * bundle the host lands in. Only the label-gated e2e tier runs the image
 * build, so this runs the build itself: in-process, through tsup's API, so
 * no bundled copy of the config lands beside it in the source tree. Entries
 * resolve from the cwd, which Vitest sets to the server package.
 */

/** The specifier `host.ts` resolves against its module URL in the build. */
const WORKER_SPECIFIER = "./worker-entry.js";

/** A full bundle; generous so a loaded runner doesn't fail it on time. */
const BUILD_TIMEOUT_MS = 120_000;

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cogmo-tsup-"));
  await build({ ...config, outDir, silent: true });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

function emittedBundles(): ReadonlyArray<string> {
  return readdirSync(outDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".js"))
    .map((f) => join(outDir, f));
}

describe("tsup build", () => {
  it("emits the tier-1 worker entry beside every bundle that spawns it", () => {
    const bundles = emittedBundles();
    const spawners = bundles.filter((f) =>
      readFileSync(f, "utf8").includes(`"${WORKER_SPECIFIER}"`),
    );
    const missing = spawners
      .map((f) => fileURLToPath(new URL(WORKER_SPECIFIER, pathToFileURL(f))))
      .filter((worker) => !existsSync(worker))
      .map((worker) => relative(outDir, worker));
    const workers = bundles
      .filter((f) => f.endsWith("/worker-entry.js"))
      .map((f) => relative(outDir, f));

    expect(spawners).not.toEqual([]);
    expect(missing, `worker-entry.js emitted at: ${workers.join(", ") || "nowhere"}`).toEqual([]);
  });
});
