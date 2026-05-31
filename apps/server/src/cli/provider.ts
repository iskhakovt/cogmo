/**
 * `cogmo provider <command>` — manage `llm_providers` rows post-setup.
 *
 * Mirrors the wizard's provider step at the CLI: register a new provider
 * (validates the API key the same way), list registered providers, or
 * remove one (cascades to its `model_providers` rows). Designed so the
 * setup wizard is just an interactive front-end to these same domain
 * functions — no business-logic duplication between the two surfaces.
 */

import {
  type AdapterType,
  type AddProviderResult,
  addProvider,
} from "../agent/provider/add-provider.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { PROVIDER_BASE_URLS, type ProviderType } from "../setup/providers.js";

const USAGE = `Usage: cogmo provider <command> [args]

Commands:
  add <type> <name> <api-key> [base-url]
                          Register a provider. \`type\` is one of:
                          anthropic, openrouter, openai, custom.
                          base-url required for type=custom; optional
                          for the rest (defaults baked in).
  list                    Show registered providers (name | type | base url).
  remove <name>           Delete a provider (cascades to its model rows).
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface ProviderCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

export async function runProviderCli(
  argv: readonly string[],
  deps: ProviderCliDeps,
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

    case "list":
      return listProviders(deps, io);

    case "add":
      return addProviderCmd(rest, deps, io);

    case "remove":
      return removeProvider(rest, deps, io);

    default:
      io.err(`Unknown command: ${command}\n`);
      io.err(USAGE);
      return 1;
  }
}

async function listProviders(deps: ProviderCliDeps, io: CliIo): Promise<number> {
  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  if (rows.length === 0) {
    io.out("(no providers registered)");
    return 0;
  }
  io.out("name\ttype");
  for (const r of rows) {
    io.out(`${r.name}\t${r.type}`);
  }
  return 0;
}

async function addProviderCmd(
  args: readonly string[],
  deps: ProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const [providerTypeArg, name, apiKey, baseUrlArg] = args;
  if (!providerTypeArg || !name || !apiKey) {
    io.err("Usage: cogmo provider add <type> <name> <api-key> [base-url]");
    return 2;
  }
  if (
    providerTypeArg !== "anthropic" &&
    providerTypeArg !== "openrouter" &&
    providerTypeArg !== "openai" &&
    providerTypeArg !== "custom"
  ) {
    io.err(`Invalid type "${providerTypeArg}" — expected anthropic|openrouter|openai|custom`);
    return 2;
  }
  const providerType: ProviderType = providerTypeArg;
  const adapterType: AdapterType = providerType === "anthropic" ? "anthropic" : "openai_compatible";

  const baseUrl = baseUrlArg ?? PROVIDER_BASE_URLS[providerType];
  if (adapterType === "openai_compatible" && !baseUrl) {
    io.err(`type=${providerType} requires a base-url argument`);
    return 2;
  }

  const attrs = providerType === "openrouter" ? { promptCaching: true } : {};

  let result: AddProviderResult;
  try {
    result = await addProvider(deps, {
      name,
      type: adapterType,
      ...(baseUrl && { baseUrl }),
      apiKey,
      attrs,
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

async function removeProvider(
  args: readonly string[],
  deps: ProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const [name] = args;
  if (!name) {
    io.err("Usage: cogmo provider remove <name>");
    return 2;
  }
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
