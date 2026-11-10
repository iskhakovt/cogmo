import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import * as R from "remeda";
import { match } from "ts-pattern";
import { describeError } from "../util/describe-error.js";
import { BUILD_CAPABILITIES } from "./capabilities.js";
import { checkSkillFiles, declaredDependencyNames } from "./deploy/check-skill-files.js";
import { configurePythonParser } from "./python-parser.js";
import { SKILL_BODY_FILE, SKILL_MANIFEST_FILE, type SkillFileTexts } from "./skill-source.js";

/**
 * The gates CLI, bundled as `gates.mjs` (design/skills.md → The gates in
 * verify): register's step 4 after `locateSkill`, run by the skills repo's
 * `.cogmo/verify` on a skill's working tree.
 *
 *     node gates.mjs skills/<name>
 *     node gates.mjs --dependencies skills/<name>
 *
 * Run from the repo root. It reads `skills/<name>/SKILL.md` and
 * `skills/<name>/skill.py` and the two wasm files beside the bundle, and
 * nothing else: no network, environment, clock or git. It writes to stdout
 * once the verdict is complete, one line per string `RegisterResult.errors`
 * would carry for those files, and exits 0 when every check passes, 1 on a
 * refusal, and 2 when the checks cannot run, with `gates: <detail>` on
 * stderr and nothing on stdout. `--dependencies` prints the manifest's
 * declared dependency names instead, one per line, exit 0. Every release
 * keeps these forms, exits and outputs; a release may add a form, a finding
 * id or a cause of exit 2.
 */

const EXIT_PASSED = 0;
const EXIT_REFUSED = 1;
const EXIT_CANNOT_RUN = 2;

const USAGE = "usage: gates.mjs [--dependencies] skills/<name>";

/** `skills/<name>`, with or without a trailing `/`; `<name>` is one path segment. */
const SKILL_DIR_ARGUMENT = /^skills\/([^/]+)\/?$/;

type Command = { kind: "gates"; name: string } | { kind: "dependencies"; name: string };

/** The run's result: lines for stdout and the exit they go with, or why the checks cannot run. */
type Outcome =
  | { kind: "passed"; lines: readonly string[] }
  | { kind: "refused"; lines: readonly string[] }
  | { kind: "cannot_run"; detail: string };

/** A skill file in the working tree, by `lstat`. */
type WorkingFile =
  | { kind: "text"; text: string }
  | { kind: "absent" }
  | { kind: "not_regular_file" };

type SkillFileName = typeof SKILL_MANIFEST_FILE | typeof SKILL_BODY_FILE;

void run(process.argv.slice(2))
  .catch((e: unknown): Outcome => ({ kind: "cannot_run", detail: describeError(e) }))
  .then(report);

async function run(argv: readonly string[]): Promise<Outcome> {
  const command = parseCommand(argv);
  if (command.isErr()) return cannotRun(command.error);
  const { name } = command.value;
  const dir = await skillDirectory(name);
  if (dir.isErr()) return cannotRun(dir.error);
  return match(command.value)
    .with({ kind: "gates" }, () => gates(name))
    .with({ kind: "dependencies" }, () => dependencies(name))
    .exhaustive();
}

function parseCommand(argv: readonly string[]): Result<Command, string> {
  const [first, second, ...rest] = argv;
  if (rest.length > 0) return err(USAGE);
  if (first === "--dependencies") {
    return second === undefined
      ? err(USAGE)
      : skillName(second).map((name) => ({ kind: "dependencies", name }));
  }
  if (first === undefined || second !== undefined) return err(USAGE);
  return skillName(first).map((name) => ({ kind: "gates", name }));
}

function skillName(argument: string): Result<string, string> {
  const name = SKILL_DIR_ARGUMENT.exec(argument)?.[1];
  return name === undefined || name === "." || name === ".."
    ? err(`${argument} names no skill directory; ${USAGE}`)
    : ok(name);
}

/** `skills/<name>` as a directory of its own, by `lstat`, so a link to one does not count. */
async function skillDirectory(name: string): Promise<Result<void, string>> {
  const path = `skills/${name}`;
  const stats = await ResultAsync.fromPromise(lstat(path), describeError);
  return stats.andThen((s) => (s.isDirectory() ? ok() : err(`${path} is not a directory`)));
}

/**
 * The gates run, in register's order: `SKILL.md` present and regular, then
 * `skill.py`, then `checkSkillFiles`. A missing `SKILL.md` refuses before
 * `skill.py` is read, as register refuses it.
 */
async function gates(name: string): Promise<Outcome> {
  configurePythonParser(fileURLToPath(new URL("./tree-sitter-python.wasm", import.meta.url)));
  const manifest = await readWorkingFile(name, SKILL_MANIFEST_FILE);
  if (manifest.isErr()) return cannotRun(manifest.error);
  return match(manifest.value)
    .with({ kind: "not_regular_file" }, async () => notRegular(name, SKILL_MANIFEST_FILE))
    .with({ kind: "absent" }, () => checkedFiles(name, { manifest: null, body: null }))
    .with({ kind: "text" }, async ({ text }) => {
      const body = await readWorkingFile(name, SKILL_BODY_FILE);
      if (body.isErr()) return cannotRun(body.error);
      return match(body.value)
        .with({ kind: "not_regular_file" }, async () => notRegular(name, SKILL_BODY_FILE))
        .with({ kind: "absent" }, () => checkedFiles(name, { manifest: text, body: null }))
        .with({ kind: "text" }, (read) => checkedFiles(name, { manifest: text, body: read.text }))
        .exhaustive();
    })
    .exhaustive();
}

async function checkedFiles(name: string, files: SkillFileTexts): Promise<Outcome> {
  return (await checkSkillFiles(name, files, BUILD_CAPABILITIES)).match(
    (): Outcome => ({ kind: "passed", lines: [] }),
    (rejection) =>
      match(rejection)
        .returnType<Outcome>()
        .with({ kind: "refused" }, ({ errors }) => ({ kind: "refused", lines: errors }))
        .with({ kind: "registrar_unavailable" }, ({ detail }) => cannotRun(detail))
        .exhaustive(),
  );
}

async function dependencies(name: string): Promise<Outcome> {
  const manifest = await readWorkingFile(name, SKILL_MANIFEST_FILE);
  if (manifest.isErr()) return cannotRun(manifest.error);
  return match(manifest.value)
    .with({ kind: "not_regular_file" }, () => notRegular(name, SKILL_MANIFEST_FILE))
    .with({ kind: "absent" }, () => dependenciesOutcome(declaredDependencyNames(name, null)))
    .with({ kind: "text" }, ({ text }) => dependenciesOutcome(declaredDependencyNames(name, text)))
    .exhaustive();
}

function dependenciesOutcome(declared: Result<readonly string[], readonly string[]>): Outcome {
  return declared.match(
    (names): Outcome => ({ kind: "passed", lines: names }),
    (errors): Outcome => ({ kind: "refused", lines: errors }),
  );
}

/**
 * `skills/<name>/<file>`, decoded as UTF-8 as register's `git show` read is.
 * Errs when it cannot be inspected or, a regular file, read.
 */
async function readWorkingFile(
  name: string,
  file: SkillFileName,
): Promise<Result<WorkingFile, string>> {
  const path = `skills/${name}/${file}`;
  const stats = await ResultAsync.fromPromise(lstat(path), (e) => e);
  if (stats.isErr()) {
    return isMissing(stats.error) ? ok({ kind: "absent" }) : err(describeError(stats.error));
  }
  if (!stats.value.isFile()) return ok({ kind: "not_regular_file" });
  return ResultAsync.fromPromise(readFile(path, "utf8"), describeError).map(
    (text): WorkingFile => ({ kind: "text", text }),
  );
}

function isMissing(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ENOENT";
}

/**
 * A link or another non-regular file. Register reads a link's blob, its
 * target path, as the file; here it is refused in its own terms.
 */
function notRegular(name: string, file: SkillFileName): Outcome {
  return {
    kind: "refused",
    lines: [
      `not_regular_file: skills/${name}/${file} is not a regular file; commit the file itself`,
    ],
  };
}

function cannotRun(detail: string): Outcome {
  return { kind: "cannot_run", detail };
}

/** Write the outcome once and set the exit code. */
function report(outcome: Outcome): void {
  match(outcome)
    .with({ kind: "passed" }, ({ lines }) => {
      writeLines(lines);
      process.exitCode = EXIT_PASSED;
    })
    .with({ kind: "refused" }, ({ lines }) => {
      writeLines(lines);
      process.exitCode = EXIT_REFUSED;
    })
    .with({ kind: "cannot_run" }, ({ detail }) => {
      process.stderr.write(`gates: ${oneLine(detail)}\n`);
      process.exitCode = EXIT_CANNOT_RUN;
    })
    .exhaustive();
}

function writeLines(lines: readonly string[]): void {
  if (lines.length > 0) process.stdout.write(`${lines.map(oneLine).join("\n")}\n`);
}

/**
 * The line breaks Python's `str.splitlines` splits on, so a string that spans
 * lines (a YAML error's code frame, a name read from a body's literal) prints
 * as one line.
 */
const LINE_BREAKS: ReadonlySet<string> = new Set([
  "\n",
  "\v",
  "\f",
  "\r",
  "\x1c",
  "\x1d",
  "\x1e",
  "\x85",
  "\u2028",
  "\u2029",
]);

/** `text` with each line break escaped: `\n` and `\r` as themselves, the rest as `\uXXXX`. */
function oneLine(text: string): string {
  return R.pipe(
    [...text],
    R.map((c) => (LINE_BREAKS.has(c) ? escapedBreak(c) : c)),
    R.join(""),
  );
}

function escapedBreak(c: string): string {
  return match(c)
    .with("\n", () => "\\n")
    .with("\r", () => "\\r")
    .otherwise(() => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
