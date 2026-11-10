import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as R from "remeda";

/**
 * What the gates bundle is, and where a coding session on the skills repo
 * reads it (design/skills.md → The gates in verify): what the server needs of
 * it at runtime, apart from `gates-bundle.ts`, whose esbuild a deployed
 * server does not have.
 */

/** The bundle's directory under the server build's output. */
export const GATES_BUNDLE_DIR = "skills-gates";

/** The bundle's files, in the order {@link gatesBundleDigest} reads them. */
export const GATES_BUNDLE_FILES = [
  "gates.mjs",
  "tree-sitter-python.wasm",
  "web-tree-sitter.wasm",
] as const;

/** Where every coding session on the skills repo reads the bundle. */
export const GATES_SESSION_DIR = "/tmp/cogmo-gates";

/** The variable naming {@link GATES_SESSION_DIR} to the skills repo's `.cogmo/verify`. */
export const GATES_DIR_VARIABLE = "COGMO_GATES_DIR";

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
