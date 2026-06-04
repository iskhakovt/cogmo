/**
 * `cogmo subagent <command>` — manage `sub_agents` rows post-setup.
 *
 * A sub-agent is a specialist model the orchestrator can delegate a subtask
 * to, surfaced as a `subagent__<name>` tool. Register one here, then enable it
 * per profile by adding `subagent__<name>` (or `subagent__*`) to that
 * profile's tool set.
 */

import {
  InvalidNameError,
  UniqueViolationError,
  UnknownModelError,
} from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import { createSubAgent } from "../agent/subagent/create-sub-agent.js";
import { subAgentToolName } from "../agent/subagent/sub-agent-tool-builder.js";
import type { Transactor } from "../db/index.js";

const USAGE = `Usage: cogmo subagent <command> [args]

Commands:
  add <name> --model <id> --description <text> [--system-prompt <text>]
                                    Register a sub-agent the orchestrator can
                                    call as a \`subagent__<name>\` tool. <name>
                                    is lowercase letters/digits/-/_, letter-led,
                                    ≤32 chars. --description is the routing
                                    signal (when to delegate). --system-prompt
                                    is an optional standing persona; omit it for
                                    a pure model-as-tool. The model must be
                                    routable (see \`cogmo model list\`); it need
                                    not be user-selectable.
  list                              Show configured sub-agents.
  remove <name>                     Delete a sub-agent.
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface SubAgentCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export async function runSubAgentCli(
  argv: readonly string[],
  deps: SubAgentCliDeps,
  io: CliIo = CONSOLE_IO,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "add":
        return await addSubAgent(rest, deps, io);
      case "list":
        return await listSubAgents(deps, io);
      case "remove":
        return await removeSubAgent(rest, deps, io);
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    // takeValue throws on operator error (missing flag value) — surface as a
    // clean exit-2 rather than unwinding with a stack trace.
    io.err(`Error: ${(err as Error).message}`);
    return 2;
  }
}

async function addSubAgent(
  args: readonly string[],
  deps: SubAgentCliDeps,
  io: CliIo,
): Promise<number> {
  const [name, ...flags] = args;
  if (!name) {
    io.err(
      "Usage: cogmo subagent add <name> --model <id> --description <text> [--system-prompt <text>]",
    );
    return 2;
  }
  const opts = parseFlags(flags);
  if (!opts.model) {
    io.err("--model is required");
    return 2;
  }
  if (!opts.description || opts.description.trim().length === 0) {
    io.err("--description is required (it's the routing signal the orchestrator reads)");
    return 2;
  }

  const user = await deps.runInTx((tx) => deps.agentStore.getFirstUser(tx));
  if (!user) {
    io.err("No user found. Run `cogmo setup` first.");
    return 1;
  }

  try {
    await createSubAgent(deps, {
      userId: user.id,
      name,
      description: opts.description,
      systemPrompt: opts.systemPrompt ?? null,
      model: opts.model,
    });
  } catch (err) {
    if (err instanceof UniqueViolationError) {
      io.err(`A sub-agent named "${name}" already exists.`);
      return 1;
    }
    if (err instanceof InvalidNameError) {
      io.err(err.message);
      return 1;
    }
    if (err instanceof UnknownModelError) {
      io.err(
        `${err.message}. Run \`cogmo model list\` to see routable models, or \`cogmo model add\` to register one.`,
      );
      return 1;
    }
    io.err(`Failed to add sub-agent: ${(err as Error).message}`);
    return 1;
  }

  io.out(`Added sub-agent "${name}" → model "${opts.model}" (tool: ${subAgentToolName(name)}).`);
  io.out(
    `Enable it for a profile by adding "${subAgentToolName(name)}" (or "subagent__*") to its tool set.`,
  );
  io.out("");
  io.out(
    "Takes effect on the next turn — the agent reloads sub-agents each turn (no restart needed).",
  );
  return 0;
}

async function listSubAgents(deps: SubAgentCliDeps, io: CliIo): Promise<number> {
  const user = await deps.runInTx((tx) => deps.agentStore.getFirstUser(tx));
  if (!user) {
    io.err("No user found. Run `cogmo setup` first.");
    return 1;
  }
  const rows = await deps.runInTx((tx) => deps.agentStore.listSubAgents(tx, user.id));
  if (rows.length === 0) {
    io.out("(no sub-agents)");
    return 0;
  }
  io.out("name\ttool\tmodel\tpersona\tdescription");
  for (const row of rows) {
    io.out(
      [
        row.name,
        subAgentToolName(row.name),
        row.model,
        row.systemPrompt ? "yes" : "no",
        row.description,
      ].join("\t"),
    );
  }
  return 0;
}

async function removeSubAgent(
  args: readonly string[],
  deps: SubAgentCliDeps,
  io: CliIo,
): Promise<number> {
  const [name] = args;
  if (!name) {
    io.err("Usage: cogmo subagent remove <name>");
    return 2;
  }
  const user = await deps.runInTx((tx) => deps.agentStore.getFirstUser(tx));
  if (!user) {
    io.err("No user found. Run `cogmo setup` first.");
    return 1;
  }
  const { deleted } = await deps.runInTx((tx) => deps.agentStore.deleteSubAgent(tx, user.id, name));
  if (!deleted) {
    io.err(`No sub-agent named "${name}".`);
    return 1;
  }
  io.out(`Removed sub-agent "${name}".`);
  return 0;
}

interface ParsedFlags {
  model?: string;
  description?: string;
  systemPrompt?: string;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const out: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    switch (flag) {
      case "--model":
        out.model = takeValue(args, i, flag);
        i++;
        break;
      case "--description":
        out.description = takeValue(args, i, flag);
        i++;
        break;
      case "--system-prompt":
        out.systemPrompt = takeValue(args, i, flag);
        i++;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Read the value following a flag, refusing the case where the next token is
 * itself a flag (so `--model --description x` doesn't silently set
 * `model = "--description"`). Free-text values that legitimately start with
 * `--` must be quoted so the shell strips the leading dashes.
 */
function takeValue(args: readonly string[], i: number, flag: string | undefined): string {
  const next = args[i + 1];
  if (next === undefined) {
    throw new Error(`${flag ?? "flag"} requires a value`);
  }
  if (next.startsWith("--")) {
    throw new Error(`${flag ?? "flag"} requires a value (got next flag "${next}" instead)`);
  }
  return next;
}
