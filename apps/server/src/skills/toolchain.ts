import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "neverthrow";
import { runGitIn } from "./git-ops.js";
import { SKILL_FILES, SKILLS_DIR } from "./skill-files.js";

/**
 * Where every release lists the toolchain's root entries, one name per line
 * (design/skills.md → Verify stage → The skills repo toolchain).
 */
const TOOLCHAIN_PATHS_FILE = ".cogmo/paths";

/** The toolchain directory whose `cogmo_ctx/` joins from `images/skills/src/`. */
const COGMO_DIR = ".cogmo";

type ToolchainFileMode = "100644" | "100755";

/** A file or directory of the toolchain, as the toolchain commit writes it. */
export type ToolchainEntry =
  | { kind: "file"; name: string; mode: ToolchainFileMode; content: Uint8Array }
  | { kind: "tree"; name: string; entries: readonly ToolchainEntry[] };

/** A release's toolchain: the root entries its `.cogmo/paths` lists, and the version its commit names. */
export interface ReleaseToolchain {
  version: string;
  entries: readonly ToolchainEntry[];
}

/** A `.cogmo/paths` line naming an entry the toolchain may not own. */
export interface RefusedToolchainEntry {
  kind: "refused_entry";
  entry: string;
}

/** Names the toolchain may never own, so its commit never removes them. */
const UNOWNABLE: ReadonlySet<string> = new Set([SKILLS_DIR, ...SKILL_FILES, ".", "..", ".git"]);

/**
 * The entries a `.cogmo/paths` lists, blank lines skipped. Errs with the first
 * that is not a single path segment, or that names `skills`, a skill file,
 * `.`, `..` or `.git`: the toolchain commit removes the entries a list names
 * that the release's does not, so such a list would delete skills or reach
 * outside the repo root.
 */
function parseToolchainPaths(text: string): Result<readonly string[], RefusedToolchainEntry> {
  const names = text.split("\n").filter((line) => line.length > 0);
  const refused = names.find(
    (name) => name.includes("/") || name.includes("\0") || UNOWNABLE.has(name),
  );
  return refused === undefined ? ok(names) : err({ kind: "refused_entry", entry: refused });
}

/** The entries `sha`'s `.cogmo/paths` lists: none when it has no such file. */
export async function toolchainPathsAt(
  repoPath: string,
  sha: string,
): Promise<Result<readonly string[], RefusedToolchainEntry>> {
  const listing = await runGitIn(repoPath, [
    "--literal-pathspecs",
    "ls-tree",
    "-z",
    sha,
    "--",
    TOOLCHAIN_PATHS_FILE,
  ]);
  const [, type, objectId] = (listing.split("\t")[0] ?? "").split(" ");
  if (type !== "blob" || objectId === undefined) return ok([]);
  return parseToolchainPaths(await runGitIn(repoPath, ["cat-file", "blob", objectId]));
}

/** What Python writes beside the toolchain's sources, which git ignores there. */
const UNTRACKED = /^__pycache__$|\.py[co]$/;

/**
 * The release's toolchain from `imageDir`, its `images/skills/`
 * ({@link findSkillsImageDir}): the entries `toolchain/.cogmo/paths` lists,
 * read from `toolchain/`, with `src/cogmo_ctx/` joined into `.cogmo/` as
 * `cogmo_ctx/`. The bytes and the executable bit are the files' own, so a boot
 * from the source tree and one from the server image compare the same. Throws
 * when the files are missing, the list is refused or an entry is neither a
 * file nor a directory: the release itself is broken.
 */
export async function loadReleaseToolchain(
  imageDir: string,
  version: string,
): Promise<ReleaseToolchain> {
  const toolchainDir = join(imageDir, "toolchain");
  const listed = parseToolchainPaths(
    await readFile(join(toolchainDir, TOOLCHAIN_PATHS_FILE), "utf8"),
  );
  if (listed.isErr()) {
    throw new Error(`the release's ${TOOLCHAIN_PATHS_FILE} lists '${listed.error.entry}'`);
  }
  const entries = await Promise.all(
    listed.value.map(async (name): Promise<ToolchainEntry> => {
      if (name !== COGMO_DIR) return readEntry(join(toolchainDir, name), name);
      const cogmoCtx: ToolchainEntry = {
        kind: "tree",
        name: "cogmo_ctx",
        entries: await readTree(join(imageDir, "src", "cogmo_ctx")),
      };
      return {
        kind: "tree",
        name,
        entries: [...(await readTree(join(toolchainDir, name))), cogmoCtx],
      };
    }),
  );
  return { version, entries };
}

/**
 * The release's `images/skills/`, found from `moduleUrl`, a composition root's
 * `import.meta.url`: the nearest ancestor of its directory holding a
 * toolchain. In the source tree that is the repo root; in the server image,
 * whose bundle sits in `/app/dist/`, it is `/app`. Throws when there is none.
 */
export function findSkillsImageDir(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, "images", "skills");
    if (existsSync(join(candidate, "toolchain", TOOLCHAIN_PATHS_FILE))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `the release's toolchain is missing: no images/skills/toolchain/ above ${fileURLToPath(moduleUrl)}`,
      );
    }
    dir = parent;
  }
}

async function readEntry(path: string, name: string): Promise<ToolchainEntry> {
  const stats = await lstat(path);
  if (stats.isDirectory()) return { kind: "tree", name, entries: await readTree(path) };
  if (stats.isFile()) {
    return {
      kind: "file",
      name,
      mode: (stats.mode & 0o111) === 0 ? "100644" : "100755",
      content: await readFile(path),
    };
  }
  throw new Error(`the release's toolchain holds ${path}, which is neither a file nor a directory`);
}

async function readTree(dir: string): Promise<ToolchainEntry[]> {
  const names = (await readdir(dir)).filter((name) => !UNTRACKED.test(name)).sort();
  return Promise.all(names.map((name) => readEntry(join(dir, name), name)));
}
