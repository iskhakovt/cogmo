/**
 * llmock key normalizer for the turn context (design/prompt-caching.md →
 * Fixtures): the time line becomes `[NOW]`, and the recalled memories,
 * core-memory updates and delivery channels are dropped, since they depend on
 * the shared Hindsight bank and on database state rather than on what the
 * user said. Under `src/` so it is tsc-checked; imported by
 * `test/llmock-setup.ts`.
 */
const TURN_CONTEXT_RE = /<turn_context>\n[\s\S]*?\n<\/turn_context>/g;

export function normalizeTurnContext(text: string): string {
  return text.replace(TURN_CONTEXT_RE, (block) =>
    block
      .replace(/<recalled_memories[^>]*>\n[\s\S]*?\n<\/recalled_memories>\n\n/, "")
      .replace(/<core_memory_updates>\n[\s\S]*?\n<\/core_memory_updates>\n\n/, "")
      .replace(/\nDelivery channels: .*$/m, "")
      .replace(/^Current time: .*$/m, "Current time: [NOW]"),
  );
}
