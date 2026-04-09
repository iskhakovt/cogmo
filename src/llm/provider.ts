import type { ChatParams, ChatStreamResult, CountTokensParams, LlmResponse } from "./types.js";

/**
 * Provider-agnostic LLM interface.
 *
 * Implement this for each provider (Anthropic, OpenAI, Grok/xAI).
 * Domain code depends only on this interface — never on provider SDKs directly.
 */
export interface LlmProvider {
  readonly name: string;
  chat(params: ChatParams): Promise<LlmResponse>;
  chatStream(params: ChatParams): ChatStreamResult;
  countTokens(params: CountTokensParams): Promise<number>;
}
