Append-only step 7: the summarization call and the degraded-reply synthesis send the `system` and `tools` the turn sends with `tool_choice: none`, so the thinking blocks they replay stay bound to the prefix they were produced under.

- `ChatParams.toolChoice` carries it. Anthropic sends `tool_choice: { type: "none" }` with the tools; the OpenAI-compatible adapter omits both.
- Summarization carries its own tool-result clearing, triggered at the summarization model's input budget, so a prefix that fits is summarized from the full tool results. `/compact` does the same, sends no tools and strips every thinking block.
- The degraded reply's instruction moves from the system prompt to a user message after the history.
- What the provider reports changing in a fork is counted in `cogmo.prompt.server_mismatches` under `site: "fork"`, or under `stage` for a pipeline stage's summarization.
