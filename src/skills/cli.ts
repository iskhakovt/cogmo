import type { SkillRunner } from "./runner.js";

const USAGE = `Usage: cogmo skills <command> [args]

Commands:
  list                       List enabled skills (name | tier | risk | git_sha).
  run <name> <jsonInputs>    Invoke a skill with the given JSON input.

(Future, P3.3: register / rollback / deregister.)
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  // biome-ignore lint/suspicious/noConsole: CLI output stream is the legitimate use of console.
  out: (line) => console.log(line),
  // biome-ignore lint/suspicious/noConsole: CLI error stream.
  err: (line) => console.error(line),
};

/**
 * `cogmo skills <command>` entrypoint. Raw argv parsing matches the existing
 * `src/main.ts` convention — adding `commander` for two subcommands isn't
 * worth a 380M-dl/wk dep. Returns the desired process exit code.
 */
export async function runSkillsCli(
  argv: readonly string[],
  runner: SkillRunner,
  io: CliIo = CONSOLE_IO,
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;

    case "list": {
      const skills = await runner.list();
      if (skills.length === 0) {
        io.out("(no enabled skills)");
        return 0;
      }
      io.out("name\ttier\trisk\tdisabled\tgit_sha");
      for (const s of skills) {
        io.out([s.name, s.tier, s.riskTier, s.disabled ? "yes" : "no", s.gitSha].join("\t"));
      }
      return 0;
    }

    case "run": {
      const [name, inputsRaw] = rest;
      if (!name || inputsRaw === undefined) {
        io.err("Usage: cogmo skills run <name> <jsonInputs>");
        return 2;
      }
      let inputs: unknown;
      try {
        inputs = JSON.parse(inputsRaw);
      } catch (e) {
        io.err(`invalid JSON inputs: ${e instanceof Error ? e.message : String(e)}`);
        return 2;
      }
      try {
        const result = await runner.invoke({ name, inputs, trigger: "manual" });
        io.out(JSON.stringify(result, null, 2));
        return result.status === "success" ? 0 : 1;
      } catch (e) {
        io.err(`invoke failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }

    default:
      io.err(`Unknown skills command: ${command}\n${USAGE}`);
      return 1;
  }
}
