/**
 * `cogmo provider <command>` — manage `llm_providers` rows post-setup.
 *
 * Mirrors the wizard's provider step at the CLI: register a new provider
 * (validates the API key the same way), list registered providers, change
 * one's cache dialect, or remove one (cascades to its `model_providers`
 * rows). Designed so the setup wizard is just an interactive front-end to
 * these same domain functions — no business-logic duplication between the
 * two surfaces.
 */

import { command, oneOf, option, optional, positional, string, subcommands } from "cmd-ts";
import {
  type AdapterType,
  type AddProviderResult,
  addProvider,
} from "../agent/provider/add-provider.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { type CacheDialect, CacheDialectSchema } from "../llm/cache-dialect.js";
import type { SecretsStore } from "../secrets/store/index.js";
import {
  defaultCacheDialect,
  PROVIDER_BASE_URLS,
  PROVIDER_TYPES,
  type ProviderType,
} from "../setup/providers.js";
import { identifier, optionalOption } from "./args.js";
import { type CliIo, EXIT_USAGE, type LoadDeps } from "./run.js";

export interface ProviderCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

const cacheDialect = { ...oneOf(CacheDialectSchema.options), displayName: "dialect" };
const CACHE_DIALECT_HELP = `Caching hints an OpenAI-compatible endpoint takes: ${CacheDialectSchema.options.join(", ")}.`;

export function providerCli(io: CliIo, loadDeps: LoadDeps<ProviderCliDeps>) {
  return subcommands({
    name: "provider",
    description: "Manage LLM providers (llm_providers rows).",
    cmds: {
      add: command({
        name: "add",
        description: "Register a provider, validating its API key.",
        args: {
          type: positional({
            type: oneOf(PROVIDER_TYPES),
            displayName: "type",
            description: PROVIDER_TYPES.join(", "),
          }),
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "What models route to it by.",
          }),
          apiKey: positional({ type: string, displayName: "api-key", description: "Its API key." }),
          baseUrl: positional({
            type: optional(string),
            displayName: "base-url",
            description: "Required for type custom; the rest default to their own endpoint.",
          }),
          cacheDialect: optionalOption({
            long: "cache-dialect",
            type: cacheDialect,
            description: `${CACHE_DIALECT_HELP} Omitted, type openrouter takes openrouter and the rest follow the base URL's host.`,
          }),
        },
        examples: [
          {
            description: "An OpenRouter account",
            command: "cogmo provider add openrouter or sk-or-...",
          },
          {
            description: "A self-hosted OpenAI-compatible endpoint",
            command: "cogmo provider add custom vllm sk-... http://vllm:8000/v1",
          },
        ],
        handler: (args) => addProviderCmd(args, loadDeps, io),
      }),
      list: command({
        name: "list",
        description: "Show registered providers (name, type, base URL, cache dialect).",
        args: {},
        handler: async () => listProviders(await loadDeps(), io),
      }),
      set: command({
        name: "set",
        description:
          "Change an OpenAI-compatible provider's cache dialect, keeping its model rows.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "A provider.",
          }),
          cacheDialect: option({
            long: "cache-dialect",
            type: cacheDialect,
            description: CACHE_DIALECT_HELP,
          }),
        },
        handler: async (args) => setProvider(args, await loadDeps(), io),
      }),
      remove: command({
        name: "remove",
        description: "Delete a provider; its model routing rows cascade.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "A provider.",
          }),
        },
        handler: async (args) => removeProvider(args, await loadDeps(), io),
      }),
    },
  });
}

async function listProviders(deps: ProviderCliDeps, io: CliIo): Promise<number> {
  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  if (rows.length === 0) {
    io.out("(no providers registered)");
    return 0;
  }
  io.out("name\ttype\tbase_url\tcache_dialect");
  for (const r of rows) {
    // Anthropic rows carry no dialect; on an OpenAI-compatible row, absent reads as `none`.
    const dialect = r.type === "anthropic" ? "-" : (r.attrs.cacheDialect ?? "none");
    io.out(`${r.name}\t${r.type}\t${r.baseUrl ?? "-"}\t${dialect}`);
  }
  return 0;
}

interface AddArgs {
  type: ProviderType;
  name: string;
  apiKey: string;
  baseUrl: string | undefined;
  cacheDialect: CacheDialect | undefined;
}

async function addProviderCmd(
  args: AddArgs,
  loadDeps: LoadDeps<ProviderCliDeps>,
  io: CliIo,
): Promise<number> {
  const { type: providerType, name, apiKey, cacheDialect } = args;
  const adapterType: AdapterType = providerType === "anthropic" ? "anthropic" : "openai_compatible";
  if (adapterType === "anthropic" && cacheDialect) {
    io.err("--cache-dialect applies to OpenAI-compatible providers only");
    return EXIT_USAGE;
  }

  const baseUrl = args.baseUrl ?? PROVIDER_BASE_URLS[providerType];
  if (adapterType === "openai_compatible" && !baseUrl) {
    io.err(`type=${providerType} requires a base-url argument`);
    return EXIT_USAGE;
  }
  const dialect = defaultCacheDialect(providerType, cacheDialect);

  let result: AddProviderResult;
  try {
    result = await addProvider(await loadDeps(), {
      name,
      type: adapterType,
      ...(baseUrl && { baseUrl }),
      apiKey,
      ...(dialect && { cacheDialect: dialect }),
    });
  } catch (err) {
    io.err(`Failed to add provider: ${(err as Error).message}`);
    return 1;
  }

  if (!result.validation.valid) {
    io.err(`Warning: API key validation failed (${result.validation.error ?? "unknown"})`);
    io.err("Provider saved anyway — first chat will surface any real failure.");
  }
  io.out(`Added provider "${name}" (id=${result.providerId}).`);
  io.out(`Next: cogmo model add <model-id> --provider ${name}`);
  return 0;
}

interface SetArgs {
  name: string;
  cacheDialect: CacheDialect;
}

async function setProvider(args: SetArgs, deps: ProviderCliDeps, io: CliIo): Promise<number> {
  const { name, cacheDialect } = args;
  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const match = rows.find((r) => r.name === name);
  if (!match) {
    io.err(`No provider named "${name}".`);
    return 1;
  }
  if (match.type === "anthropic") {
    io.err("--cache-dialect applies to OpenAI-compatible providers only");
    return EXIT_USAGE;
  }

  const updated = await deps.runInTx((tx) =>
    deps.agentStore.setProviderCacheDialect(tx, match.id, cacheDialect),
  );
  if (!updated) {
    io.err(`No provider named "${name}".`);
    return 1;
  }
  io.out(`Set "${name}" cache dialect: ${match.attrs.cacheDialect ?? "none"} → ${cacheDialect}.`);
  io.out("Restart `cogmo serve` to apply.");
  return 0;
}

async function removeProvider(
  args: { name: string },
  deps: ProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const { name } = args;
  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const match = rows.find((r) => r.name === name);
  if (!match) {
    io.err(`No provider named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteProvider(tx, match.id));
  io.out(`Removed provider "${name}". Its model_providers rows cascade-deleted.`);
  return 0;
}
