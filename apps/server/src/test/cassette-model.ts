/**
 * The chat model the skill-authoring and e2e-smoke cassettes are keyed on.
 *
 * Scoped to those two suites, not the fixture directory at large:
 * `test/fixtures/recorded/` also holds cassettes keyed on
 * `claude-haiku-4-5` (the coding-CLI suites) and `claude-sonnet-4-6`, plus
 * ones carrying no `model` key that match whatever model asks.
 *
 * aimock's fixture match key is `{ userMessage, model, turnIndex,
 * hasToolResult }`, and the model is enforced whenever a fixture carries
 * one, so a cassette is bound to the id it was recorded with. A suite that
 * replays one pins the profile to this model rather than inheriting
 * whatever `seed.ts` ships as the default: a product decision about which
 * model a fresh install starts on would otherwise turn every recorded turn
 * into a strict-mode 503, surfacing as a `vi.waitFor` timeout with nothing
 * pointing at the cause.
 *
 * Changing this id means re-recording those suites (`pnpm test:record`) —
 * see `.claude/rules/testing.md` → Record/replay mocks.
 */
export const CASSETTE_CHAT_MODEL = "claude-sonnet-5";
