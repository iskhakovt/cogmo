import type http from "node:http";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";

const FIXTURE_DIR = "./test/fixtures/recorded";

/**
 * Stub handler for Anthropic's /v1/messages/count_tokens endpoint.
 *
 * aimock doesn't support this endpoint natively. Without this stub,
 * the Anthropic SDK gets a 404 and the context management pipeline crashes.
 * Returns a rough token estimate based on JSON-stringified request body length.
 */
const countTokensHandler = {
  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _pathname: string,
  ): Promise<boolean> {
    if (req.method !== "POST") return false;

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bodyLength = Buffer.concat(chunks).length;

    // ~4 chars per token, rough estimate — good enough for test compaction decisions
    const inputTokens = Math.ceil(bodyLength / 4);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: inputTokens }));
    return true;
  },
};

/**
 * Strip timestamps, UUIDs, and other dynamic content from LLM prompts for
 * deterministic matching. With requestTransform set, llmock uses exact match
 * (===) instead of substring (includes).
 */
function normalizeContent(text: string): string {
  return (
    text
      // ISO 8601 timestamps → [TS]
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(\+[\d:]+|Z)/g, "[TS]")
      // UUIDs → [UUID]
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[UUID]")
      // Weekday + long-form dates ("Monday, January 1, 2026") → [DATE]
      .replace(
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+\s+\d{1,2},\s+\d{4}\b/g,
        "[DATE]",
      )
      // Test bank IDs (`test-1775815196908`) — Hindsight bakes the bank ID
      // into extraction prompts as the narrator name. Word boundary prevents
      // accidentally matching `test-` substrings inside other tokens.
      .replace(/\btest-\d{10,}\b/g, "test-[ID]")
  );
}

function requestTransform(req: ChatCompletionRequest): ChatCompletionRequest {
  return {
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content: typeof m.content === "string" ? normalizeContent(m.content) : m.content,
    })),
    embeddingInput: req.embeddingInput?.split(" | ")[0],
  };
}

/**
 * Create a configured LLMock instance.
 *
 * LLMOCK_RECORD=1: replay existing fixtures, proxy + save new ones.
 * Default (CI): strict mode — 503 on unmatched requests, no API calls.
 */
export function createMock(): LLMock {
  const recording = process.env.LLMOCK_RECORD === "1";

  const mock = new LLMock({
    port: 0,
    host: "0.0.0.0",
    logLevel: recording ? "info" : "silent",
    strict: !recording,
    requestTransform,
    ...(recording && {
      record: {
        providers: {
          openai: "https://api.openai.com",
          anthropic: "https://api.anthropic.com",
        },
        fixturePath: FIXTURE_DIR,
      },
    }),
  });

  mock.loadFixtureDir(FIXTURE_DIR);
  mock.mount("/v1/messages/count_tokens", countTokensHandler);

  return mock;
}
