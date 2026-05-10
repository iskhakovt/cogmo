Fix a process-killing crash when an upstream LLM provider fails mid-stream.

**Root cause.** Every `chatStream()` adapter (`anthropic.ts`, `openai-compat.ts`, and the `FallbackLlmProvider` wrapper) returns `{ events, response }` and rejects `response` independently when the events stream throws. `runStreamingAgentLoop` only awaits `response` on the success path, after draining `events`. A `for await` throw skips that await, so the parallel rejection becomes an unhandled rejection — and Node ≥ 15 terminates the process by default. A single 5xx from upstream took the whole bot down.

**Fix.** `runStreamingAgentLoop` now attaches a noop `.catch()` to `response` synchronously after destructuring it from `chatStream()`. The success path's `await response` still surfaces the same error normally; the noop only suppresses Node's unhandled-rejection signal on the iterator-throw path.

**Coverage.**

- `runStreamingAgentLoop` regression test that builds a provider whose events generator throws AND whose `response` is a bare `Promise.reject(...)` — registers a `process.on("unhandledRejection")` listener and asserts it stays silent. The test fails without the fix (verified by reverting the one-line change locally).
- Two new `OpenAICompatibleProvider.chatStream` tests pinning both stream-failure shapes the OpenAI SDK surfaces: a pre-stream `APIError` with numeric `.status`, and a mid-stream `APIConnectionError` with no `.status`. Both shapes are what `isRetriableProviderError` keys off downstream of fallback.

**Related — Grok 4.3 wire-format coverage:**

- Add `x-ai/grok-4.3` to `MODEL_REGISTRY` (1M context, 32k output cap; xAI's "no output limit" still needs an SDK `max_tokens`).
- New integration test `src/test/xai-grok.integration.test.ts` exercises `OpenAICompatibleProvider` against the OpenRouter wire format end-to-end, both `chat()` and `chatStream()`, against a recorded fixture.
- Recording script `scripts/record-xai-fixture.ts` runs the same prompt through a standalone llmock instance proxying to `https://openrouter.ai/api`. Re-record with `OPENROUTER_API_KEY=sk-or-... pnpm tsx scripts/record-xai-fixture.ts`.

Why a separate llmock instance for recording: llmock's `RecordProviderKey` enum is closed (`openai`, `anthropic`, `gemini`, …) — xAI/OpenRouter aren't in it. The only way to proxy to OpenRouter is to repurpose the `openai` key. Doing that on the shared recording llmock would break Hindsight's `gpt-5-nano` calls (the model doesn't exist on OpenRouter under that name), so the script spins up its own mock with the redirected upstream and writes to the same content-keyed fixture dir.
