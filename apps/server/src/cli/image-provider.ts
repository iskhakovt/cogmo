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

import { command, extendType, optional, positional, string, subcommands } from "cmd-ts";
import { CANONICAL_NAME_RE } from "../agent/store/canonical-name.js";
import { describeImageCatalogError } from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import {
  type ImageGenerationDefaults,
  type ImageProviderTypeValue,
  imageProviderType,
} from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import { commitIfOk } from "../db/transactor.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { choice, identifier, optionalOption } from "./args.js";
import { type CliIo, EXIT_USAGE, type LoadDeps } from "./run.js";

export interface ImageProviderCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
  secretsStore: SecretsStore;
}

const providerType = choice(imageProviderType.enumValues, "type");

const providerName = extendType(string, {
  displayName: "name",
  async from(value) {
    // The name round-trips into `secrets.name` as `<name>_api_key`.
    if (!CANONICAL_NAME_RE.test(value)) {
      throw new Error(
        `Invalid name "${value}": must start with a lowercase letter and contain only ` +
          "lowercase letters, digits, hyphens, or underscores (≤32 chars). " +
          "This shape is reused as the secret name (`<name>_api_key`) — looser " +
          "values would let whitespace or shell metacharacters land in `secrets.name`.",
      );
    }
    return value;
  },
});

const trueOrFalse = extendType(
  choice(["true", "false"], "true|false"),
  async (value) => value === "true",
);

const cfgScale = extendType(string, {
  displayName: "0-20",
  async from(value) {
    const n = Number(value.trim());
    if (value.trim() === "" || !Number.isFinite(n) || n < 0 || n > 20) {
      throw new Error(`expected a number from 0 to 20, got "${value}"`);
    }
    return n;
  },
});

export function imageProviderCli(io: CliIo, loadDeps: LoadDeps<ImageProviderCliDeps>) {
  return subcommands({
    name: "image-provider",
    description: "Manage image generation providers (image_providers rows).",
    cmds: {
      add: command({
        name: "add",
        description:
          "Register an image provider, storing its API key as the secret <name>_api_key. The venice-only options pin its generation defaults.",
        args: {
          type: positional({
            type: providerType,
            displayName: "type",
            description: imageProviderType.enumValues.join(", "),
          }),
          name: positional({
            type: providerName,
            displayName: "name",
            description:
              "What image models route to it by: a lowercase letter, then up to 31 lowercase letters, digits, - or _.",
          }),
          apiKey: positional({ type: string, displayName: "api-key", description: "Its API key." }),
          baseUrl: positional({
            type: optional(string),
            displayName: "base-url",
            description:
              "Required for openai_compatible (e.g. https://api.openai.com/v1) and venice (https://api.venice.ai/api/v1); refused for fal.",
          }),
          safeMode: optionalOption({
            long: "safe-mode",
            type: trueOrFalse,
            description:
              "Venice only. Blur flagged content (Venice defaults to true); with false, a blurred response counts as a failed generation.",
          }),
          cfgScale: optionalOption({
            long: "cfg-scale",
            type: cfgScale,
            description: "Venice only. Prompt adherence; higher is stricter.",
          }),
          hideWatermark: optionalOption({
            long: "hide-watermark",
            type: trueOrFalse,
            description: "Venice only. Strip Venice's watermark.",
          }),
          stylePreset: optionalOption({
            long: "style-preset",
            type: identifier("preset"),
            description: "Venice only. A server-side style preset, e.g. Photographic.",
          }),
        },
        examples: [
          {
            description: "A fal account",
            command: "cogmo image-provider add fal fal key-...",
          },
          {
            description: "Venice, with safe mode off and a stricter prompt adherence",
            command:
              "cogmo image-provider add venice venice key-... https://api.venice.ai/api/v1 --safe-mode false --cfg-scale 12",
          },
        ],
        handler: (args) => addProviderCmd(args, loadDeps, io),
      }),
      list: command({
        name: "list",
        description: "Show registered image providers (name, type, base URL).",
        args: {},
        handler: async () => listProviders(await loadDeps(), io),
      }),
      remove: command({
        name: "remove",
        description: "Delete an image provider; its image_models rows cascade.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "An image provider.",
          }),
        },
        handler: async (args) => removeProvider(args, await loadDeps(), io),
      }),
    },
  });
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

interface AddArgs {
  type: ImageProviderTypeValue;
  name: string;
  apiKey: string;
  baseUrl: string | undefined;
  safeMode: boolean | undefined;
  cfgScale: number | undefined;
  hideWatermark: boolean | undefined;
  stylePreset: string | undefined;
}

async function addProviderCmd(
  args: AddArgs,
  loadDeps: LoadDeps<ImageProviderCliDeps>,
  io: CliIo,
): Promise<number> {
  const { type: providerType, name, apiKey } = args;
  const defaults: ImageGenerationDefaults = {
    ...(args.safeMode !== undefined && { safe_mode: args.safeMode }),
    ...(args.cfgScale !== undefined && { cfg_scale: args.cfgScale }),
    ...(args.hideWatermark !== undefined && { hide_watermark: args.hideWatermark }),
    ...(args.stylePreset !== undefined && { style_preset: args.stylePreset }),
  };
  const hasDefaults = Object.keys(defaults).length > 0;
  // Only the venice adapter sends these body fields; on another type they
  // would be dead JSONB the runtime never reads.
  if (hasDefaults && providerType !== "venice") {
    io.err(
      "--safe-mode / --cfg-scale / --hide-watermark / --style-preset are venice-only " +
        `(got type=${providerType})`,
    );
    return EXIT_USAGE;
  }
  // `imageGenerationDefaults` is omitted rather than stored as `{}` when no default is set.
  const attrs = hasDefaults ? { imageGenerationDefaults: defaults } : {};

  // One secret per provider, named like the wizard's `fal_api_key` slot, keeps key rotation per provider.
  const secretName = `${name}_api_key`;
  const deps = await loadDeps();
  // The secret rolls back with a rejected provider.
  const created = await commitIfOk(deps.runInTx, async (tx) => {
    const { id: secretId } = await deps.secretsStore.putSecret(tx, {
      name: secretName,
      plaintext: apiKey,
      description: `${providerType} image provider key (${name})`,
    });
    return deps.agentStore.createImageProvider(tx, {
      name,
      type: providerType,
      baseUrl: args.baseUrl ?? null,
      secretId,
      attrs,
    });
  });
  if (created.isErr()) {
    io.err(`Failed to add image provider: ${describeImageCatalogError(created.error)}`);
    return created.error.kind === "invalid_provider_config" ? EXIT_USAGE : 1;
  }
  io.out(`Added image provider "${name}" (id=${created.value.id}, secret=${secretName}).`);
  io.out(`Next: cogmo image-model add <model-name> --provider ${name} --model-string <id>`);
  return 0;
}

async function removeProvider(
  args: { name: string },
  deps: ImageProviderCliDeps,
  io: CliIo,
): Promise<number> {
  const { name } = args;
  const provider = await deps.runInTx((tx) => deps.agentStore.findImageProviderByName(tx, name));
  if (!provider) {
    io.err(`No image provider named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteImageProvider(tx, provider.id));
  io.out(`Removed image provider "${name}". Its image_models rows cascade-deleted.`);
  return 0;
}
