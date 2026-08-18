import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database } from "../db/index.js";

/**
 * Create a `users` row owned by one test file.
 *
 * Integration files run in parallel forks against one Postgres, so any
 * state keyed on `inject("defaultUserId")` is shared with every other
 * file. A row-count assertion or a `DELETE ... WHERE user_id = $1`
 * cleanup written against that id reaches another file's rows, and the
 * result depends on interleaving: both pass alone, both pass as a pair,
 * and the failure needs the timing skew of the full tier.
 *
 * Reach for the seeded user only when a test is genuinely about it —
 * `pending_memories`, `custom_compartments` and friends only need *a*
 * user, and a private one keeps their assertions honest.
 *
 * The row is a real insert because those tables carry an FK to
 * `users.id`; a synthetic string fails the constraint. Nothing deletes
 * it — the containers are torn down per run.
 */
export async function createIsolatedUser(db: Database): Promise<string> {
  const store = new DrizzleAgentStore();
  const { id } = await db.transaction((tx) => store.createUser(tx));
  return id;
}
