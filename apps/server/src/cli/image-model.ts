/**
 * `cogmo image-model <command>` — manage `image_models` catalog rows post-setup.
 *
 * Mirrors `cogmo model` (LLM models) but for image generation. Each row
 * binds a provider to a (name, model-string, description, capabilities)
 * tuple. The LLM sees `name` in its tool description; the provider API
 * sees `model_string`.
 *
 * `userSelectable` defaults to true — pass `--no-selectable` to stage
 * experimental or deprecated rows that stay in the DB but don't appear in
 * the `generate_image` tool's `model` enum.
 */

import { command, extendType, flag, option, positional, string, subcommands } from "cmd-ts";
import { describeImageCatalogError } from "../agent/store/errors.js";
import type { AgentStore } from "../agent/store/index.js";
import {
  IMAGE_ALLOWED_ASPECT_RATIOS,
  type ImageAspectRatio,
  type ImageModelCapabilities,
  ImageModelCapabilitiesSchema,
} from "../agent/store/schema.js";
import type { Transactor } from "../db/index.js";
import { choice, identifier, optionalOption, text } from "./args.js";
import type { CliIo, LoadDeps } from "./run.js";

export interface ImageModelCliDeps {
  runInTx: Transactor;
  agentStore: AgentStore;
}

const ASPECT_RATIOS = IMAGE_ALLOWED_ASPECT_RATIOS.join(", ");

const aspectRatios = extendType(string, {
  displayName: "ratios",
  async from(value): Promise<ImageAspectRatio[]> {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) throw new Error(`expected at least one aspect ratio, got "${value}"`);
    return parts.map((part) => {
      const ratio = IMAGE_ALLOWED_ASPECT_RATIOS.find((r) => r === part);
      if (!ratio) {
        throw new Error(`unknown aspect ratio "${part}"; expected one of ${ASPECT_RATIOS}`);
      }
      return ratio;
    });
  },
});

const imageInputMode = choice(
  ImageModelCapabilitiesSchema.shape.imageInput.unwrap().options,
  "mode",
);

export function imageModelCli(io: CliIo, loadDeps: LoadDeps<ImageModelCliDeps>) {
  return subcommands({
    name: "image-model",
    description: "Manage the image model catalog (image_models rows).",
    cmds: {
      add: command({
        name: "add",
        description: "Register an image model on an image provider.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description:
              "What the LLM picks it by; unique across providers, by convention <provider>/<slug>.",
          }),
          provider: option({
            long: "provider",
            type: identifier("provider"),
            description: "The image provider serving it.",
          }),
          modelString: option({
            long: "model-string",
            type: identifier("id"),
            description: "The model id sent to the provider API.",
          }),
          description: option({
            long: "description",
            type: text,
            description: "Its hint line in the generate_image tool, read by the LLM every turn.",
          }),
          ratios: optionalOption({
            long: "ratios",
            type: aspectRatios,
            description: `Supported aspect ratios, comma-separated, from ${ASPECT_RATIOS}. Omit for a fixed-size model.`,
          }),
          seed: flag({ long: "seed", description: "It honors the seed parameter." }),
          imageInput: optionalOption({
            long: "image-input",
            type: imageInputMode,
            description:
              "It takes a reference image: required for edit-only models like fal/flux-kontext, optional when one is accepted. fal providers only.",
          }),
          negativePrompt: flag({
            long: "negative-prompt",
            description:
              "It takes a negative prompt, forwarded to fal (providerOptions.fal.negative_prompt) or venice (native body field). OpenAI-compatible models typically don't.",
          }),
          noSelectable: flag({
            long: "no-selectable",
            description:
              "Keep it out of the generate_image tool's model list, to stage an experimental or deprecated model.",
          }),
        },
        examples: [
          {
            description: "A fal model with aspect ratios and seed support",
            command:
              'cogmo image-model add fal/flux-dev --provider fal --model-string fal-ai/flux/dev --description "Balanced quality and speed" --ratios 1:1,16:9,9:16 --seed',
          },
          {
            description: "An edit-only model",
            command:
              'cogmo image-model add fal/flux-kontext --provider fal --model-string fal-ai/flux-pro/kontext --description "Edits a reference image" --image-input required',
          },
        ],
        handler: async (args) => addModelCmd(args, await loadDeps(), io),
      }),
      list: command({
        name: "list",
        description: "Show the image models the LLM can pick.",
        args: {
          provider: optionalOption({
            long: "provider",
            type: identifier("provider"),
            description: "Only this image provider's models.",
          }),
          all: flag({ long: "all", description: "Include models hidden with --no-selectable." }),
        },
        handler: async (args) => listModels(args, await loadDeps(), io),
      }),
      remove: command({
        name: "remove",
        description: "Delete an image model.",
        args: {
          name: positional({
            type: identifier("name"),
            displayName: "name",
            description: "Its LLM-facing name.",
          }),
        },
        handler: async (args) => removeModel(args, await loadDeps(), io),
      }),
    },
  });
}

interface AddArgs {
  name: string;
  provider: string;
  modelString: string;
  description: string;
  ratios: ImageAspectRatio[] | undefined;
  seed: boolean;
  imageInput: ImageModelCapabilities["imageInput"];
  negativePrompt: boolean;
  noSelectable: boolean;
}

async function addModelCmd(args: AddArgs, deps: ImageModelCliDeps, io: CliIo): Promise<number> {
  const { name, modelString, description } = args;
  const provider = await deps.runInTx((tx) =>
    deps.agentStore.findImageProviderByName(tx, args.provider),
  );
  if (!provider) {
    io.err(
      `No image provider named "${args.provider}". Run \`cogmo image-provider list\` to see options.`,
    );
    return 1;
  }

  // Only the capabilities the operator opted into, so the JSONB row holds no empty arrays.
  const capabilities: ImageModelCapabilities = {
    ...(args.ratios && { aspectRatios: args.ratios }),
    ...(args.seed && { seed: true }),
    ...(args.imageInput && { imageInput: args.imageInput }),
    ...(args.negativePrompt && { negativePrompt: true }),
  };

  const created = await deps.runInTx((tx) =>
    deps.agentStore.createImageModel(tx, {
      providerId: provider.id,
      name,
      modelString,
      description,
      capabilities,
      userSelectable: !args.noSelectable,
    }),
  );
  if (created.isErr()) {
    io.err(`Failed to add image model: ${describeImageCatalogError(created.error)}`);
    return 1;
  }
  io.out(`Added image model "${name}" (id=${created.value.id}, provider=${provider.name}).`);
  return 0;
}

async function listModels(
  args: { provider: string | undefined; all: boolean },
  deps: ImageModelCliDeps,
  io: CliIo,
): Promise<number> {
  // Without `--all`, the same filter the bootstrap applies: the catalog the LLM sees.
  const rows = await deps.runInTx((tx) =>
    deps.agentStore.listImageModelsWithProvider(tx, { userSelectableOnly: !args.all }),
  );
  const filtered = args.provider ? rows.filter((r) => r.provider.name === args.provider) : rows;
  if (filtered.length === 0) {
    io.out("(no image models)");
    return 0;
  }
  io.out("name\tprovider\tmodel_string\tratios\tseed\timage_input\tneg_prompt\tselectable");
  for (const row of filtered) {
    const ratios = row.capabilities.aspectRatios?.join(",") ?? "-";
    const seed = row.capabilities.seed === true ? "yes" : "no";
    const imageInput = row.capabilities.imageInput ?? "-";
    const negativePrompt = row.capabilities.negativePrompt === true ? "yes" : "no";
    io.out(
      [
        row.name,
        row.provider.name,
        row.modelString,
        ratios,
        seed,
        imageInput,
        negativePrompt,
        row.userSelectable ? "yes" : "no",
      ].join("\t"),
    );
  }
  return 0;
}

async function removeModel(
  args: { name: string },
  deps: ImageModelCliDeps,
  io: CliIo,
): Promise<number> {
  const { name } = args;
  const rows = await deps.runInTx((tx) => deps.agentStore.listImageModels(tx));
  const target = rows.find((r) => r.name === name);
  if (!target) {
    io.err(`No image model named "${name}".`);
    return 1;
  }
  await deps.runInTx((tx) => deps.agentStore.deleteImageModel(tx, target.id));
  io.out(`Removed image model "${name}".`);
  return 0;
}
