import type { createFal } from "@ai-sdk/fal";
import { APICallError, generateImage } from "ai";
import { z } from "zod";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import { defineTool, type ToolSpec } from "./tools.js";

/** fal provider factory — returned by `createFal({ apiKey })`. */
export type FalProvider = ReturnType<typeof createFal>;

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
 * Curated image-generation models.
 *
 * fal.ai hosts 1000+ models — exposing all of them would flood the LLM.
 * This shortlist covers the common tradeoffs (speed, quality, text rendering,
 * editing). Promote to DB when operator-level customization matters.
 */
export const MODEL_CATALOG = [
  "fal-ai/flux/schnell",
  "fal-ai/flux/dev",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "fal-ai/imagen4/preview",
  "fal-ai/recraft/v3/text-to-image",
  "fal-ai/ideogram/character",
  "fal-ai/qwen-image",
  "fal-ai/flux-pro/kontext",
] as const;

const TOOL_DESCRIPTION =
  "Generate an image from a text description. The image is returned to the user.\n\n" +
  "Choose the model based on the task:\n" +
  "- `fal-ai/flux/schnell` — fastest, cheapest, good for quick iteration or drafts\n" +
  "- `fal-ai/flux/dev` — balanced speed/quality, good default for general use\n" +
  "- `fal-ai/flux-pro/v1.1` — higher quality, detailed scenes and portraits\n" +
  "- `fal-ai/flux-pro/v1.1-ultra` — highest quality, longer wait, slower iteration\n" +
  "- `fal-ai/imagen4/preview` — Google Imagen 4: photorealism, accurate typography, strong prompt adherence\n" +
  "- `fal-ai/recraft/v3/text-to-image` — best for images with readable text, logos, vector/illustration styles, brand assets\n" +
  "- `fal-ai/ideogram/character` — best when the same character must appear consistently across multiple images; also strong at typography\n" +
  "- `fal-ai/qwen-image` — autoregressive model, strong at complex text rendering and detailed prompt adherence\n" +
  "- `fal-ai/flux-pro/kontext` — image editing (best when the user wants you to modify an existing image)\n\n" +
  "Write a detailed prompt — describe subject, style, composition, colors, and mood. " +
  "The prompt is the main lever for image quality.";

/**
 * Create image generation tools.
 *
 * Closure-injected — the fal provider factory and attachment store are
 * baked in at bootstrap. If `fal` is undefined (no API key configured),
 * the tool is still registered but the handler returns a helpful error.
 * Same graceful-degradation pattern as `createWebTools`.
 */
export function createImageTools(
  fal: FalProvider | undefined,
  attachments: AttachmentStore,
): ToolSpec[] {
  return [
    defineTool({
      name: "generate_image",
      description: TOOL_DESCRIPTION,
      // Durable: each call bills $0.02-$0.04 and uploads to AttachmentStore.
      // On Inngest retry the cached JSON result (path + mediaType) replays,
      // so we neither re-bill fal nor produce duplicate uploaded blobs.
      durable: true,
      schema: z.object({
        prompt: z.string().min(1).describe("Detailed image description"),
        model: z
          .enum(MODEL_CATALOG)
          .default("fal-ai/flux/dev")
          .describe("Model — choose based on task (see tool description)"),
        aspectRatio: z
          .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
          .optional()
          .describe("Aspect ratio. Default 1:1."),
        seed: z.number().int().optional().describe("Seed for reproducibility"),
      }),
      handler: async (input) => {
        if (!fal) return "Error: generate_image is not configured (FAL_API_KEY missing).";

        const { image } = await withRetry(
          async () => {
            try {
              return await generateImage({
                model: fal.image(input.model),
                prompt: input.prompt,
                ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
                ...(input.seed !== undefined && { seed: input.seed }),
              });
            } catch (err) {
              // Use the AI SDK's structured APICallError rather than
              // substring-matching the message — handles auth/validation/
              // content-policy failures deterministically. The SDK sets
              // `isRetryable: false` for 4xx except 429 (rate limit).
              if (APICallError.isInstance(err) && err.isRetryable === false) {
                throw new AbortError(err.message);
              }
              throw err;
            }
          },
          { retries: 2, context: "fal.generateImage" },
        );

        const buffer = Buffer.from(image.uint8Array);
        const path = await attachments.upload(buffer, image.mediaType, "generated");

        return JSON.stringify({
          path,
          mediaType: image.mediaType,
          model: input.model,
        });
      },
    }),
  ];
}
