/**
 * Runs a `cogmo` command tree built with cmd-ts.
 *
 * Every handler resolves to the process exit code. cmd-ts itself answers
 * `--help` (stdout, exit 0) and rejects a malformed command line — unknown
 * command or flag, missing or undecodable value — before any handler runs.
 */

import { runSafely } from "cmd-ts";

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
