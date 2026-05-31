/**
 * Phase 0 placeholder: proves the SPA package resolves `@cogmo/contracts`
 * types (the wiring the real Vite app depends on). The actual UI lands in
 * Phase 1; this file is replaced then.
 */
import type { StreamEvent } from "@cogmo/contracts";

/** Trivial use of a contract type so the import isn't elided. */
export function streamEventKind(event: StreamEvent): StreamEvent["type"] {
  return event.type;
}
