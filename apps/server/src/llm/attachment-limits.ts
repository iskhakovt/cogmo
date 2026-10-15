/**
 * What one request may carry in attachments on a route
 * (design/prompt-caching.md → Sources and fixes → source (d) → Budget). Every
 * stored image is normalized to fit each route's per-image limits, so only the
 * request-level ones remain: its bytes and its image count.
 */
export interface AttachmentLimits {
  /** The request's size cap, in bytes. */
  requestBytes: number;
  /** The most images one request may carry, resent ones included. */
  images: number;
}

/** What a request keeps for everything but attachments: system, tools and text. */
const TEXT_RESERVE_BYTES = 8_000_000;

/** What a view's attachments may weigh as base64, and how many images it may show. */
export interface AttachmentBudget {
  bytes: number;
  images: number;
}

export function attachmentBudget(limits: AttachmentLimits): AttachmentBudget {
  return { bytes: Math.max(0, limits.requestBytes - TEXT_RESERVE_BYTES), images: limits.images };
}

/** The limits every one of `candidates` accepts. */
export function strictestLimits(
  candidates: readonly [AttachmentLimits, ...AttachmentLimits[]],
): AttachmentLimits {
  return {
    requestBytes: Math.min(...candidates.map((l) => l.requestBytes)),
    images: Math.min(...candidates.map((l) => l.images)),
  };
}

/**
 * Anthropic's Messages API: 32 MB a request, and 100 images where the window
 * is under 1M tokens, 600 from it.
 */
export function anthropicAttachmentLimits(contextWindow: number): AttachmentLimits {
  return { requestBytes: 32_000_000, images: contextWindow >= 1_000_000 ? 600 : 100 };
}

/**
 * OpenAI-compatible routes: 20 MB and 100 images, since OpenRouter can route
 * to Bedrock and Gemini, which cap a request at 20 MB.
 */
export function openAICompatibleAttachmentLimits(): AttachmentLimits {
  return { requestBytes: 20_000_000, images: 100 };
}

/** The largest budget any route allows: what the renderer's memo holds at most. */
export const LARGEST_ATTACHMENT_BUDGET_BYTES = attachmentBudget(
  anthropicAttachmentLimits(1_000_000),
).bytes;
