/**
 * Retry-boundary contract for `generate_image`, against the real
 * `withRetry`.
 *
 * `image-tools.test.ts` swaps `withRetry` for a passthrough so it can
 * assert error classification without paying backoff, which leaves the
 * p-retry boundary itself unpinned. Two properties live only here: a
 * terminal `ImageGenerationFailedError` costs exactly one paid generation
 * and still reaches the LLM as a structured failure, while a
 * transport-shaped error spends the full budget.
 *
 * The structured half is the sharp edge. `ImageGenerationFailedError`
 * extends p-retry's `AbortError`, and p-retry answers a thrown
 * `AbortError` by rethrowing its `originalError` — a plain `Error` with no
 * `failure` field. So the handler has to end the loop by *returning* the
 * failure; a rethrow would reach the LLM as an exception instead of a
 * formatted tool result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { ImageModelWithProvider } from "../agent/store/index.js";
import { ImageGenerationFailedError } from "../llm/image-failure.js";
import type { ImageProvider } from "../llm/image-providers.js";
import type { VeniceImageProvider } from "../llm/venice.js";
import { logger } from "../logger.js";
import type { AttachmentStore } from "../transport/attachment-store.js";
import { createImageTools } from "./image-tools.js";
import type { Service } from "./service.js";

const PROVIDER_ID = "provider-venice";

/** Image tools never read from `service` — deps are closure-injected. */
const FAKE_SERVICE = {} as Service;

/**
 * Venice is the cheapest provider to drive here: its adapter is a plain
 * injected object, so a rejection needs no `ai`-module mock and reaches
 * the retry boundary through exactly the same code path fal and
 * openai-compatible take.
 */
function buildTool(rejection: unknown): {
  generateFn: ReturnType<typeof vi.fn>;
  handler: (input: Record<string, unknown>) => Promise<string>;
} {
  const veniceMock = mock<VeniceImageProvider>();
  veniceMock.generate.mockRejectedValue(rejection);
  const provider: ImageProvider = {
    kind: "venice",
    row: {
      id: PROVIDER_ID,
      name: "venice",
      type: "venice",
      baseUrl: "https://api.venice.ai/api/v1",
      secretId: "sec-1",
      attrs: {},
    },
    provider: veniceMock,
  };
  const model: ImageModelWithProvider = {
    id: "model-1",
    providerId: PROVIDER_ID,
    name: "venice/sd35",
    modelString: "venice-sd35",
    description: "venice test model",
    capabilities: {},
    userSelectable: true,
    provider: provider.row,
  };
  const attachments = mock<AttachmentStore>();
  const [tool] = createImageTools({
    models: [model],
    providers: new Map([[PROVIDER_ID, provider]]),
    attachments,
  });
  if (!tool) throw new Error("expected createImageTools to register generate_image");
  return { generateFn: veniceMock.generate, handler: (input) => tool.handler(input, FAKE_SERVICE) };
}

describe("generate_image retry boundary", () => {
  beforeEach(() => {
    // p-retry logs a warn per failed attempt via withRetry's
    // onFailedAttempt, and surfaceFailure logs one more. Silenced so the
    // suite output stays readable; the log contract itself is asserted in
    // image-tools.test.ts.
    vi.spyOn(logger, "warn").mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("charges one generation for a terminal failure and returns it as a tool result", async () => {
    const { generateFn, handler } = buildTool(
      new ImageGenerationFailedError({
        kind: "moderation_blocked",
        provider: "venice",
        reason: "Venice rejected the prompt as a content policy violation.",
      }),
    );

    const result = await handler({ prompt: "x", model: "sd35" });

    // The `failure.reason` survived the retry wrapper — proof the handler
    // never handed the AbortError to p-retry, which would have replaced it
    // with a plain Error and left the LLM with a thrown exception.
    expect(result).toBe("Error: Venice rejected the prompt as a content policy violation.");
    expect(generateFn).toHaveBeenCalledTimes(1);
  });

  it("spends the full budget on a transport-shaped failure", async () => {
    vi.useFakeTimers();
    const { generateFn, handler } = buildTool(new Error("socket hang up"));

    // Assert before advancing the clock: the rejection handler has to be
    // attached synchronously, or the backoff window between attempts
    // registers as an unhandled rejection. Nothing classified this error,
    // so it propagates unchanged — the agent loop's error path owns an
    // unrecognised transport failure, not the tool.
    const rejection = expect(handler({ prompt: "x", model: "sd35" })).rejects.toThrow(
      "socket hang up",
    );
    // Past the whole backoff budget (retries: 2, max 10s apart) in one go.
    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;

    expect(generateFn).toHaveBeenCalledTimes(3);
  });
});
