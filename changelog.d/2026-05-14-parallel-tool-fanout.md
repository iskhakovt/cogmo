### Parallel tool fan-out

Tool execution in a single assistant turn now runs concurrent where safe. `ToolSpec` carries a new `parallelSafe: boolean` opt-in flag; the agent loop walks the LLM's tool_use emission order and folds each maximal run of parallelSafe entries into one `Promise.all`. Unsafe entries stay as singletons in their original position, so `[read_file, write_file, read_file]` still sequences correctly (and two adjacent unsafe entries don't accidentally race).

Audited and opted in: `get_current_time`, `core_memory_read`, `read_file`, `list_files`, `memory_recall`, `memory_reflect`, `send_document`, `generate_image`, `web_search`, `web_answer`, `fetch_url`. Left unsafe (write paths or shared mutable state): `core_memory_update`, `write_file`, `memory_retain`, `delegate_coding`, `register_skill`. Dynamically built skill invocation tools are not flagged — a manifest-level safety annotation will land separately.

Design notes in `design/agents.md` → Concurrent Tool Execution; tradeoff entry in `design/decisions.md`.
