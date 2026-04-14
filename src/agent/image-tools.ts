import type { createFal } from "@ai-sdk/fal";
import { generateImage } from "ai";
import { z } from "zod";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { AbortError, withRetry } from "../util/with-retry.js";
import { defineTool, type ToolSpec } from "./tools.js";

/** fal provider factory — returned by `createFal({ apiKey })`. */
export type FalProvider = ReturnType<typeof createFal>;

/**
 * Curated image-generation models.
 *
 * fal.ai hosts 1000+ models — exposing all of them would flood the LLM.
 * This shortlist covers the common tradeoffs (speed, quality, text rendering,
 * editing). Promote to DB when operator-level customization matters.
 */
export const MODEL_CATALOG = [
  "fal-ai/flux/dev",
  "fal-ai/flux/schnell",
  "fal-ai/flux-pro/v1.1",
  "fal-ai/flux-pro/v1.1-ultra",
  "fal-ai/flux-pro/kontext",
] as const;

const TOOL_DESCRIPTION =
  "Generate an image from a text description. The image is returned to the user.\n\n" +
  "Choose the model based on the task:\n" +
  "- `fal-ai/flux/schnell` — fastest, cheapest, good for quick iteration or drafts\n" +
  "- `fal-ai/flux/dev` — balanced speed/quality, good default for general use\n" +
  "- `fal-ai/flux-pro/v1.1` — higher quality, detailed scenes and portraits\n" +
  "- `fal-ai/flux-pro/v1.1-ultra` — highest quality, longer wait, slower iteration\n" +
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
              // fal returns 4xx for auth/validation/content-policy failures — don't retry.
              // The SDK surfaces these via its error types; conservatively classify by message.
              if (err instanceof Error) {
                const msg = err.message.toLowerCase();
                if (
                  msg.includes("401") ||
                  msg.includes("403") ||
                  msg.includes("422") ||
                  msg.includes("invalid") ||
                  msg.includes("unauthorized") ||
                  msg.includes("forbidden")
                ) {
                  throw new AbortError(err.message);
                }
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
