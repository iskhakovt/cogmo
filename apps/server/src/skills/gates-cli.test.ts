import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { match } from "ts-pattern";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectDefined } from "../test/assertions.js";
import { DEPENDENCIES_CASES, GATES_CASES, PATHS_CASES } from "../test/gates-cases.js";
import { buildGatesBundle } from "./gates-bundle.js";
import { GATES_BUNDLE_FILES } from "./gates-files.js";

/**
 * The gates CLI as `.cogmo/verify` runs it (design/skills.md → The gates in
 * verify): the bundle the release's build function writes, under `node` from
 * the repo root, with Node's permission model granting reads of the bundle's
 * directory and the skill's alone (`--allow-fs-read=<repo>/skills/<name>`),
 * and with no environment, so no `NODE_OPTIONS`; `--paths` has the bundle's
 * grant alone. It shares its case tables with `check-skill-files.test.ts` and
 * `locate-skill.test.ts`.
 */

/** Building the bundle; generous so a loaded runner doesn't fail it on time. */
const BUILD_TIMEOUT_MS = 120_000;

let root: string;
let gatesDir: string;
let repo: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cogmo-gates-cli-"));
  gatesDir = join(root, "gates");
  await buildGatesBundle({ serverRoot: process.cwd(), outDir: gatesDir });
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  repo = await mkdtemp(join(root, "repo-"));
});

interface Run {
  exit: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  bundle?: string;
  /** The skill's grant; null for none, as verify runs `--paths`. */
  grant?: string | null;
  /** Written to stdin, which closes after it. */
  input?: string;
}

/** `node <bundle>/gates.mjs ...args` from the repo root, under verify's grants. */
function runGates(args: readonly string[], opts: RunOptions = {}) {
  const bundle = opts.bundle ?? gatesDir;
  const grant = opts.grant === undefined ? grantFor(args) : opts.grant;
  return new Promise<Run>((resolve) => {
    const child = execFile(
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${bundle}`,
        ...(grant === null ? [] : [`--allow-fs-read=${grant}`]),
        join(bundle, "gates.mjs"),
        ...args,
      ],
      { cwd: repo, env: {} },
      (error, stdout, stderr) => {
        const exit = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ exit, stdout, stderr });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** verify's grant: the skill's own directory, `<repo>/skills/<name>`, for the path argument. */
function grantFor(args: readonly string[]): string {
  return join(repo, (args.at(-1) ?? "skills/echo").replace(/\/$/, ""));
}

/** Write `skills/<name>/` with each file given; null leaves it out. */
async function writeSkill(
  name: string,
  files: { manifest: string | null; body: string | null },
): Promise<void> {
  const dir = join(repo, "skills", name);
  await mkdir(dir, { recursive: true });
  if (files.manifest !== null) await writeFile(join(dir, "SKILL.md"), files.manifest);
  if (files.body !== null) await writeFile(join(dir, "skill.py"), files.body);
}

/**
 * A string as the CLI prints it: one line, every break a reader may split on
 * escaped. `\n` and `\r` read as themselves, the rest as `\uXXXX`.
 */
function printed(line: string): string {
  return line.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\u2028", "\\u2028");
}

/** stdout as the lines it holds; none for empty output. */
function linesOf(stdout: string): string[] {
  return stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n");
}

const USAGE = "usage: gates.mjs [--dependencies] skills/<name> | gates.mjs --paths < paths";

const PASSING = expectDefined(
  GATES_CASES.find((c) => c.exit === 0),
  "a passing case",
);

describe("gates.mjs: the parity table, as verify runs it", () => {
  it.each(GATES_CASES)("$label", async ({ name, directory, manifest, body, lines, exit }) => {
    await match(directory)
      .with("present", () => writeSkill(name, { manifest, body }))
      .with("deleted", async () => {})
      .exhaustive();

    const run = await runGates([`skills/${name}`]);

    expect({ exit: run.exit, lines: linesOf(run.stdout), stderr: run.stderr }).toEqual({
      exit,
      lines: lines.map(printed),
      stderr: "",
    });
  });
});

describe("gates.mjs --dependencies: the parity table", () => {
  it.each(DEPENDENCIES_CASES)("$label", async ({ manifest, lines, exit }) => {
    await writeSkill("echo", { manifest, body: null });

    const run = await runGates(["--dependencies", "skills/echo"]);

    expect({ exit: run.exit, lines: linesOf(run.stdout), stderr: run.stderr }).toEqual({
      exit,
      lines,
      stderr: "",
    });
  });
});

describe("gates.mjs --paths: the parity table", () => {
  it.each(PATHS_CASES)("$label", async ({ paths, lines, exit }) => {
    const run = await runGates(["--paths"], {
      grant: null,
      input: paths.map((path) => `${path}\0`).join(""),
    });

    expect({ exit: run.exit, lines: linesOf(run.stdout), stderr: run.stderr }).toEqual({
      exit,
      lines: lines.map(printed),
      stderr: "",
    });
  });
});

describe("gates.mjs --paths", () => {
  it("reads paths with no trailing NUL", async () => {
    const run = await runGates(["--paths"], {
      grant: null,
      input: "skills/echo/skill.py\0skills/other/skill.py",
    });

    expect(run).toEqual({
      exit: 1,
      stdout: "owned_paths: the branch changes more than one skill: echo, other\n",
      stderr: "",
    });
  });

  it("reads an empty stdin as no paths", async () => {
    expect(await runGates(["--paths"], { grant: null, input: "" })).toEqual({
      exit: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 2 for a stdin it cannot read", async () => {
    // A file opened write-only as stdin: its reads fail with EBADF.
    const stdin = await open(join(repo, "write-only"), "w");
    try {
      const child = spawn(
        process.execPath,
        ["--permission", `--allow-fs-read=${gatesDir}`, join(gatesDir, "gates.mjs"), "--paths"],
        { cwd: repo, env: {}, stdio: [stdin.fd, "pipe", "pipe"] },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      expectDefined(child.stdout, "stdout").on("data", (chunk: Buffer) => stdout.push(chunk));
      expectDefined(child.stderr, "stderr").on("data", (chunk: Buffer) => stderr.push(chunk));
      const [exit] = await once(child, "close");

      expect(exit).toBe(2);
      expect(Buffer.concat(stdout).toString()).toBe("");
      expect(Buffer.concat(stderr).toString()).toMatch(
        /^gates: cannot read the paths on stdin: EBADF: .+\n$/,
      );
    } finally {
      await stdin.close();
    }
  });

  it.each([
    ["an argument after it", ["--paths", "skills/echo"]],
    ["it after a path", ["skills/echo", "--paths"]],
  ])("exits 2 for %s", async (_label, args) => {
    const run = await runGates(args, { grant: null, input: "" });

    expect(run).toEqual({ exit: 2, stdout: "", stderr: `gates: ${USAGE}\n` });
  });
});

describe("gates.mjs", () => {
  it("prints a string holding line breaks as one line", async () => {
    await writeSkill("echo", {
      manifest: PASSING.manifest,
      body: 'async def run(inputs, ctx):\n    return await ctx.secrets.get("a\u2028b")\n',
    });

    const run = await runGates(["skills/echo"]);

    expect(run.exit).toBe(1);
    expect(linesOf(run.stdout)).toEqual([
      "effects: skills/echo/skill.py:2:34: secret 'a\\u2028b' is not declared in SKILL.md frontmatter",
    ]);
  });

  it.each([
    ["SKILL.md", "skills/echo/SKILL.md"],
    ["skill.py", "skills/echo/skill.py"],
  ])("refuses a %s that is a symlink as not_regular_file", async (file, path) => {
    await writeSkill("echo", { manifest: PASSING.manifest, body: PASSING.body });
    const target = join(repo, "skills", "echo", `real-${file}`);
    await cp(join(repo, path), target);
    await rm(join(repo, path));
    await symlink(target, join(repo, path));

    const run = await runGates(["skills/echo"]);

    expect(run).toEqual({
      exit: 1,
      stdout: `not_regular_file: ${path} is not a regular file; commit the file itself\n`,
      stderr: "",
    });
  });

  it("refuses a directory where skill.py should be as not_regular_file", async () => {
    await writeSkill("echo", { manifest: PASSING.manifest, body: null });
    await mkdir(join(repo, "skills", "echo", "skill.py"));

    const run = await runGates(["skills/echo"]);

    expect(run.stdout).toBe(
      "not_regular_file: skills/echo/skill.py is not a regular file; commit the file itself\n",
    );
    expect(run.exit).toBe(1);
  });

  it("reports a missing SKILL.md before a skill.py that is a symlink, as register does", async () => {
    await writeSkill("echo", { manifest: null, body: null });
    await symlink("/etc/hostname", join(repo, "skills", "echo", "skill.py"));

    const run = await runGates(["skills/echo"]);

    expect(run.stdout).toBe("missing_skill_md: skills/echo/SKILL.md not found\n");
    expect(run.exit).toBe(1);
  });

  it("refuses a SKILL.md that is a symlink under --dependencies", async () => {
    await writeSkill("echo", { manifest: null, body: null });
    await symlink("/etc/hostname", join(repo, "skills", "echo", "SKILL.md"));

    const run = await runGates(["--dependencies", "skills/echo"]);

    expect(run).toEqual({
      exit: 1,
      stdout:
        "not_regular_file: skills/echo/SKILL.md is not a regular file; commit the file itself\n",
      stderr: "",
    });
  });

  it("refuses a deleted skill's SKILL.md as missing under --dependencies, as the gates run does", async () => {
    // verify's grant names the directory that no longer exists.
    const run = await runGates(["--dependencies", "skills/echo"]);

    expect(run).toEqual({
      exit: 1,
      stdout: "missing_skill_md: skills/echo/SKILL.md not found\n",
      stderr: "",
    });
  });

  it("accepts the path with a trailing slash", async () => {
    await writeSkill("echo", { manifest: PASSING.manifest, body: PASSING.body });

    expect(await runGates(["skills/echo/"])).toEqual({ exit: 0, stdout: "", stderr: "" });
  });
});

describe("gates.mjs exits 2, with nothing on stdout, when the checks cannot run", () => {
  beforeEach(async () => {
    await writeSkill("echo", { manifest: PASSING.manifest, body: PASSING.body });
  });

  it.each([
    ["no argument", []],
    ["--dependencies alone", ["--dependencies"]],
    ["two paths", ["skills/echo", "skills/echo"]],
    ["a flag it does not know", ["--strict", "skills/echo"]],
    ["the flag after the path", ["skills/echo", "--dependencies"]],
  ])("for %s", async (_label, args) => {
    const run = await runGates(args, { grant: join(repo, "skills", "echo") });

    expect(run).toEqual({ exit: 2, stdout: "", stderr: `gates: ${USAGE}\n` });
  });

  it.each([
    ["a file under the skill", "skills/echo/skill.py"],
    ["a path outside skills/", "echo"],
    ["a nested path", "skills/echo/sub"],
    ["the parent directory", "skills/.."],
  ])("for an argument naming no skill directory: %s", async (_label, path) => {
    const run = await runGates([path], { grant: join(repo, "skills", "echo") });

    expect(run).toEqual({
      exit: 2,
      stdout: "",
      stderr: `gates: ${path} names no skill directory; ${USAGE}\n`,
    });
  });

  it("for a skills/ that is a file, which no skill directory can sit under", async () => {
    await rm(join(repo, "skills"), { recursive: true });
    await writeFile(join(repo, "skills"), "");

    const run = await runGates(["skills/echo"], { grant: repo });

    expect(run.exit).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^gates: ENOTDIR: not a directory, lstat 'skills\/echo'\n$/);
  });

  it("for a skill directory that is a symlink", async () => {
    await symlink(join(repo, "skills", "echo"), join(repo, "skills", "link"));

    const run = await runGates(["skills/link"], { grant: repo });

    expect(run).toEqual({ exit: 2, stdout: "", stderr: "gates: skills/link is not a directory\n" });
  });

  it.skipIf(process.getuid?.() === 0)("for a skill.py it cannot read", async () => {
    await chmod(join(repo, "skills", "echo", "skill.py"), 0o000);

    const run = await runGates(["skills/echo"]);

    expect(run.exit).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(
      /^gates: EACCES: permission denied, open 'skills\/echo\/skill\.py'\n$/,
    );
  });

  it("for a file outside its grants", async () => {
    const run = await runGates(["skills/echo"], { grant: join(repo, "skills", "other") });

    expect(run.exit).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^gates: /);
  });

  describe("for a wasm file that does not load", () => {
    let broken: string;

    beforeEach(async () => {
      broken = await mkdtemp(join(root, "broken-"));
      await cp(gatesDir, broken, { recursive: true });
    });

    it("a grammar that is missing, once the earlier stages have passed", async () => {
      await rm(join(broken, "tree-sitter-python.wasm"));

      const run = await runGates(["skills/echo"], { bundle: broken });

      expect(run.exit).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(
        `gates: the Python grammar at ${join(broken, "tree-sitter-python.wasm")} did not load: ENOENT: no such file or directory, open '${join(broken, "tree-sitter-python.wasm")}'\n`,
      );
    });

    it("a grammar that is truncated", async () => {
      const grammar = join(broken, "tree-sitter-python.wasm");
      await writeFile(grammar, (await readFile(grammar)).subarray(0, 1000));

      const run = await runGates(["skills/echo"], { bundle: broken });

      expect(run.exit).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(
        new RegExp(`^gates: the Python grammar at ${grammar} did not load: .+\\n$`),
      );
    });

    it("web-tree-sitter's runtime that is truncated", async () => {
      const runtime = join(broken, "web-tree-sitter.wasm");
      await writeFile(runtime, (await readFile(runtime)).subarray(0, 1000));

      const run = await runGates(["skills/echo"], { bundle: broken });

      expect(run.exit).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(
        /(^|\n)gates: web-tree-sitter's runtime \(web-tree-sitter\.wasm\) did not load: .+\n$/,
      );
    });

    it("but not a refusal reached before the parse, which needs no grammar", async () => {
      await rm(join(broken, "tree-sitter-python.wasm"));
      await rm(join(repo, "skills", "echo", "skill.py"));

      const run = await runGates(["skills/echo"], { bundle: broken });

      expect(run).toEqual({
        exit: 1,
        stdout: "missing_skill_py: skills/echo/skill.py not found\n",
        stderr: "",
      });
    });
  });
});

describe("the bundle", () => {
  it("holds its three files", async () => {
    const sizes = await Promise.all(
      GATES_BUNDLE_FILES.map(async (f) => (await readFile(join(gatesDir, f))).length),
    );
    expect(sizes.every((size) => size > 0)).toBe(true);
  });

  it("names no Node module that spawns or reaches the network, and reads no environment", async () => {
    const source = await readFile(join(gatesDir, "gates.mjs"), "utf8");

    expect(source).not.toMatch(
      /(\bfrom\s*|\bimport\(\s*|\brequire\(\s*)["'](node:)?(child_process|cluster|dgram|dns|http|http2|https|inspector|net|tls|worker_threads)["']/,
    );
    expect(source).not.toContain("process.env");
  });
});
