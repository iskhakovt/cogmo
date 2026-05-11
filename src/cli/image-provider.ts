/**
 * `cogmo image-provider <command>` — manage `image_providers` rows post-setup.
 *
 * Mirrors `cogmo provider` (LLM providers) but for image generation. The
 * setup wizard handles fal-only configuration via the existing API-key
 * prompt; this CLI is the surface for adding `openai_compatible` providers
 * (Venice, OpenAI's `/images/generations`, custom inference servers) and
 * any post-setup edits.
 *
 * Image providers have no `model_providers`-style routing chain — one
 * model = one provider. Deletion cascades to `image_models`.
 */

import { InvalidProviderConfigError } from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import type { ImageProviderTypeValue } from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";

const USAGE = `Usage: cogmo image-provider <command> [args]

Commands:
  add <type> <name> <api-key> [base-url]
                          Register an image provider. \`type\` is one of:
                          fal, openai_compatible. base-url is REQUIRED for
                          openai_compatible (e.g. https://api.venice.ai/api/v1)
                          and FORBIDDEN for fal.
  list                    Show registered image providers (name | type | base url).
  remove <name>           Delete a provider (cascades to its image_models rows).
`;

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const CONSOLE_IO: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

export interface ImageProviderCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

export async function runImageProviderCli(
  argv: readonly string[],
  deps: ImageProviderCliDeps,
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

async function listProviders(deps: ImageProviderCliDeps, io: CliIo): Promise<number> {
  const rows = await deps.runInTx((tx) => deps.agentStore.listImageProviders(tx));
  if (rows.length === 0) {
    io.out("(no image providers registered)");
    return 0;
  }
  io.out("name\ttype\tbase_url");
  for (const r of rows) {
    io.out(`${r.name}\t${r.type}\t${r.baseUrl ?? "-"}`);
  }
  return 0;
}

async function addProviderCmd(
  args: readonly string[],
  deps: ImageProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const [typeArg, name, apiKey, baseUrlArg] = args;
  if (!typeArg || !name || !apiKey) {
    io.err("Usage: cogmo image-provider add <type> <name> <api-key> [base-url]");
    return 2;
  }
  if (typeArg !== "fal" && typeArg !== "openai_compatible") {
    io.err(`Invalid type "${typeArg}" — expected fal|openai_compatible`);
    return 2;
  }
  const providerType: ImageProviderTypeValue = typeArg;
  const baseUrl = baseUrlArg ?? null;

  // Materialize the API key into a secret named `<provider-name>_api_key` —
  // consistent with the canonical `fal_api_key` slot the wizard uses, just
  // namespaced for arbitrary providers (`venice_api_key`, etc.). One secret
  // per provider keeps key rotation straightforward.
  const secretName = `${name}_api_key`;
  try {
    const { id: providerId } = await deps.runInTx(async (tx) => {
      const { id: secretId } = await deps.secretsStore.putSecret(tx, {
        name: secretName,
        plaintext: apiKey,
        description: `${providerType} image provider key (${name})`,
      });
      return deps.agentStore.createImageProvider(tx, {
        name,
        type: providerType,
        baseUrl,
        secretId,
        attrs: {},
      });
    });
    io.out(`Added image provider "${name}" (id=${providerId}, secret=${secretName}).`);
    io.out(`Next: cogmo image-model add <model-name> --provider ${name} --model-string <id>`);
    io.out("");
    io.out("Restart `cogmo serve` for the change to take effect (image catalog loaded at boot).");
    return 0;
  } catch (err) {
    if (err instanceof InvalidProviderConfigError) {
      io.err(`Invalid config: ${err.reason}`);
      return 2;
    }
    io.err(`Failed to add image provider: ${(err as Error).message}`);
    return 1;
  }
}

async function removeProvider(
  args: readonly string[],
  deps: ImageProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const [name] = args;
  if (!name) {
    io.err("Usage: cogmo image-provider remove <name>");
    return 2;
  }
  const provider = await deps.runInTx((tx) => deps.agentStore.findImageProviderByName(tx, name));
  if (!provider) {
    io.err(`No image provider named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteImageProvider(tx, provider.id));
  io.out(`Removed image provider "${name}". Its image_models rows cascade-deleted.`);
  io.out("Restart `cogmo serve` for the change to take effect.");
  return 0;
}
