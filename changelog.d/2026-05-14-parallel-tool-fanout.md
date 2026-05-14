### Parallel tool fan-out

Tool execution in a single assistant turn now runs concurrent where safe. `ToolSpec` carries a new `parallelSafe: boolean` opt-in flag; the agent loop walks the LLM's tool_use emission order and folds each maximal run of parallelSafe entries into one `Promise.all`. Unsafe entries stay as singletons in their original position, so `[read_file, write_file, read_file]` still sequences correctly (and two adjacent unsafe entries don't accidentally race).

Audited and opted in: `get_current_time`, `core_memory_read`, `read_file`, `list_files`, `memory_recall`, `memory_reflect`, `send_document`, `generate_image`, `web_search`, `web_answer`, `fetch_url`. Left unsafe (write paths or shared mutable state): `core_memory_update`, `write_file`, `memory_retain`, `delegate_coding`, `register_skill`. Dynamically built skill invocation tools are not flagged — a manifest-level safety annotation will land separately.

Cross-cutting invariants the audit verified rather than introduced:

- `AttachmentStore.upload` assigns a fresh `randomUUID()` path per call (`src/transport/attachment-store.ts:42`), so concurrent `generate_image` / `send_document` uploads cannot collide on a key.
- `tracer.startActiveSpan` inside `runOne` is safe under `Promise.all` because the OTel SDK is initialized via `@opentelemetry/sdk-node` (`src/otel.ts:39`), which installs an async-aware `AsyncLocalStorageContextManager` — each concurrent handler keeps its own parent-span context.
- Durable parallelSafe tools (`memory_reflect`, `generate_image`, `send_document`, `web_answer`) now fan out as `Promise.all` of `step.run` calls. Inngest's `optimizeParallelism` (default `true`, see `inngest/types.d.ts:821`) is built for this pattern; step ids are `tool-${name}-${tool_use.id}`, unique per LLM call, so no step-id collisions.
- `memory_reflect` is read-only at the server boundary (`design/memory.md:189`: "`reflect()` is **not** consolidation. It reads from the consolidation layer but doesn't write to it") — concurrent reflects against overlapping queries don't enrich the entity graph or mutate usage counters as side effects.

Design notes in `design/agents.md` → Concurrent Tool Execution; tradeoff entry in `design/decisions.md`.
