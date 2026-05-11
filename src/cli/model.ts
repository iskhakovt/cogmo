/**
 * `cogmo model <command>` — manage `model_providers` routing rows post-setup.
 *
 * Mirrors the wizard's model picker step at the CLI: register a model
 * against an existing provider (with optional explicit limits), list
 * routing rows with their effective limits and source, or remove a row
 * (or all rows for a model).
 */

import { addModelRouting } from "../agent/provider/add-model-routing.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { resolveLimits } from "../llm/models.js";

const USAGE = `Usage: cogmo model <command> [args]

Commands:
  add <id> --provider <name> [--context N] [--max-output N] [--position N]
                                    Register a model on an existing provider.
                                    --context / --max-output override the
                                    bundled LiteLLM defaults; omit to let
                                    the resolver pick. --position defaults
                                    to the next free slot for that model.
  list [--model <id>] [--provider <name>]
                                    Show routing rows. Each row's effective
                                    limits + source (db/litellm/default)
                                    surface so you can see why compaction
                                    behaves the way it does.
  remove <id> [--provider <name>]   Delete one row (when --provider given)
                                    or every row for the model.
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface ModelCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

export async function runModelCli(
  argv: readonly string[],
  deps: ModelCliDeps,
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
    case "add":
      return addModelCmd(rest, deps, io);
    case "list":
      return listModels(rest, deps, io);
    case "remove":
      return removeModel(rest, deps, io);
    default:
      io.err(`Unknown command: ${command}\n`);
      io.err(USAGE);
      return 1;
  }
}

async function addModelCmd(
  args: readonly string[],
  deps: ModelCliDeps,
  io: CliIo,
): Promise<number> {
  const [model, ...flags] = args;
  if (!model) {
    io.err(
      "Usage: cogmo model add <id> --provider <name> [--context N] [--max-output N] [--position N]",
    );
    return 2;
  }
  const opts = parseFlags(flags);
  if (!opts.provider) {
    io.err("--provider is required");
    return 2;
  }

  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const provider = rows.find((r) => r.name === opts.provider);
  if (!provider) {
    io.err(`No provider named "${opts.provider}". Run \`cogmo provider list\` to see options.`);
    return 1;
  }

  let result: { id: string; position: number };
  try {
    result = await addModelRouting(deps, {
      model,
      providerId: provider.id,
      ...(opts.contextWindow != null && { contextWindow: opts.contextWindow }),
      ...(opts.maxOutputTokens != null && { maxOutputTokens: opts.maxOutputTokens }),
      ...(opts.position != null && { position: opts.position }),
    });
  } catch (err) {
    io.err(`Failed to add model routing: ${(err as Error).message}`);
    return 1;
  }

  // Show what the resolver will see, so the operator immediately knows
  // whether their --context / --max-output landed or whether LiteLLM /
  // the conservative default is doing the work.
  const limits = resolveLimits(model, {
    contextWindow: opts.contextWindow ?? null,
    maxOutputTokens: opts.maxOutputTokens ?? null,
  });
  io.out(`Added "${model}" → "${opts.provider}" at position ${result.position}.`);
  io.out(
    `  effective limits: context=${limits.contextWindow}, max_output=${limits.maxOutputTokens} (source: ${limits.source})`,
  );
  return 0;
}

async function listModels(args: readonly string[], deps: ModelCliDeps, io: CliIo): Promise<number> {
  const opts = parseFlags(args);

  const allModels = await deps.runInTx((tx) => deps.agentStore.listAllModels(tx));
  const filtered = opts.model ? allModels.filter((m) => m === opts.model) : allModels;

  if (filtered.length === 0) {
    io.out("(no model routing rows)");
    return 0;
  }

  io.out("model\tprovider\tposition\tcontext\tmax_output\tsource");
  for (const model of filtered) {
    const rows = await deps.runInTx((tx) => deps.agentStore.listProvidersForModel(tx, model));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      if (opts.provider && row.name !== opts.provider) continue;
      const limits = resolveLimits(model, {
        contextWindow: row.contextWindow,
        maxOutputTokens: row.maxOutputTokens,
      });
      io.out(
        [
          model,
          row.name,
          String(i),
          String(limits.contextWindow),
          String(limits.maxOutputTokens),
          limits.source,
        ].join("\t"),
      );
    }
  }
  return 0;
}

async function removeModel(
  args: readonly string[],
  deps: ModelCliDeps,
  io: CliIo,
): Promise<number> {
  const [model, ...flags] = args;
  if (!model) {
    io.err("Usage: cogmo model remove <id> [--provider <name>]");
    return 2;
  }
  const opts = parseFlags(flags);

  const rows = await deps.runInTx((tx) => deps.agentStore.listProvidersForModel(tx, model));
  if (rows.length === 0) {
    io.err(`No routing rows for model "${model}".`);
    return 1;
  }

  if (opts.provider) {
    const target = rows.find((r) => r.name === opts.provider);
    if (!target) {
      io.err(`Model "${model}" is not routed via provider "${opts.provider}".`);
      return 1;
    }
    await deps.runInTx((tx) => deps.agentStore.removeModelProvider(tx, model, target.id));
    io.out(`Removed routing "${model}" → "${opts.provider}".`);
    return 0;
  }

  // No --provider: delete every row for this model.
  for (const row of rows) {
    await deps.runInTx((tx) => deps.agentStore.removeModelProvider(tx, model, row.id));
  }
  io.out(`Removed ${rows.length} routing row(s) for "${model}".`);
  return 0;
}

interface ParsedFlags {
  provider: string | undefined;
  model: string | undefined;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  position: number | undefined;
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const out: ParsedFlags = {
    provider: undefined,
    model: undefined,
    contextWindow: undefined,
    maxOutputTokens: undefined,
    position: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--provider":
        out.provider = value;
        i++;
        break;
      case "--model":
        out.model = value;
        i++;
        break;
      case "--context":
        out.contextWindow = parsePositiveInt(value, "--context");
        i++;
        break;
      case "--max-output":
        out.maxOutputTokens = parsePositiveInt(value, "--max-output");
        i++;
        break;
      case "--position":
        out.position = parsePositiveInt(value, "--position");
        i++;
        break;
      default:
        // Unknown flag — ignore silently here; main switch will error on
        // wrong commands. parseFlags is a generic helper.
        break;
    }
  }
  return out;
}

function parsePositiveInt(value: string | undefined, label: string): number {
  if (value === undefined) throw new Error(`${label} requires a numeric value`);
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} expects a non-negative integer, got "${value}"`);
  }
  return n;
}
