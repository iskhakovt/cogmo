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
// Hindsight stamps each extracted fact with a "(happened in <Month> <Year>)"
// temporal suffix derived from the *current* date before embedding it, so a
// fixture recorded one month replay-mismatches the next (the month rolls over).
// Collapse the month/year to a stable token. Shared by normalizeContent (chat)
// and the embedding match path.
const HAPPENED_IN_RE =
  /\(happened in (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\)/g;

function normalizeHappenedIn(text: string): string {
  return text.replace(HAPPENED_IN_RE, "(happened in [WHEN])");
}

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
      // Claude Code's harness emits "Today's date is YYYY-MM-DD." as a
      // system-reminder. Strip the date so fixtures don't drift by day.
      .replace(/Today's date is \d{4}-\d{2}-\d{2}/g, "Today's date is [DATE]")
      // Test bank IDs (`test-1775815196908`, `test-compartments-1775...`) —
      // Hindsight bakes the bank ID into extraction prompts as the narrator
      // name. Optional `-<word>` segment lets per-suite banks include a
      // descriptive infix without breaking fixture matching across runs.
      // Word boundary prevents accidentally matching inside other tokens.
      .replace(/\btest-(?:[a-z]+-)?\d{10,}\b/g, "test-[ID]")
      // Claude Code's plan-mode system-reminder embeds a per-session
      // random slug (`.claude/plans/task-<title>-<adj>-<noun>.md`) into
      // every turn's user message — collapse to a stable token so
      // record/replay matching doesn't miss after the first turn.
      .replace(/\.claude\/plans\/task-[a-z0-9-]+\.md/g, ".claude/plans/task-[SLUG].md")
      // Month-rollover-safe temporal suffix (see HAPPENED_IN_RE).
      .replace(HAPPENED_IN_RE, "(happened in [WHEN])")
  );
}

function requestTransform(req: ChatCompletionRequest): ChatCompletionRequest {
  return {
    ...req,
    messages: req.messages.map((m) => ({
      ...m,
      content: typeof m.content === "string" ? normalizeContent(m.content) : m.content,
    })),
    embeddingInput: req.embeddingInput
      ? normalizeHappenedIn(req.embeddingInput.split(" | ")[0] ?? "")
      : undefined,
  };
}

/**
 * Create a configured LLMock instance.
 *
 * RECORD=1: replay existing fixtures, proxy + save new ones.
 * Default (CI): strict mode — 503 on unmatched requests, no API calls.
 */
export function createMock(): LLMock {
  const recording = process.env.RECORD === "1";

  const mock = new LLMock({
    port: 0,
    host: "0.0.0.0",
    logLevel: recording ? "info" : process.env.LLMOCK_DEBUG === "1" ? "debug" : "silent",
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
