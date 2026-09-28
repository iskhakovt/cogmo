/**
 * `cogmo model <command>` — manage `model_providers` routing rows post-setup.
 *
 * Mirrors the wizard's model picker step at the CLI: register a model
 * against an existing provider (with optional explicit limits), list
 * routing rows with their effective limits and source, or remove a row
 * (or all rows for a model). `refresh` asks `cogmo serve` to fetch the
 * model catalog the limits come from.
 */

import { command, option, positional, subcommands } from "cmd-ts";
import { addModelRouting } from "../agent/provider/add-model-routing.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { liveCatalogStatus } from "../llm/litellm-data.js";
import { resolveLimits } from "../llm/models.js";
import { describeError } from "../util/describe-error.js";
import { identifier, intAtLeast, optionalOption } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export interface ModelCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  /** Sends `model-catalog/refresh.requested`; `null` when `MODEL_CATALOG_URL=off`. */
  requestCatalogRefresh: (() => Promise<void>) | null;
}

export function modelCli(io: CliIo, loadDeps: LoadDeps<ModelCliDeps>) {
  return subcommands({
    name: "model",
    description: "Manage model routing (model_providers rows).",
    cmds: {
      add: command({
        name: "add",
        description: "Register a model on an existing provider.",
        args: {
          model: positional({
            type: identifier("model-id"),
            displayName: "model-id",
            description: "The id the provider serves it under.",
          }),
          provider: option({
            long: "provider",
            type: identifier("name"),
            description: "The provider to route it through (see `cogmo provider list`).",
          }),
          // A zero limit describes no model, while position 0 is the primary slot.
          contextWindow: optionalOption({
            long: "context",
            type: intAtLeast(1),
            description: "Context window in tokens. Omitted, the resolver picks it.",
          }),
          maxOutputTokens: optionalOption({
            long: "max-output",
            type: intAtLeast(1),
            description: "Max output tokens. Omitted, the resolver picks it.",
          }),
          position: optionalOption({
            long: "position",
            type: intAtLeast(0),
            description: "Slot in the model's fallback chain, 0 first. Omitted, the next free one.",
          }),
        },
        examples: [
          {
            description: "A model LiteLLM knows the limits of",
            command: "cogmo model add x-ai/grok-4.3 --provider openrouter",
          },
          {
            description: "A self-hosted model with explicit limits",
            command: "cogmo model add my/llama --provider vllm --context 200000 --max-output 8000",
          },
        ],
        handler: async (args) => addModelCmd(args, await loadDeps(), io),
      }),
      list: command({
        name: "list",
        description:
          "Show routing rows with their effective limits and each limit's source (db, litellm or default).",
        args: {
          model: optionalOption({
            long: "model",
            type: identifier("model-id"),
            description: "Only this model's rows.",
          }),
          provider: optionalOption({
            long: "provider",
            type: identifier("name"),
            description: "Only rows routed through this provider.",
          }),
        },
        handler: async (args) => listModels(args, await loadDeps(), io),
      }),
      remove: command({
        name: "remove",
        description: "Delete a model's routing rows.",
        args: {
          model: positional({
            type: identifier("model-id"),
            displayName: "model-id",
            description: "The model.",
          }),
          provider: optionalOption({
            long: "provider",
            type: identifier("name"),
            description: "Delete only the row through this provider. Omitted, every row.",
          }),
        },
        handler: async (args) => removeModel(args, await loadDeps(), io),
      }),
      refresh: command({
        name: "refresh",
        description:
          "Ask `cogmo serve` to fetch LiteLLM's model registry now rather than at its next six-hourly refresh.",
        args: {},
        handler: async () => refreshCatalog(await loadDeps(), io),
      }),
    },
  });
}

interface AddArgs {
  model: string;
  provider: string;
  contextWindow: number | undefined;
  maxOutputTokens: number | undefined;
  position: number | undefined;
}

async function addModelCmd(args: AddArgs, deps: ModelCliDeps, io: CliIo): Promise<number> {
  const { model, contextWindow, maxOutputTokens, position } = args;
  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const provider = rows.find((r) => r.name === args.provider);
  if (!provider) {
    io.err(`No provider named "${args.provider}". Run \`cogmo provider list\` to see options.`);
    return 1;
  }

  let result: { id: string; position: number };
  try {
    result = await addModelRouting(deps, {
      model,
      providerId: provider.id,
      ...(contextWindow !== undefined && { contextWindow }),
      ...(maxOutputTokens !== undefined && { maxOutputTokens }),
      ...(position !== undefined && { position }),
    });
  } catch (err) {
    io.err(`Failed to add model routing: ${(err as Error).message}`);
    return 1;
  }

  // Show what the resolver will see, so the operator knows whether their
  // --context / --max-output landed or LiteLLM / the default is doing the work.
  const limits = resolveLimits(model, {
    contextWindow: contextWindow ?? null,
    maxOutputTokens: maxOutputTokens ?? null,
  });
  io.out(`Added "${model}" → "${args.provider}" at position ${result.position}.`);
  io.out(
    `  effective limits: context=${limits.contextWindow} (${limits.contextWindowSource}), max_output=${limits.maxOutputTokens} (${limits.maxOutputTokensSource})`,
  );
  // The per-turn LlmProviderResolver memoizes by model for the process
  // lifetime (src/llm/resolver.ts), so a running `cogmo serve` keeps the old routing.
  io.out("");
  io.out("Restart `cogmo serve` for the change to take effect (resolver caches per process).");
  return 0;
}

interface ListArgs {
  model: string | undefined;
  provider: string | undefined;
}

async function listModels(args: ListArgs, deps: ModelCliDeps, io: CliIo): Promise<number> {
  const { model, provider } = args;
  // One join query returns every (model × provider) row.
  const rows = await deps.runInTx((tx) => deps.agentStore.listAllModelProviders(tx));
  const filtered = rows.filter(
    (r) =>
      (model === undefined || r.model === model) && (provider === undefined || r.name === provider),
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
    // `row.position` is the stored value, never the array index: positions
    // go non-sequential after deletes, and the fallback chain reads them.
    // The source collapses to one tag when both columns agree and shows
    // `cw=<src>,mo=<src>` when they differ, so a partial DB override
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
  // stderr keeps stdout to the rows, for anything reading them.
  io.err(describeCatalog());
  return 0;
}

/** Where the `litellm` source reads from: the live catalog, or only the bundled snapshot. */
function describeCatalog(): string {
  const live = liveCatalogStatus();
  if (!live) {
    return "litellm: bundled snapshot only; no catalog refresh has run (`cogmo model refresh`)";
  }
  return `litellm: catalog fetched ${live.fetchedAt.toISOString()} (${live.size} models), bundled snapshot behind it`;
}

function formatSource(cwSource: string, moSource: string): string {
  return cwSource === moSource ? cwSource : `cw=${cwSource},mo=${moSource}`;
}

async function refreshCatalog(deps: ModelCliDeps, io: CliIo): Promise<number> {
  if (!deps.requestCatalogRefresh) {
    io.err(
      "The catalog refresh is off (MODEL_CATALOG_URL=off); limits come from the bundled snapshot.",
    );
    return 1;
  }
  try {
    await deps.requestCatalogRefresh();
  } catch (err) {
    io.err(`Failed to request a catalog refresh: ${describeError(err)}`);
    return 1;
  }
  io.out("Requested a model catalog refresh from `cogmo serve`.");
  io.out("`cogmo model list` shows the new fetch time once it lands.");
  return 0;
}

interface RemoveArgs {
  model: string;
  provider: string | undefined;
}

async function removeModel(args: RemoveArgs, deps: ModelCliDeps, io: CliIo): Promise<number> {
  const { model, provider } = args;
  const rows = await deps.runInTx((tx) => deps.agentStore.listProvidersForModel(tx, model));
  if (rows.length === 0) {
    io.err(`No routing rows for model "${model}".`);
    return 1;
  }

  if (provider !== undefined) {
    const target = rows.find((r) => r.name === provider);
    if (!target) {
      io.err(`Model "${model}" is not routed via provider "${provider}".`);
      return 1;
    }
    await deps.runInTx((tx) => deps.agentStore.removeModelProvider(tx, model, target.id));
    io.out(`Removed routing "${model}" → "${provider}".`);
    return 0;
  }

  // Every row for the model goes in one transaction, so a process dying
  // mid-loop leaves no partial state.
  await deps.runInTx(async (tx) => {
    for (const row of rows) {
      await deps.agentStore.removeModelProvider(tx, model, row.id);
    }
  });
  io.out(`Removed ${rows.length} routing row(s) for "${model}".`);
  return 0;
}
