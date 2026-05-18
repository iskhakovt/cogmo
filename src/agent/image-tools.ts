import { APICallError, generateImage } from "ai";
import { z } from "zod";
import type { ImageModelWithProvider } from "../agent/store/index.js";
import type { ImageProvider } from "../llm/image-providers.js";
import { logger } from "../logger.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { withRetry } from "../util/with-retry.js";
import {
  detectImageFailure,
  type ImageFailure,
  ImageGenerationFailedError,
} from "./image-failure.js";
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
  /**
   * Model the LLM picked, in the canonical form stored as the row's `name`
   * (e.g. `fal-ai/flux-pro`) — **not** the slug we hand to the LLM (see
   * `imageModelSlug`). Informational — not used by delivery. Operators
   * reading logs / future analytics consumers want the canonical identifier.
   */
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
 * Slug derived from a model name for use in the LLM-facing tool schema.
 *
 * xAI's grok-* family compiles tool JSON Schema into a constrained-decoding
 * grammar server-side; the grammar compiler rejects any `enum` literal that
 * contains `/` (see https://github.com/vercel/ai/issues/8024 and
 * https://github.com/zed-industries/zed/issues/34185 for the broader cluster).
 * Stripping the provider prefix gives us a slash-free identifier that's
 * still unique within a typical catalog (and `createImageTools` verifies
 * uniqueness at registration so collisions surface at boot, not at the
 * user's first turn).
 */
export function imageModelSlug(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

/**
 * Build the LLM-facing tool description from the loaded model catalog.
 * Each user-selectable model contributes one line with its `description`
 * and the ratios it accepts (or "fixed size" when `capabilities.aspectRatios`
 * is absent/empty). Models that accept a reference image carry a
 * `[needs reference image]` / `[optional reference image]` hint so the LLM
 * knows when to populate `referenceImage`. Models that accept a negative
 * prompt carry a `[supports negativePrompt]` hint. The prose ending is
 * constant across deployments.
 */
function buildToolDescription(
  models: ReadonlyArray<ImageModelWithProvider>,
  anyImageInput: boolean,
  anyNegativePrompt: boolean,
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
    const negativePromptHint =
      m.capabilities.negativePrompt === true ? " [supports negativePrompt]" : "";
    return `- \`${imageModelSlug(m.name)}\` — ${m.description}${ratioHint}${imageInputHint}${negativePromptHint}`;
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
  const negativePromptNote = anyNegativePrompt
    ? [
        "",
        "For models marked `[supports negativePrompt]`, pass `negativePrompt` to " +
          "describe what you don't want in the image (e.g. \"low quality, blurry, " +
          'extra fingers"). Use sparingly — the positive prompt is the main lever.',
      ]
    : [];
  return [
    "Generate an image from a text description. The image is returned to the user.",
    "",
    "Choose the model based on the task:",
    ...lines,
    ...referenceImageNote,
    ...negativePromptNote,
    "",
    "Write a detailed prompt — describe subject, style, composition, colors, and mood. " +
      "The prompt is the main lever for image quality.",
  ].join("\n");
}

/**
 * Output shape both adapters produce — matches the AI SDK's `image` field
 * on `generateImage` so the upload path stays uniform. The venice adapter
 * conforms directly; the AI SDK path is unwrapped through `generateViaAiSdk`.
 */
interface ImageBytes {
  uint8Array: Uint8Array;
  mediaType: string;
}

/**
 * Carries the bytes plus the AI SDK's `providerMetadata` so the
 * moderation hook can read provider-specific failure signals (fal's
 * per-image NSFW flag). Venice signals censorship via response headers,
 * handled inside its adapter and surfaced as thrown errors — it returns
 * `providerMetadata: undefined` here.
 */
interface ImageGenerationResult {
  image: ImageBytes;
  providerMetadata: Awaited<ReturnType<typeof generateImage>>["providerMetadata"] | undefined;
}

/**
 * Run the AI-SDK-backed providers (fal, openai_compatible). Pulled out of
 * the handler body so the per-provider request assembly stays declarative
 * and the surrounding control flow reads as a switch over `provider.kind`.
 *
 * Negative-prompt forwarding is provider-shaped:
 * - `fal` accepts it via `providerOptions.fal.negative_prompt` (a
 *   provider-specific extension layered on top of the SDK's generic
 *   `providerOptions` knob).
 * - `oai` (`@ai-sdk/openai-compatible`) has no documented negative-prompt
 *   surface, so we drop the field here. The capability gate at the call
 *   site should keep us out of this branch in practice; this is the
 *   belt-and-braces backup.
 */
/**
 * Single-format point for both failure paths (adapter-thrown via
 * `ImageGenerationFailedError`, post-generation via `detectImageFailure`).
 * Logs the structured failure for operator filtering and returns the
 * LLM-facing `Error: …` string the tool result carries.
 */
function surfaceFailure(failure: ImageFailure, row: ImageModelWithProvider, slug: string): string {
  logger.warn(
    {
      kind: failure.kind,
      provider: failure.provider,
      rowName: row.name,
      providerId: row.providerId,
      slug,
      reason: failure.reason,
    },
    "image generation failed",
  );
  return `Error: ${failure.reason}`;
}

async function generateViaAiSdk(args: {
  provider: Extract<ImageProvider, { kind: "fal" | "oai" }>;
  row: ImageModelWithProvider;
  prompt: string;
  referenceImageBytes?: Buffer;
  aspectRatio?: string;
  seed?: number;
  negativePrompt?: string;
}): Promise<ImageGenerationResult> {
  // Returns both the bytes and providerMetadata so the moderation hook
  // upstream can read fal's per-image NSFW signal without re-routing
  // through a second call.
  const imageModel =
    args.provider.kind === "fal"
      ? args.provider.provider.image(args.row.modelString)
      : args.provider.provider.imageModel(args.row.modelString);

  // The AI SDK's `prompt` field accepts either `string` (text-only) or
  // `{ text, images }` (image input). The latter is a fal-provider
  // extension at runtime — the SDK's public type only declares `string`,
  // so we type the value precisely here and cast only at the
  // `generateImage` call site.
  type GeneratePromptArg = string | { text: string; images: Buffer[] };
  const promptArg: GeneratePromptArg = args.referenceImageBytes
    ? { text: args.prompt, images: [args.referenceImageBytes] }
    : args.prompt;

  try {
    const { image, providerMetadata } = await generateImage({
      model: imageModel,
      // `prompt` accepts the object shape at runtime for fal but the
      // public `generateImage` signature only declares `string`
      // (provider-specific extension surfaced via fal's `prompt.images`
      // — see vercel/ai #11573 thread on ai-sdk-providers/fal docs).
      prompt: promptArg as unknown as string,
      ...(args.aspectRatio !== undefined && {
        // AI SDK types aspectRatio as `${number}:${number}`. Our Zod
        // enum validated the value against the same shape; the cast
        // bridges the literal-template typing.
        aspectRatio: args.aspectRatio as `${number}:${number}`,
      }),
      ...(args.seed !== undefined && { seed: args.seed }),
      // negative_prompt routing differs by provider shape:
      //   - fal: passes through `providerOptions.fal.negative_prompt`
      //     which the @ai-sdk/fal adapter folds into the request body.
      //   - openai_compatible: same passthrough mechanism, keyed by the
      //     provider's `name` (the value used when `createOpenAICompatible({
      //     name, ... })` was constructed in `image-providers.ts`).
      //     Canonical OpenAI rejects with HTTP 400; servers that accept
      //     extra body fields (Together, Replicate's shim, custom)
      //     forward the value. The capability flag is the operator's
      //     declaration of "my chosen server takes this".
      //   - venice: forwarded via the native adapter, not the AI SDK
      //     `providerOptions` shape — handled in the venice branch.
      ...(args.provider.kind === "fal" &&
        args.negativePrompt !== undefined && {
          providerOptions: { fal: { negative_prompt: args.negativePrompt } },
        }),
      ...(args.provider.kind === "oai" &&
        args.negativePrompt !== undefined && {
          providerOptions: { [args.provider.row.name]: { negative_prompt: args.negativePrompt } },
        }),
    });
    return { image, providerMetadata };
  } catch (err) {
    // Structured 4xx classification. `isRetryable: false` on 4xx
    // (except 429) means re-trying burns budget without helping —
    // surface as `ImageGenerationFailedError` so `withRetry` stops
    // AND the tool handler gets a typed failure to format uniformly
    // with the venice / moderation paths. Moderation-shaped 4xx
    // bodies (gpt-image-1's `content_policy_violation`, OpenAI's
    // safety-system text) are tagged `kind: "moderation_blocked"`
    // so the LLM sees the same shape it would from venice or fal.
    if (APICallError.isInstance(err) && err.isRetryable === false) {
      const kind: ImageFailure["kind"] = looksLikeModerationBlock(err)
        ? "moderation_blocked"
        : "provider_error";
      throw new ImageGenerationFailedError({
        kind,
        provider: args.provider.kind,
        reason: err.message,
      });
    }
    throw err;
  }
}

/**
 * Heuristic match for "the provider rejected this prompt as unsafe."
 * OpenAI's gpt-image-* family returns HTTP 400 with the substring
 * `content_policy_violation` in the JSON body; older DALL·E returned
 * a `"safety system"` phrase. fal and Venice signal moderation through
 * other channels (fal's `providerMetadata`, Venice's response
 * headers), not via `APICallError`, so this check only matters on the
 * openai-compatible path — but the substring set is conservative
 * enough that it stays safe for any future provider that mirrors
 * OpenAI's body shape.
 */
function looksLikeModerationBlock(err: APICallError): boolean {
  const body = err.responseBody;
  if (typeof body !== "string") return false;
  return body.includes("content_policy_violation") || body.includes("safety system");
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
  /**
   * Override the post-generation moderation/failure detector. Defaults to
   * the real `detectImageFailure`. Tests that exercise the happy path with
   * tiny stub fixtures pass `() => ({ ok: true })` so the size canary
   * doesn't trip on bytes that would never appear in production.
   */
  detectImageFailure?: typeof detectImageFailure;
}): ToolSpec[] {
  if (deps.models.length === 0) return [];
  const moderate = deps.detectImageFailure ?? detectImageFailure;

  // Build a slash-free identifier per model for the LLM-facing enum (see
  // `imageModelSlug` for why). The map from slug back to the canonical row
  // is what the handler consults; row.name retains the original AI SDK
  // path for downstream calls. Single pass — collision check is a stateful
  // scan over previously-seen slugs, and the slug also feeds the enum
  // array.
  const modelBySlug = new Map<string, ImageModelWithProvider>();
  const modelSlugs: string[] = [];
  for (const m of deps.models) {
    const slug = imageModelSlug(m.name);
    const existing = modelBySlug.get(slug);
    if (existing) {
      throw new Error(
        `Image model name collision after slug normalisation: "${slug}" maps to ` +
          `both "${existing.name}" and "${m.name}". Disambiguate the names so ` +
          `each model has a unique last path segment.`,
      );
    }
    modelBySlug.set(slug, m);
    modelSlugs.push(slug);
  }

  // Union, not intersection — a fixed-size model would otherwise collapse
  // every other model's options. Per-model narrowing happens in the
  // handler so the LLM gets a contextual error when it picks an
  // unsupported ratio.
  const ratioUnion = new Set<string>();
  for (const m of deps.models) {
    for (const r of m.capabilities.aspectRatios ?? []) ratioUnion.add(r);
  }

  // Zod's `z.enum` requires a non-empty literal tuple; build it once.
  const modelEnum = z.enum(modelSlugs as [string, ...string[]]);
  const aspectRatioField =
    ratioUnion.size > 0
      ? z.enum([...ratioUnion] as [string, ...string[]]).optional()
      : z.never().optional();

  const anyImageInput = deps.models.some((m) => m.capabilities.imageInput !== undefined);
  const anyNegativePrompt = deps.models.some((m) => m.capabilities.negativePrompt === true);

  return [
    defineTool({
      name: "generate_image",
      description: buildToolDescription(deps.models, anyImageInput, anyNegativePrompt),
      // Durable: each call bills $0.02-$0.04 and uploads to AttachmentStore.
      // On Inngest retry the cached JSON result (path + mediaType) replays,
      // so we neither re-bill the provider nor produce duplicate uploads.
      durable: true,
      parallelSafe: true,
      schema: z.object({
        prompt: z.string().min(1).describe("Detailed image description"),
        model: modelEnum
          // biome-ignore lint/style/noNonNullAssertion: length>0 guarded above
          .default(modelSlugs[0]!)
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
        negativePrompt: z
          .string()
          .max(2000)
          .optional()
          .describe(
            "Free-form description of what to avoid in the image. Only forwarded " +
              "for models marked `[supports negativePrompt]`; silently dropped " +
              "for models that don't accept one.",
          ),
      }),
      handler: async (input) => {
        const row = modelBySlug.get(input.model);
        if (!row) return `Error: unknown model ${input.model}`;
        const provider = deps.providers.get(row.providerId);
        if (!provider) {
          // Should never happen — the bootstrap loop populates `providers`
          // from the same DB rows we used to build `models`. If it does,
          // something has gone badly wrong; surface to the LLM rather than
          // crashing the turn. Log the canonical row name (not the slug)
          // since this branch only fires on operator-facing misconfiguration.
          logger.error(
            { rowName: row.name, providerId: row.providerId, slug: input.model },
            "generate_image: model row references a provider not present in the image-providers map",
          );
          return `Error: model ${input.model} references unknown provider`;
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
          return `Error: model ${input.model} does not support aspect ratio ${input.aspectRatio}. ${hint}`;
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
            `Error: model ${input.model} is an image-editing model and requires ` +
            "`referenceImage` — pass the AttachmentStore path of the image you want to edit."
          );
        }
        if (input.referenceImage && imageInputCap === undefined) {
          return `Error: model ${input.model} does not accept a reference image. Drop \`referenceImage\` or pick a model marked \`[needs reference image]\` or \`[optional reference image]\`.`;
        }
        if (input.referenceImage && provider.kind !== "fal") {
          return `Error: reference images are only supported by fal providers (got ${provider.kind}). Pick a fal-backed model marked \`[needs reference image]\`.`;
        }
        let referenceImageBytes: Buffer | undefined;
        if (input.referenceImage) {
          try {
            referenceImageBytes = await deps.attachments.download(input.referenceImage);
          } catch (err) {
            return `Error: couldn't load referenceImage "${input.referenceImage}": ${(err as Error).message}`;
          }
        }

        const shouldForwardAspect =
          input.aspectRatio !== undefined && supportedRatios.includes(input.aspectRatio);
        const shouldForwardSeed = input.seed !== undefined && row.capabilities.seed === true;
        // Per-call negative prompt is gated by the model's declared
        // capability — capability-absent models would either silently
        // ignore it (fal) or strict-reject the call (Venice's OpenAI-compat
        // path). Dropping at the boundary keeps the LLM-visible contract
        // honest: ask for the field, it's forwarded; capability false,
        // it's a no-op.
        const shouldForwardNegativePrompt =
          input.negativePrompt !== undefined && row.capabilities.negativePrompt === true;

        const generateResult = await withRetry(
          async (): Promise<ImageGenerationResult> => {
            switch (provider.kind) {
              case "fal":
              case "oai":
                return generateViaAiSdk({
                  provider,
                  row,
                  prompt: input.prompt,
                  ...(referenceImageBytes !== undefined && { referenceImageBytes }),
                  ...(shouldForwardAspect &&
                    input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
                  ...(shouldForwardSeed && input.seed !== undefined && { seed: input.seed }),
                  ...(shouldForwardNegativePrompt &&
                    input.negativePrompt !== undefined && {
                      negativePrompt: input.negativePrompt,
                    }),
                });
              case "venice": {
                const bytes = await provider.provider.generate({
                  model: row.modelString,
                  prompt: input.prompt,
                  ...(shouldForwardAspect &&
                    input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
                  ...(shouldForwardSeed && input.seed !== undefined && { seed: input.seed }),
                  ...(shouldForwardNegativePrompt &&
                    input.negativePrompt !== undefined && {
                      negativePrompt: input.negativePrompt,
                    }),
                });
                // Venice doesn't expose a providerMetadata surface — its
                // censorship signals are response headers handled inside
                // the adapter (throws `ImageGenerationFailedError`). The
                // size canary in `detectImageFailure` still applies.
                return { image: bytes, providerMetadata: undefined };
              }
            }
          },
          { retries: 2, context: `image.generate.${row.name}` },
        ).catch((err: unknown): { failure: ImageFailure } => {
          // Adapter-thrown failures (Venice headers, openai-compat
          // moderation 4xx) come in as `ImageGenerationFailedError`.
          // Re-surface as a "failure" Result so the post-generation
          // path below is the single place that formats LLM-facing
          // errors and logs them.
          if (err instanceof ImageGenerationFailedError) {
            return { failure: err.failure };
          }
          throw err;
        });

        if ("failure" in generateResult) {
          return surfaceFailure(generateResult.failure, row, input.model);
        }
        const { image, providerMetadata } = generateResult;

        const detection = moderate({
          image,
          providerMetadata,
          providerKind: provider.kind,
        });
        if (!detection.ok) {
          return surfaceFailure(detection.failure, row, input.model);
        }

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
