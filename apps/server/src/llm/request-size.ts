/**
 * The largest request, in bytes, every route cogmo sends to accepts: the
 * smallest request-size cap among them. Anthropic's Messages and token-counting
 * endpoints take 32 MB and answer a larger request with a 413
 * `request_too_large`; Bedrock takes 20 MB and Google Cloud 30 MB, and an
 * OpenRouter route can land on either.
 */
export const MAX_REQUEST_BYTES = 20_000_000;

/**
 * What an adapter's wire format adds to the canonical JSON compaction weighs,
 * with room to spare: Anthropic's adds about 20 bytes a document block and
 * about 1 KB of top-level fields.
 */
const WIRE_OVERHEAD_BYTES = 64 * 1024;

/**
 * The most a view's canonical JSON may weigh for its request to fit
 * {@link MAX_REQUEST_BYTES}. Compaction's size trigger cuts a view to 80% of
 * it where truncation can, and to it where only that fits
 * (design/context-management.md → Strategy 2 → Size trigger).
 */
export const MAX_VIEW_BYTES = MAX_REQUEST_BYTES - WIRE_OVERHEAD_BYTES;
