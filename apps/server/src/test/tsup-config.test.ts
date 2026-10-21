import { execFile as execFileCb } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCb);

/**
 * `tsup.config.ts` against the layout the bundled skills host depends on.
 * `host.ts` spawns the tier-1 worker from `./worker-entry.js` relative to its
 * own module URL, so the build has to emit the worker entry beside whichever
 * bundle the host lands in. Only the label-gated e2e tier runs the image
 * build, so this runs the build itself.
 */

/** The server package: tsup resolves its config, entries and externals from the cwd. */
const SERVER = resolve(import.meta.dirname, "../..");

/** The specifier `host.ts` resolves against its module URL in the build. */
const WORKER_SPECIFIER = "./worker-entry.js";

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cogmo-tsup-"));
  await execFile(join(SERVER, "node_modules/.bin/tsup"), ["--out-dir", outDir, "--silent"], {
    cwd: SERVER,
  });
});

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
