import { existsSync, readdirSync } from "node:fs";
import type http from "node:http";
import { basename, join } from "node:path";
import { type ChatCompletionRequest, LLMock } from "@copilotkit/aimock";
import { HAPPENED_IN_RE, normalizeHappenedIn } from "../src/test/llmock-happened-in.js";
import { type CassetteFixture, describeMiss } from "../src/test/llmock-miss.js";
import { normalizeTurnContext } from "../src/test/llmock-turn-context.js";

/**
 * Recorded fixtures, one directory (cassette) per consumer:
 * - `suites/<file>/` — one integration test file's own calls, `<file>` being
 *   its name without `.integration.test.ts`. Served by that file's llmock.
 * - `hindsight/` — the shared Hindsight container's embedding and extraction
 *   calls. Served by `globalSetup`'s llmock, the only one a container reaches.
 * - `e2e/` — the e2e stack, app and Hindsight alike.
 */
const FIXTURE_ROOT = "./test/fixtures/recorded";
export const HINDSIGHT_CASSETTE = join(FIXTURE_ROOT, "hindsight");
export const E2E_CASSETTE = join(FIXTURE_ROOT, "e2e");
const SUITES_DIR = join(FIXTURE_ROOT, "suites");
const INTEGRATION_SUFFIX = ".integration.test.ts";

export function suiteCassette(testFile: string): string {
  return join(SUITES_DIR, basename(testFile, INTEGRATION_SUFFIX));
}

/**
 * Throws when two integration files would share a cassette, or a cassette has
 * no file left to consume it (a renamed or deleted suite).
 */
export function checkSuiteCassettes(testFiles: ReadonlyArray<string>): void {
  const names = testFiles.map((f) => basename(f, INTEGRATION_SUFFIX));
  const clash = names.find((n, i) => names.indexOf(n) !== i);
  if (clash !== undefined) {
    throw new Error(`two integration test files are named ${clash}; their cassettes would collide`);
  }
  const orphans = existsSync(SUITES_DIR)
    ? readdirSync(SUITES_DIR).filter((dir) => !names.includes(dir))
    : [];
  if (orphans.length > 0) {
    throw new Error(
      `cassettes with no integration test file: ${orphans.join(", ")} in ${SUITES_DIR}`,
    );
  }
}

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

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Strip timestamps, UUIDs, and other dynamic content from LLM prompts for
 * deterministic matching. With requestTransform set, llmock uses exact match
 * (===) instead of substring (includes).
 */
function normalizeContent(text: string): string {
  return (
    // The turn context's time line and recalled memories (see its module).
    normalizeTurnContext(text)
      // ISO 8601 timestamps → [TS]
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(\+[\d:]+|Z)/g, "[TS]")
      // UUIDs → [UUID]
      .replace(UUID_RE, "[UUID]")
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

/**
 * Structured-output calls that send the same user message under different
 * system prompts: the Observer's correction and memory extraction both send
 * the transcript. A fixture key carries no system prompt, so the key gets the
 * call's name, which the Anthropic adapter sends as the one tool it forces;
 * without it, one phase would replay the other's reply.
 */
const SHARED_INPUT_STRUCTURED_OUTPUTS = new Set(["correction-extraction", "memory-extraction"]);

function structuredOutputName(req: ChatCompletionRequest): string | undefined {
  const [tool, ...others] = req.tools ?? [];
  if (tool === undefined || others.length > 0) return undefined;
  return SHARED_INPUT_STRUCTURED_OUTPUTS.has(tool.function.name) ? tool.function.name : undefined;
}

function requestTransform(req: ChatCompletionRequest): ChatCompletionRequest {
  const name = structuredOutputName(req);
  const lastUser = req.messages.findLastIndex((m) => m.role === "user");
  return {
    ...req,
    messages: req.messages.map((m, i) => {
      // The OpenAI-compatible adapter sends an image turn as content parts,
      // its turn context among the text ones.
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map((part) =>
            part.type === "text" ? { ...part, text: normalizeContent(part.text) } : part,
          ),
        };
      }
      if (typeof m.content !== "string") return m;
      const content = normalizeContent(m.content);
      return {
        ...m,
        content: name !== undefined && i === lastUser ? `[${name}] ${content}` : content,
      };
    }),
    // Hindsight embeds a fact as `what | When: … | Involving: … | why`; keying
    // on the text before the first " | " keeps the key to the fact itself.
    // aimock joins a request's texts with a space, so a multi-text request
    // keys on everything up to the first fact's " | ". An image turn's recall
    // query is its inbound blocks as JSON, attachment paths (UUIDs) included.
    embeddingInput: normalizeHappenedIn(req.embeddingInput?.split(" | ")[0])?.replace(
      UUID_RE,
      "[UUID]",
    ),
  };
}

export interface CassetteMock {
  readonly mock: LLMock;
  /** Cassette files no request has matched yet. */
  unusedFiles(): string[];
}

function loadCassette(mock: LLMock, dir: string): CassetteFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .flatMap((file) => {
      const before = mock.getFixtures().length;
      mock.loadFixtureFile(join(dir, file));
      return mock
        .getFixtures()
        .slice(before)
        .map((fixture) => ({ fixture, file }));
    });
}

/**
 * An llmock serving one cassette directory.
 *
 * RECORD=1: replay the cassette, proxy misses upstream and save them into it.
 * Otherwise strict: a miss is answered 503 with `describeMiss`'s account of
 * it, which is also handed to `onMiss`. The miss handler is a last fixture
 * whose `turnIndex` is out of reach, so aimock's selection prefers any real
 * candidate over it.
 */
export function createMock(
  cassette: string,
  onMiss: ((description: string) => void) | undefined,
): CassetteMock {
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
        fixturePath: cassette,
      },
    }),
  });

  const fixtures = loadCassette(mock, cassette);
  if (!recording) {
    mock.addFixture({
      match: { predicate: () => true, turnIndex: Number.MAX_SAFE_INTEGER },
      response: (req) => {
        const description = describeMiss(requestTransform(req), fixtures);
        onMiss?.(description);
        return {
          error: { message: `llmock (${cassette}): ${description}`, type: "invalid_request_error" },
          status: 503,
        };
      },
    });
  }
  mock.mount("/v1/messages/count_tokens", countTokensHandler);

  return {
    mock,
    unusedFiles: () => {
      const counts = mock.journal.fixtureMatchCounts;
      return [
        ...new Set(fixtures.filter((f) => (counts.get(f.fixture) ?? 0) === 0).map((f) => f.file)),
      ];
    },
  };
}
