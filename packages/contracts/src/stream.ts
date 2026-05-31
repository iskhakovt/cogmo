/**
 * Canonical agent-loop stream events, mirrored from the backend
 * `src/llm/types.ts`. The web chat reader consumes these verbatim over SSE;
 * parity with the backend definition is enforced by the compile-time guard in
 * `apps/server/src/test/contracts-parity.ts`.
 */
export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string; signature: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: string; isError?: boolean }
  | { type: "status"; message: string };
