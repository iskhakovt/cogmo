import type { GenerateImageResult } from "ai";
import { z } from "zod";

/**
 * Generated images whose byte length falls below this threshold are treated
 * as provider placeholders (solid-color / heavily-degraded fallbacks that
 * compress to a few hundred bytes). Real PNG/JPEG/WebP photos from a
 * diffusion model are 50KB+ even at modest resolution; a 2KB ceiling
 * comfortably catches the placeholder class without false-positiving on
 * legitimate small assets (transparent 1x1 stubs in tests are explicitly
 * excluded via the test fixture, which produces ~400B images — those
 * intentionally trip the canary so tests assert on the failure path).
 *
 * Starting point — tune from production data if false positives appear.
 */
export const SUSPICIOUS_SIZE_THRESHOLD_BYTES = 2048;

/**
 * Result of inspecting a `generateImage` response for known
 * placeholder/content-policy signals. `ok: false` carries an LLM-facing
 * `reason` string the tool surfaces verbatim as a text error so the
 * agent can react (rephrase, switch model) instead of silently uploading
 * a useless image.
 */
export type ImageFailureDetection = { ok: true } | { ok: false; reason: string };

/**
 * Discriminant matching `ImageProvider["kind"]` in `src/llm/image-providers.ts`
 * — `"fal"` reads fal's normalized NSFW slice from `providerMetadata.fal`,
 * `"oai"` has no provider-specific signal today (Venice's response-header
 * signals are handled by a sibling work; future PR unifies the two paths).
 * Both kinds still get the size-canary check.
 */
export type ImageProviderKind = "fal" | "oai" | "venice";

/**
 * Per-image NSFW flag the fal adapter normalizes from upstream `has_nsfw_concepts[i]`
 * / `nsfw_content_detected[i]` into `providerMetadata.fal.images[i].nsfw`.
 * Optional — fal returns it only when the model's safety checker runs.
 */
const FalImageMetaSchema = z
  .object({
    nsfw: z.boolean().optional(),
  })
  .passthrough();

/**
 * Slice of fal's `providerMetadata.fal` we care about. The SDK passes
 * unknown response fields through verbatim (`...responseMetaData`), so
 * `nsfw_concepts: string[]` may appear at the top level of the slice if
 * the upstream response carries it — `.passthrough()` keeps it
 * accessible without forcing every fixture to set it.
 *
 * `nsfw_concepts` is **response-level**, not per-image — fal returns a
 * single concept list for the whole batch with no per-image attribution.
 * When a multi-image response has only some images flagged, the reason
 * string still attaches the full concept list to the user-visible
 * message. Acceptable today (the LLM acts on the prompt, not on which
 * specific image tripped); revisit if fal exposes per-image concepts.
 */
const FalProviderMetaSchema = z
  .object({
    images: z.array(FalImageMetaSchema).optional(),
    nsfw_concepts: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Inspect a successful `generateImage` result for known failure signals.
 *
 * Checks run in order of specificity: provider-specific metadata first
 * (fal's per-image NSFW flag), then the cross-provider size canary. The
 * first failure short-circuits — a flagged-and-tiny image still reports
 * the NSFW reason because that's the more actionable hint for the LLM.
 *
 * No pixel decode. The cheap signals catch the placeholder class; an
 * image-processing dep is deferred until production traffic shows a
 * real case the signals miss.
 */
export function detectImageFailure(input: {
  /**
   * Only the byte length is consumed; widen the input type to anything
   * carrying a `Uint8Array` so non-AI-SDK adapters (e.g. venice's hand-
   * rolled output) can pass their bytes directly without a synthetic
   * `base64` field.
   */
  image: { uint8Array: Uint8Array };
  providerMetadata: GenerateImageResult["providerMetadata"] | undefined;
  providerKind: ImageProviderKind;
}): ImageFailureDetection {
  if (input.providerKind === "fal") {
    const parsed = FalProviderMetaSchema.safeParse(input.providerMetadata?.fal);
    if (parsed.success) {
      const flagged = parsed.data.images?.some((img) => img.nsfw === true) ?? false;
      if (flagged) {
        const concepts = parsed.data.nsfw_concepts ?? [];
        const conceptHint = concepts.length > 0 ? ` (concepts: ${concepts.join(", ")})` : "";
        return {
          ok: false,
          reason:
            `image was flagged as nsfw by fal${conceptHint}. ` +
            "The provider returned a placeholder instead of the requested image — " +
            "rephrase the prompt to rephrase the prompt, or pick a different model.",
        };
      }
    }
  }

  const byteLength = input.image.uint8Array.byteLength;
  if (byteLength < SUSPICIOUS_SIZE_THRESHOLD_BYTES) {
    return {
      ok: false,
      reason:
        `generated image is suspiciously small (${byteLength} bytes), likely a placeholder. ` +
        "The provider may have refused the prompt — try rephrasing or switching models.",
    };
  }

  return { ok: true };
}
