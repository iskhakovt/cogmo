Expected failures in `llm/`, `voice/` and `db/` are values, and two parsing bugs are fixed.

- **Results.** `parseProviderJson` and `parseToolArgs` return `Result<…, ProviderProtocolError>`; the Anthropic and OpenAI-compatible adapters branch on it and throw the same final errors as before, so the agent-resilience classification is unchanged. `chatTyped` validates with `safeParse`. `buildTts`/`buildStt` return a `Result` for an `openai_compatible` config without a base URL.
- **Venice.** The response body is parsed with Zod. A body whose `images` field was a string decoded the string's first character as the image; it now fails the call, naming the mismatch.
- **Driver results without casts.** `findPgErrorByCode` returns only the SQLSTATE and constraint fields; the migration runner's `readApplied` and the bundled LiteLLM snapshot parse through Zod schemas.
- **Kept as throws, by design:** provider protocol, refusal, cut-off and config errors, which drive retry classification; `boot/` checks; `memory/`.
