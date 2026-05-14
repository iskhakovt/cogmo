### Parallel tool fan-out

When the LLM emits multiple `tool_use` blocks in one assistant turn, the agent loop now runs them concurrently via `Promise.all` — provided every tool in the batch declares `parallelSafe: true`. Previously every batch executed sequentially, so a turn like "generate five image candidates and pick the best" paid the latency of five back-to-back fal.ai round-trips.

`ToolSpec.parallelSafe` is opt-in and defaults to off. The flag declares that a handler has no externally observable ordering dependency on its sibling tool calls — independent provider calls, read-only HTTP, pure compute. Writes against shared state (core memory blocks, the same file path) stay sequential by default. A single unsafe entry forces the whole batch back to the serial path; partial parallelism would create real concurrency between unsafe writes and sibling reads, and that's the kind of race we'd rather not invent.

Opted in this pass: `generate_image`, `web_search`, `web_answer`, `fetch_url`. Memory, file, and core-memory tools are left alone pending a dedicated audit of their write paths.
