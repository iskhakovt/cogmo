/**
 * The chat model the recorded llmock cassettes are keyed on.
 *
 * aimock's fixture match key is `{ userMessage, model, turnIndex,
 * hasToolResult }` — the model id is part of it, so a cassette is bound to
 * the id it was recorded with. A suite that replays one must pin the
 * profile to this model rather than inherit whatever `seed.ts` ships as
 * the default: a product decision about which model a fresh install
 * starts on would otherwise turn every recorded turn into a strict-mode
 * 503, surfacing as a `vi.waitFor` timeout with nothing pointing at the
 * cause.
 *
 * Changing this id means re-recording (`pnpm test:record`) — see
 * `.claude/rules/testing.md` → Record/replay mocks.
 */
export const CASSETTE_CHAT_MODEL = "claude-sonnet-5";
