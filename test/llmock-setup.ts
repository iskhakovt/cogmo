import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";

const FIXTURE_DIR = "./test/fixtures/recorded";

/**
 * Strip timestamps, UUIDs, and date strings from LLM prompts for deterministic matching.
 * With requestTransform set, llmock uses exact match (===) instead of substring (includes).
 */
function requestTransform(req: ChatCompletionRequest): ChatCompletionRequest {
  return {
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? m.content
              .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(\+[\d:]+|Z)/g, "")
              .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
              .replace(
                /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+\w+\s+\d{1,2},\s+\d{4}\b/g,
                "",
              )
          : m.content,
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

  return mock;
}
