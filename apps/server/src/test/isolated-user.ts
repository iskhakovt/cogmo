import { DrizzleAgentStore } from "../agent/store/index.js";
import type { Database } from "../db/index.js";

/**
 * Create a `users` row private to the caller.
 *
 * Each integration file has its own database, but inside it the seeded user
 * (`fileDefaultUserId()`) is the owner `bootstrap()` resolves, so inbound
 * turns and the file's other tests attach rows, and Hindsight memories (the
 * bank id is the user id), to it. A row-count assertion or a
 * `DELETE ... WHERE user_id = $1` cleanup stays exact on a user of its own.
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
