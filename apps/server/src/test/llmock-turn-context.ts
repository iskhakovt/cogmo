/**
 * Turn-context normalizer for the llmock matcher, kept under `src/` so it is
 * tsc-checked and unit-testable, and imported by `test/llmock-setup.ts`.
 *
 * A turn-starting user message leads with its turn context
 * (`src/agent/turn-context.ts`), and fixtures key on the last user message, so
 * the block is part of every chat cassette's key. Two of its parts can't be:
 *
 * - **The time line** changes every minute.
 * - **Recalled memories** depend on the bank's state when the turn ran. Integration
 *   files share Hindsight and the seeded user's bank, and retains land
 *   asynchronously, so the same turn can recall different memories — or none —
 *   depending on which files ran first and how far Hindsight has got. The
 *   element is dropped from the key; what the model was sent is asserted from
 *   the request itself where a test cares.
 *
 * The rest of the block — the reply modality — stays in the key.
 */
const TURN_CONTEXT_RE = /<turn_context>\n[\s\S]*?\n<\/turn_context>/g;

export function normalizeTurnContext(text: string): string {
  return text.replace(TURN_CONTEXT_RE, (block) =>
    block
      .replace(/<recalled_memories[^>]*>\n[\s\S]*?\n<\/recalled_memories>\n\n/, "")
      .replace(/^Current time: .*$/m, "Current time: [NOW]"),
  );
}
