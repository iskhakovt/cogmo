/**
 * `cogmo subagent <command>` — manage `sub_agents` rows post-setup.
 *
 * A sub-agent is a specialist model the orchestrator can delegate a subtask
 * to, surfaced as a `subagent__<name>` tool. Register one here, then enable it
 * per profile by adding `subagent__<name>` (or `subagent__*`) to that
 * profile's tool set.
 */

import { command, extendType, option, positional, subcommands } from "cmd-ts";
import { match } from "ts-pattern";
import type { AgentStore } from "../agent/store/index.js";
import { type CreateSubAgentError, createSubAgent } from "../agent/subagent/create-sub-agent.js";
import { SUB_AGENT_NAME_RE, subAgentToolName } from "../agent/subagent/sub-agent-tool-builder.js";
import type { Transactor } from "../db/index.js";
import { identifier, optionalOption, text } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export interface SubAgentCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

/** A name that makes `subagent__<name>` a legal tool name. */
const subAgentName = extendType(identifier("name"), {
  async from(name) {
    if (!SUB_AGENT_NAME_RE.test(name)) {
      throw new Error(describeAddError({ kind: "invalid_name", name, subject: "sub_agent" }));
    }
    return name;
  },
});

export function subAgentCli(io: CliIo, loadDeps: LoadDeps<SubAgentCliDeps>) {
  return subcommands({
    name: "subagent",
    description: "Manage sub-agents the orchestrator can delegate a subtask to.",
    cmds: {
      add: command({
        name: "add",
        description:
          "Register a sub-agent, callable as a subagent__<name> tool. Takes effect on the next turn.",
        args: {
          name: positional({
            type: subAgentName,
            displayName: "name",
            description: "Lowercase letters, digits, - and _, letter-led, at most 32 chars.",
          }),
          model: option({
            long: "model",
            type: identifier("model-id"),
            description:
              "The model it runs on: routable (see `cogmo model list`), not necessarily user-selectable.",
          }),
          description: option({
            long: "description",
            type: text,
            description: "The routing signal: when the orchestrator should delegate to it.",
          }),
          systemPrompt: optionalOption({
            long: "system-prompt",
            type: text,
            description: "A standing persona. Omitted, it is a pure model-as-tool.",
          }),
        },
        examples: [
          {
            description: "A pure model-as-tool",
            command:
              'cogmo subagent add researcher --model x-ai/grok-4.3 --description "Web research"',
          },
          {
            description: "A sub-agent with a standing persona",
            command:
              'cogmo subagent add writer --model claude-sonnet-5 --description "Long-form prose" --system-prompt "Write in plain British English."',
          },
        ],
        handler: async (args) => addSubAgent(args, await loadDeps(), io),
      }),
      list: command({
        name: "list",
        description: "Show configured sub-agents.",
        args: {},
        handler: async () => listSubAgents(await loadDeps(), io),
      }),
      remove: command({
        name: "remove",
        description: "Delete a sub-agent.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "A sub-agent.",
          }),
        },
        handler: async (args) => removeSubAgent(args, await loadDeps(), io),
      }),
    },
  });
}

interface AddArgs {
  name: string;
  model: string;
  description: string;
  systemPrompt: string | undefined;
}

async function addSubAgent(args: AddArgs, deps: SubAgentCliDeps, io: CliIo): Promise<number> {
  const { name, model, description, systemPrompt } = args;
  const user = await deps.runInTx((tx) => deps.agentStore.getFirstUser(tx));
  if (!user) {
    io.err("No user found. Run `cogmo setup` first.");
    return 1;
  }

  const created = await createSubAgent(deps, {
    userId: user.id,
    name,
    description,
    systemPrompt: systemPrompt ?? null,
    model,
  });
  if (created.isErr()) {
    io.err(describeAddError(created.error));
    return 1;
  }

  io.out(`Added sub-agent "${name}" → model "${model}" (tool: ${subAgentToolName(name)}).`);
  io.out(
    `Enable it for a profile by adding "${subAgentToolName(name)}" (or "subagent__*") to its tool set.`,
  );
  io.out("");
  io.out(
    "Takes effect on the next turn — the agent reloads sub-agents each turn (no restart needed).",
  );
  return 0;
}

function describeAddError(e: CreateSubAgentError): string {
  return match(e)
    .with(
      { kind: "invalid_name" },
      (x) =>
        `Invalid sub-agent name "${x.name}": it must be lowercase ASCII letters/digits/hyphen/underscore, start with a letter, ≤32 chars.`,
    )
    .with(
      { kind: "description_empty" },
      () => "The description must not be empty: it is the routing signal.",
    )
    .with(
      { kind: "unknown_model" },
      (x) =>
        `Unknown model "${x.model}": it has no provider in model_providers. Run \`cogmo model list\` to see routable models, or \`cogmo model add\` to register one.`,
    )
    .with({ kind: "sub_agent_name_taken" }, (x) => `A sub-agent named "${x.name}" already exists.`)
    .exhaustive();
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
  args: { name: string },
  deps: SubAgentCliDeps,
  io: CliIo,
): Promise<number> {
  const { name } = args;
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
