/**
 * The largest request, in bytes, every route cogmo sends to accepts: the
 * smallest request-size cap among them. Anthropic's Messages and token-counting
 * endpoints take 32 MB and answer a larger request with a 413
 * `request_too_large`; Bedrock takes 20 MB and Google Cloud 30 MB, and an
 * OpenRouter route can land on either. Compaction's size trigger holds a
 * view's raw bytes under 80% of it where it can remove them: not the last
 * exchange, which every cut keeps (design/context-management.md → Strategy 2).
 */
export const MAX_REQUEST_BYTES = 20_000_000;
