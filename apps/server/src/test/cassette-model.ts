import { isNull } from "drizzle-orm";
import { profiles } from "../agent/store/schema.js";
import type { Transaction } from "../db/transactor.js";

/**
 * The chat model the recorded chat turns are keyed on: skill-authoring,
 * learning-loop, prompt-caching, both pipeline suites and the e2e smoke test.
 * `test/fixtures/recorded/` also holds cassettes keyed on `claude-haiku-4-5`
 * (the coding-CLI suites) and `claude-sonnet-4-6`, plus ones carrying no
 * `model` key that match whatever model asks.
 *
 * aimock's fixture match key is `{ userMessage, model, turnIndex,
 * hasToolResult }`, and the model is enforced whenever a fixture carries
 * one. A suite that replays one pins its profile to this model rather than
 * inheriting whatever `seed.ts` ships as the default: a product decision
 * about which model a fresh install starts on would otherwise turn every
 * recorded turn into a strict-mode 503, surfacing as a `vi.waitFor` timeout
 * with nothing pointing at the cause.
 *
 * Inheriting the default can also pass by accident. A fixture's `model`
 * also answers that id followed by `-<digit>…`, a rule meant for dated
 * snapshots, so a `claude-sonnet-5` cassette answers `claude-sonnet-5-5`
 * and replays another model's recording.
 *
 * Changing this id means re-recording those suites (`pnpm test:record`) —
 * see `.claude/rules/testing.md` → Record/replay mocks.
 */
export const CASSETTE_CHAT_MODEL = "claude-sonnet-5";

/**
 * Point the seeded org profile (`user_id IS NULL`), which `bootstrap()`
 * resolves as the default, at {@link CASSETTE_CHAT_MODEL}. A user-owned
 * profile a suite creates keeps the model it asked for. Throws unless exactly
 * one row changed: a pin that matches nothing would leave the suite on the
 * shipped default.
 */
export async function pinOrgProfileToCassetteModel(tx: Transaction): Promise<void> {
  const updated = await tx
    .update(profiles)
    .set({ model: CASSETTE_CHAT_MODEL })
    .where(isNull(profiles.userId))
    .returning({ id: profiles.id });
  if (updated.length !== 1) {
    throw new Error(`expected one seeded org profile to pin, updated ${updated.length}`);
  }
}
