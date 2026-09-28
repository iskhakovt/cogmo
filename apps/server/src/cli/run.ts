/**
 * Runs a `cogmo` command tree built with cmd-ts.
 *
 * Every handler resolves to the process exit code. cmd-ts itself answers
 * `--help` (stdout, exit 0) and rejects a malformed command line — unknown
 * command or flag, missing or undecodable value — before any handler runs.
 */

import { command, runSafely, type subcommands } from "cmd-ts";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Exit code for a command line cmd-ts rejects; `1` stays the code for an operation that failed. */
export const EXIT_USAGE = 2;

/**
 * Loads a command's dependencies from inside its handler, so `--help` and a
 * rejected command line never bootstrap the database.
 */
export type LoadDeps<T> = () => Promise<T>;

type Cli = Parameters<typeof runSafely>[0];

/** A command or command group a `subcommands` tree dispatches to. */
export type CommandTree = Parameters<typeof subcommands>[0]["cmds"][string];

export async function runCli(cli: Cli, argv: readonly string[], io: CliIo): Promise<number> {
  const result = await runSafely(cli, [...argv]);
  if (result._tag === "ok") return exitCodeOf(result.value);
  const { message, into, exitCode } = result.error.config;
  if (into === "stdout") {
    io.out(message);
    return exitCode;
  }
  io.err(message);
  return EXIT_USAGE;
}

/**
 * A command resolves to its handler's value; `subcommands` wraps that as
 * `{ command, value }` once per level of nesting.
 */
async function exitCodeOf(outcome: unknown): Promise<number> {
  const settled = await outcome;
  if (typeof settled === "number") return settled;
  if (typeof settled === "object" && settled !== null && "value" in settled) {
    return exitCodeOf(settled.value);
  }
  throw new Error(`CLI handler resolved to ${String(settled)} instead of an exit code`);
}

/**
 * The `cmds` of a top-level `subcommands`: `builtIns` as given, and of
 * `groups` only the one `argv` names. cmd-ts builds the whole tree before it
 * parses, so every other group stands in as a placeholder that is never run.
 * With no known command named — help, a typo — every group loads, so the
 * listing and the "did you mean" suggestion see them all.
 */
export async function loadCommandGroups(
  argv: readonly string[],
  builtIns: Readonly<Record<string, CommandTree>>,
  groups: Readonly<Record<string, () => Promise<CommandTree>>>,
): Promise<Record<string, CommandTree>> {
  const named = argv.find((arg) => !arg.startsWith("-"));
  const known = named !== undefined && (named in builtIns || named in groups);
  const loaded = await Promise.all(
    Object.entries(groups).map(async ([name, load]) => {
      const tree = !known || name === named ? await load() : placeholder(name);
      return [name, tree] as const;
    }),
  );
  return { ...builtIns, ...Object.fromEntries(loaded) };
}

function placeholder(name: string): CommandTree {
  return command({
    name,
    args: {},
    handler: async () => {
      throw new Error(`\`${name}\` ran without its command group loaded`);
    },
  });
}
