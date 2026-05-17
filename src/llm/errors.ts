/**
 * Errors raised by the LLM provider layer that don't map onto an upstream
 * HTTP failure shape.
 *
 * SDK / HTTP failures keep their native shape ({@link Error} subclass with a
 * numeric `status`) — {@link FallbackLlmProvider} duck-types on `status` to
 * classify them. The errors here cover cases where the upstream response
 * arrived structurally intact but its payload is unusable downstream:
 * truncated tool-arg JSON, malformed streamed deltas, etc.
 */

/**
 * The provider returned a syntactically intact response but its content
 * violates the wire contract — typically a tool-arg JSON stream that fails
 * to parse even after `jsonrepair`. Carries no `status` field so it does
 * not collide with the SDK's transient-error duck-type.
 *
 * Treated as **non-retriable** by {@link isRetriableProviderError}: trying
 * the next provider is unlikely to help (the model produced garbage; same
 * input to a different provider has no reason to do better) and we want the
 * error to propagate to the in-loop classifier so it can decide whether to
 * attempt repair or degrade.
 */
export class ProviderProtocolError extends Error {
  /** Original error from the underlying parse attempt, for diagnostics. */
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ProviderProtocolError";
    this.cause = cause;
  }
}
