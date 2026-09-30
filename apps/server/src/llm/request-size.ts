/**
 * The largest request, in bytes, every route cogmo sends to accepts: the
 * smallest request-size cap among them. Anthropic's Messages and token-counting
 * endpoints take 32 MB and answer a larger request with a 413
 * `request_too_large`; Bedrock takes 20 MB and Google Cloud 30 MB, and an
 * OpenRouter route can land on either. Strategy 1 clears on the server, so a
 * request's raw bytes grow past what its token count shows, and compaction
 * holds them under this cap (design/context-management.md → Strategy 2).
 */
export const MAX_REQUEST_BYTES = 20_000_000;
