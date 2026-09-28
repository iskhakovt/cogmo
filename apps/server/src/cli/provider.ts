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

import { err, ok, type Result } from "neverthrow";
import {
  type AdapterType,
  type AddProviderResult,
  addProvider,
} from "../agent/provider/add-provider.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { type CacheDialect, CacheDialectSchema } from "../llm/cache-dialect.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { defaultCacheDialect, PROVIDER_BASE_URLS, type ProviderType } from "../setup/providers.js";

const USAGE = `Usage: cogmo provider <command> [args]

Commands:
  add <type> <name> <api-key> [base-url] [--cache-dialect <dialect>]
                          Register a provider. \`type\` is one of:
                          anthropic, openrouter, openai, custom.
                          base-url required for type=custom; optional
                          for the rest (defaults baked in).
                          --cache-dialect (openrouter|openai|xai|none)
                          sets the caching hints an OpenAI-compatible
                          endpoint takes. Omitted, type=openrouter
                          takes openrouter and the rest follow the
                          base URL's host.
  list                    Show registered providers (name | type | base url |
                          cache dialect).
  set <name> --cache-dialect <dialect>
                          Change an OpenAI-compatible provider's cache
                          dialect, keeping its model rows.
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

    case "set":
      return setProvider(rest, deps, io);

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
  io.out("name\ttype\tbase_url\tcache_dialect");
  for (const r of rows) {
    // Anthropic rows carry no dialect; on an OpenAI-compatible row, absent reads as `none`.
    const dialect = r.type === "anthropic" ? "-" : (r.attrs.cacheDialect ?? "none");
    io.out(`${r.name}\t${r.type}\t${r.baseUrl ?? "-"}\t${dialect}`);
  }
  return 0;
}

async function addProviderCmd(
  args: readonly string[],
  deps: ProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const parsed = splitArgs(args);
  if (parsed.isErr()) {
    io.err(parsed.error);
    return 2;
  }
  const { positional, flags } = parsed.value;
  const { cacheDialect } = flags;

  const [providerTypeArg, name, apiKey, baseUrlArg] = positional;
  if (!providerTypeArg || !name || !apiKey) {
    io.err(
      "Usage: cogmo provider add <type> <name> <api-key> [base-url] [--cache-dialect <dialect>]",
    );
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
  if (adapterType === "anthropic" && cacheDialect) {
    io.err("--cache-dialect applies to OpenAI-compatible providers only");
    return 2;
  }

  const baseUrl = baseUrlArg ?? PROVIDER_BASE_URLS[providerType];
  if (adapterType === "openai_compatible" && !baseUrl) {
    io.err(`type=${providerType} requires a base-url argument`);
    return 2;
  }
  const dialect = defaultCacheDialect(providerType, cacheDialect);

  let result: AddProviderResult;
  try {
    result = await addProvider(deps, {
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

interface ProviderFlags {
  cacheDialect?: CacheDialect;
}

/** Positional arguments up to the first `--flag`, and the flags after it. */
function splitArgs(
  args: readonly string[],
): Result<{ positional: readonly string[]; flags: ProviderFlags }, string> {
  const flagAt = args.findIndex((arg) => arg.startsWith("--"));
  const positional = flagAt === -1 ? args : args.slice(0, flagAt);
  return parseFlags(flagAt === -1 ? [] : args.slice(flagAt)).map((flags) => ({
    positional,
    flags,
  }));
}

function parseFlags(flags: readonly string[]): Result<ProviderFlags, string> {
  const [flag, value, ...rest] = flags;
  if (flag === undefined) return ok({});
  if (flag !== "--cache-dialect") {
    return err(`Unknown flag "${flag}". Run \`cogmo provider --help\` for accepted flags.`);
  }
  if (value === undefined || value.startsWith("--")) return err("--cache-dialect needs a value");
  const dialect = CacheDialectSchema.safeParse(value);
  if (!dialect.success) {
    return err(`--cache-dialect must be one of ${CacheDialectSchema.options.join(", ")}`);
  }
  return parseFlags(rest).map((more) => ({ ...more, cacheDialect: dialect.data }));
}

async function setProvider(
  args: readonly string[],
  deps: ProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const parsed = splitArgs(args);
  if (parsed.isErr()) {
    io.err(parsed.error);
    return 2;
  }
  const [name] = parsed.value.positional;
  const { cacheDialect } = parsed.value.flags;
  if (!name || !cacheDialect) {
    io.err("Usage: cogmo provider set <name> --cache-dialect <dialect>");
    return 2;
  }

  const rows = await deps.runInTx((tx) => deps.agentStore.listProviders(tx));
  const match = rows.find((r) => r.name === name);
  if (!match) {
    io.err(`No provider named "${name}".`);
    return 1;
  }
  if (match.type === "anthropic") {
    io.err("--cache-dialect applies to OpenAI-compatible providers only");
    return 2;
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
