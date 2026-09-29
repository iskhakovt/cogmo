import type {
  ChatOptions,
  ChatParams,
  ChatStreamFrame,
  CountTokensParams,
  LlmResponse,
} from "./types.js";

/**
 * Provider-agnostic LLM interface.
 *
 * Implement this for each provider (Anthropic, OpenAI, Grok/xAI).
 * Domain code depends only on this interface — never on provider SDKs directly.
 */
export interface LlmProvider {
  readonly name: string;
  chat(params: ChatParams, options?: ChatOptions): Promise<LlmResponse>;
  /**
   * Stream one response as {@link ChatStreamFrame}s, ending in a `done`
   * frame. A consumer that stops early (`break`, a throw in its loop body)
   * returns the iterator, which aborts the request.
   */
  chatStream(params: ChatParams, options?: ChatOptions): AsyncIterable<ChatStreamFrame>;
  countTokens(params: CountTokensParams): Promise<number>;
}
