import { APICallError, generateImage } from "ai";
import { z } from "zod";
import type { ImageModelWithProvider } from "../agent/store/index.js";
import type { ImageProvider } from "../llm/image-providers.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import { defineTool, type ToolSpec } from "./tools.js";

/**
 * The shape returned by the `generate_image` tool's text result (JSON-encoded).
 *
 * Two consumers parse this payload — the orchestrator's batch path
 * (`extractGeneratedImages`) and the Telegram stream handle (mid-stream
 * `sendPhoto`). Keep this contract in one place so any field change
 * touches both consumers via the type system.
 */
export interface GeneratedImagePayload {
  path: string;
  mediaType: string;
  /** Model the LLM picked. Informational — not used by delivery. */
  model?: string;
}

/**
 * Parse and validate a `generate_image` tool_result body.
 *
 * Returns `null` on any failure (non-JSON, missing/wrong-typed fields).
 * Callers silently skip null results — the contract is convention-based,
 * and a malformed payload from a future or failed tool call shouldn't
 * crash delivery.
 */
export function parseGeneratedImagePayload(raw: string): GeneratedImagePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.path !== "string" || typeof obj.mediaType !== "string") return null;
  return {
    path: obj.path,
    mediaType: obj.mediaType,
    ...(typeof obj.model === "string" && { model: obj.model }),
  };
}

/**
 * Build the LLM-facing tool description from the loaded model catalog.
 * Each user-selectable model contributes one line with its `description`
 * and the ratios it accepts (or "fixed size" when `capabilities.aspectRatios`
 * is absent/empty). Models that accept a reference image carry a
 * `[needs reference image]` / `[optional reference image]` hint so the LLM
 * knows when to populate `referenceImage`. The prose ending is constant
 * across deployments.
 */
function buildToolDescription(
  models: ReadonlyArray<ImageModelWithProvider>,
  anyImageInput: boolean,
): string {
  const lines = models.map((m) => {
    const ratios = m.capabilities.aspectRatios;
    const ratioHint =
      ratios && ratios.length > 0 ? ` (ratios: ${ratios.join(", ")})` : " (fixed size)";
    const imageInputHint =
      m.capabilities.imageInput === "required"
        ? " [needs reference image]"
        : m.capabilities.imageInput === "optional"
          ? " [optional reference image]"
          : "";
    return `- \`${m.name}\` — ${m.description}${ratioHint}${imageInputHint}`;
  });
  const referenceImageNote = anyImageInput
    ? [
        "",
        "For models marked `[needs reference image]` or `[optional reference image]`, " +
          "pass `referenceImage` — an AttachmentStore path (e.g. `inbound/abc.png` from a " +
          "user-uploaded image, or `generated/xyz.png` from an image you previously " +
          "generated). The `prompt` describes the edit; the reference image is what " +
          "you're editing.",
      ]
    : [];
  return [
    "Generate an image from a text description. The image is returned to the user.",
    "",
    "Choose the model based on the task:",
    ...lines,
    ...referenceImageNote,
    "",
    "Write a detailed prompt — describe subject, style, composition, colors, and mood. " +
      "The prompt is the main lever for image quality.",
  ].join("\n");
}

/**
 * Build the `generate_image` tool from the loaded image catalog.
 *
 * Inputs are loaded at bootstrap and reused across every turn — same
 * caching posture as `LlmProviderResolver`. Hot-reload is a deferred p3.
 *
 * Returns `[]` (no tool registered) when `models.length === 0`. Cleaner
 * than registering a tool that always errors — the LLM simply doesn't
 * see `generate_image` in its tool list.
 */
export function createImageTools(deps: {
  models: ReadonlyArray<ImageModelWithProvider>;
  providers: ReadonlyMap<string, ImageProvider>;
  attachments: AttachmentStore;
}): ToolSpec[] {
  if (deps.models.length === 0) return [];

  const modelNames = deps.models.map((m) => m.name);
  const modelByName = new Map(deps.models.map((m) => [m.name, m]));

  // Union, not intersection — a fixed-size model would otherwise collapse
  // every other model's options. Per-model narrowing happens in the
  // handler so the LLM gets a contextual error when it picks an
  // unsupported ratio.
  const ratioUnion = new Set<string>();
  for (const m of deps.models) {
    for (const r of m.capabilities.aspectRatios ?? []) ratioUnion.add(r);
  }

  // Zod's `z.enum` requires a non-empty literal tuple; build it once.
  const modelEnum = z.enum(modelNames as [string, ...string[]]);
  const aspectRatioField =
    ratioUnion.size > 0
      ? z.enum([...ratioUnion] as [string, ...string[]]).optional()
      : z.never().optional();

  const anyImageInput = deps.models.some((m) => m.capabilities.imageInput !== undefined);

  return [
    defineTool({
      name: "generate_image",
      description: buildToolDescription(deps.models, anyImageInput),
      // Durable: each call bills $0.02-$0.04 and uploads to AttachmentStore.
      // On Inngest retry the cached JSON result (path + mediaType) replays,
      // so we neither re-bill the provider nor produce duplicate uploads.
      durable: true,
      schema: z.object({
        prompt: z.string().min(1).describe("Detailed image description"),
        model: modelEnum
          // biome-ignore lint/style/noNonNullAssertion: length>0 guarded above
          .default(modelNames[0]!)
          .describe("Model — choose based on task (see tool description)"),
        aspectRatio: aspectRatioField.describe("Aspect ratio (if model supports it)"),
        seed: z.number().int().optional().describe("Seed (if model honors it)"),
        referenceImage: z
          .string()
          .optional()
          .describe(
            "AttachmentStore path of an image to edit. Only valid for models " +
              "marked `[needs reference image]` or `[optional reference image]`.",
          ),
      }),
      handler: async (input) => {
        const row = modelByName.get(input.model);
        if (!row) return `Error: unknown model ${input.model}`;
        const provider = deps.providers.get(row.providerId);
        if (!provider) {
          // Should never happen — the bootstrap loop populates `providers`
          // from the same DB rows we used to build `models`. If it does,
          // something has gone badly wrong; surface to the LLM rather than
          // crashing the turn.
          return `Error: model ${row.name} references unknown provider`;
        }

        // Treat absent and [] identically — both mean "model accepts no
        // aspectRatio". Both surface as a text error the LLM can recover
        // from (re-pick a ratio or pick a different model), not silent drop.
        const supportedRatios = row.capabilities.aspectRatios ?? [];
        if (input.aspectRatio && !supportedRatios.includes(input.aspectRatio)) {
          const hint =
            supportedRatios.length > 0
              ? `Supported: ${supportedRatios.join(", ")}.`
              : "This model does not accept a custom aspect ratio.";
          return `Error: model ${row.name} does not support aspect ratio ${input.aspectRatio}. ${hint}`;
        }

        // Reference-image gating. Three text-recoverable error shapes the
        // LLM can act on: (a) required-but-missing → re-call with the path;
        // (b) supplied-but-unsupported by this model → pick a different
        // model or drop the field; (c) supplied to a non-fal provider →
        // pick a fal model (the only validated path today). The fetch
        // itself is wrapped: an attachment-store miss surfaces as a text
        // error rather than a thrown rejection that crashes the turn.
        const imageInputCap = row.capabilities.imageInput;
        if (imageInputCap === "required" && !input.referenceImage) {
          return (
            `Error: model ${row.name} is an image-editing model and requires ` +
            "`referenceImage` — pass the AttachmentStore path of the image you want to edit."
          );
        }
        if (input.referenceImage && imageInputCap === undefined) {
          return `Error: model ${row.name} does not accept a reference image. Drop \`referenceImage\` or pick a model marked \`[needs reference image]\` or \`[optional reference image]\`.`;
        }
        if (input.referenceImage && provider.kind !== "fal") {
          return `Error: reference images are only supported by fal providers today (got ${provider.kind}). Pick a fal-backed model marked \`[needs reference image]\`.`;
        }
        let referenceImageBytes: Buffer | undefined;
        if (input.referenceImage) {
          try {
            referenceImageBytes = await deps.attachments.download(input.referenceImage);
          } catch (err) {
            return `Error: couldn't load referenceImage "${input.referenceImage}": ${(err as Error).message}`;
          }
        }

        const imageModel =
          provider.kind === "fal"
            ? provider.provider.image(row.modelString)
            : provider.provider.imageModel(row.modelString);
        const shouldForwardAspect =
          input.aspectRatio !== undefined && supportedRatios.includes(input.aspectRatio);
        const shouldForwardSeed = input.seed !== undefined && row.capabilities.seed === true;

        // The AI SDK's `prompt` field accepts either `string` (text-only) or
        // `{ text, images }` (image input). For fal models with a reference,
        // use the latter shape; everything else passes the plain string.
        // `as unknown as string` bridges the AI SDK's type — `generateImage`
        // accepts the object shape at runtime for fal but the public type
        // signature only declares `string` (provider-specific extension that
        // the SDK doesn't surface in its generic).
        const promptArg: unknown = referenceImageBytes
          ? { text: input.prompt, images: [referenceImageBytes] }
          : input.prompt;

        const { image } = await withRetry(
          async () => {
            try {
              // AI SDK types aspectRatio as `${number}:${number}`. Our Zod
              // enum validated the value against the same shape; the cast
              // bridges the literal-template typing. Explicit
              // `!== undefined` re-narrows for `exactOptionalPropertyTypes`.
              return await generateImage({
                model: imageModel,
                prompt: promptArg as string,
                ...(shouldForwardAspect &&
                  input.aspectRatio !== undefined && {
                    aspectRatio: input.aspectRatio as `${number}:${number}`,
                  }),
                ...(shouldForwardSeed && input.seed !== undefined && { seed: input.seed }),
              });
            } catch (err) {
              // Structured 4xx classification — same intent as the previous
              // fal-only handler. `isRetryable: false` on 4xx (except 429)
              // means re-trying the same request burns budget without
              // helping; promote to AbortError so withRetry stops.
              if (APICallError.isInstance(err) && err.isRetryable === false) {
                throw new AbortError(err.message);
              }
              throw err;
            }
          },
          { retries: 2, context: `image.generate.${row.name}` },
        );

        const buffer = Buffer.from(image.uint8Array);
        const path = await deps.attachments.upload(buffer, image.mediaType, "generated");
        return JSON.stringify({
          path,
          mediaType: image.mediaType,
          model: row.name,
        });
      },
    }),
  ];
}
