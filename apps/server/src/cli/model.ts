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
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "add":
        return await addModelCmd(rest, deps, io);
      case "list":
        return await listModels(rest, deps, io);
      case "remove":
        return await removeModel(rest, deps, io);
      default:
        io.err(`Unknown command: ${command}\n`);
        io.err(USAGE);
        return 1;
    }
  } catch (err) {
    // parseFlags + parseIntAtLeast throw on operator error (missing
    // value, bad integer, flag-as-value). Surface as a clean exit-2 rather
    // than letting the dispatcher's await unwind with a stack trace.
    io.err(`Error: ${(err as Error).message}`);
    return 2;
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
    `  effective limits: context=${limits.contextWindow} (${limits.contextWindowSource}), max_output=${limits.maxOutputTokens} (${limits.maxOutputTokensSource})`,
  );
  // The agent's per-turn LlmProviderResolver memoizes by model for the
  // process lifetime (see src/llm/resolver.ts). A running `cogmo serve`
  // won't pick up this routing change until restart. Mention it instead
  // of leaving the operator to discover the staleness mid-conversation.
  io.out("");
  io.out("Restart `cogmo serve` for the change to take effect (resolver caches per process).");
  return 0;
}

async function listModels(args: readonly string[], deps: ModelCliDeps, io: CliIo): Promise<number> {
  const opts = parseFlags(args);

  // One join query returns every (model × provider) row. Avoids the per-model
  // round-trip the earlier shape paid for the common case of listing all
  // routing rows.
  const rows = await deps.runInTx((tx) => deps.agentStore.listAllModelProviders(tx));
  const filtered = rows.filter(
    (r) => (!opts.model || r.model === opts.model) && (!opts.provider || r.name === opts.provider),
  );

  if (filtered.length === 0) {
    io.out("(no model routing rows)");
    return 0;
  }

  io.out("model\tprovider\tposition\tcontext\tmax_output\tsource");
  for (const row of filtered) {
    const limits = resolveLimits(row.model, {
      contextWindow: row.contextWindow,
      maxOutputTokens: row.maxOutputTokens,
    });
    // `row.position` is the actual stored value — never the array index.
    // Non-sequential positions are legal (intermediate row deletes), so an
    // index would mislead operators trying to call `cogmo model remove
    // --position` or read the fallback chain. Source column collapses to a
    // single tag when both columns agree (the common case), and shows
    // `cw=<src>,mo=<src>` when they differ — so a partial DB override
    // surfaces the LiteLLM contribution the resolver layered on top.
    const source = formatSource(limits.contextWindowSource, limits.maxOutputTokensSource);
    io.out(
      [
        row.model,
        row.name,
        String(row.position),
        String(limits.contextWindow),
        String(limits.maxOutputTokens),
        source,
      ].join("\t"),
    );
  }
  return 0;
}

function formatSource(cwSource: string, moSource: string): string {
  return cwSource === moSource ? cwSource : `cw=${cwSource},mo=${moSource}`;
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

  // No --provider: delete every row for this model in one transaction so
  // the bulk operation is atomic (no partial state if the process dies
  // mid-loop) and the DB only sees one round-trip per delete instead of
  // one per row plus tx overhead.
  await deps.runInTx(async (tx) => {
    for (const row of rows) {
      await deps.agentStore.removeModelProvider(tx, model, row.id);
    }
  });
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
    const value = takeValue(args, i, flag);
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
        out.contextWindow = parseIntAtLeast(value, "--context", 1);
        i++;
        break;
      case "--max-output":
        out.maxOutputTokens = parseIntAtLeast(value, "--max-output", 1);
        i++;
        break;
      case "--position":
        out.position = parseIntAtLeast(value, "--position", 0);
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

/**
 * Read the value following a flag, refusing the case where the next token
 * is itself a flag (e.g. `--provider --context 8000` would otherwise set
 * `provider = "--context"` and silently drop `--context`'s real value).
 * `--` is not a flag value, so a literal hyphen has to be quoted by the
 * shell to reach here — at which point passing it on is the operator's
 * problem.
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

/**
 * `min` differs per flag: a limit of zero describes no model, while
 * position 0 is the primary route. Both are refused again downstream —
 * `addModelRouting` for the limits, the `(model, position)` UNIQUE for
 * position — but a bad value is worth naming here, where the flag it came
 * from is still known.
 */
function parseIntAtLeast(value: string, label: string, min: number): number {
  // `Number.parseInt("200000abc", 10)` returns 200000 — silently accepting
  // trailing garbage. `Number(value)` rejects mixed-content strings with
  // NaN, which `Number.isInteger` then catches. The trim guards against
  // accidental whitespace from shell pipelines.
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${label} expects an integer >= ${min}, got "${value}"`);
  }
  return n;
}
