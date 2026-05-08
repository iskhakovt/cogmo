import type { SkillRunner } from "./runner.js";

const USAGE = `Usage: cogmo skills <command> [args]

Commands:
  list                       List enabled skills (name | tier | risk | git_sha).
  run <name> <jsonInputs>    Invoke a skill with the given JSON input.
  register <branch>          Classify + merge a feature branch in the skills repo.
  approve <pendingId>        Approve a pending-approval deploy by id.
  deny <pendingId> [reason]  Deny a pending-approval deploy by id.
  rollback <name> <toGitSha> Rewind a skill's git_sha to a prior commit.
  deregister <name>          Soft-disable a skill (audit history retained).
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/**
 * `cogmo skills <command>` entrypoint. Raw argv parsing matches the existing
 * `src/main.ts` convention — adding `commander` for a small set of subcommands
 * isn't worth a 380M-dl/wk dep. Returns the desired process exit code.
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

    case "register": {
      const [branch] = rest;
      if (!branch) {
        io.err("Usage: cogmo skills register <branch>");
        return 2;
      }
      const result = await runner.register({ branch });
      io.out(JSON.stringify(result, null, 2));
      return result.status === "rejected" ? 1 : 0;
    }

    case "approve": {
      const [pendingId] = rest;
      if (!pendingId) {
        io.err("Usage: cogmo skills approve <pendingId>");
        return 2;
      }
      const result = await runner.approveDeploy({ pendingId });
      io.out(JSON.stringify(result, null, 2));
      return result.status === "rejected" ? 1 : 0;
    }

    case "deny": {
      const [pendingId, ...reasonParts] = rest;
      if (!pendingId) {
        io.err("Usage: cogmo skills deny <pendingId> [reason]");
        return 2;
      }
      const reason = reasonParts.length > 0 ? reasonParts.join(" ") : undefined;
      await runner.denyDeploy({ pendingId, ...(reason !== undefined && { reason }) });
      io.out(JSON.stringify({ pendingId, status: "denied", reason: reason ?? null }, null, 2));
      return 0;
    }

    case "rollback": {
      const [name, toGitSha] = rest;
      if (!name || !toGitSha) {
        io.err("Usage: cogmo skills rollback <name> <toGitSha>");
        return 2;
      }
      const result = await runner.rollback({ name, toGitSha });
      io.out(JSON.stringify(result, null, 2));
      return result.status === "rejected" ? 1 : 0;
    }

    case "deregister": {
      const [name] = rest;
      if (!name) {
        io.err("Usage: cogmo skills deregister <name>");
        return 2;
      }
      try {
        await runner.deregister({ name });
        io.out(JSON.stringify({ name, status: "disabled" }, null, 2));
        return 0;
      } catch (e) {
        io.err(`deregister failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }

    default:
      io.err(`Unknown skills command: ${command}\n${USAGE}`);
      return 1;
  }
}
