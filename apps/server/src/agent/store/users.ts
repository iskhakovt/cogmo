import { asc } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { users } from "./schema.js";

/** The `users` rows: identity only, which every per-user row hangs off. */
export interface UserStore {
  /** Create a new user. */
  createUser(tx: Transaction): Promise<{ id: string }>;

  /** The oldest user by `id` (UUIDv7): the one setup creates, which bootstrap and the CLI act as. */
  getFirstUser(tx: Transaction): Promise<{ id: string } | undefined>;
}

export class DrizzleUserStore implements UserStore {
  async createUser(tx: Transaction): Promise<{ id: string }> {
    return single(await tx.insert(users).values({}).returning({ id: users.id }));
  }

  async getFirstUser(tx: Transaction): Promise<{ id: string } | undefined> {
    const rows = await tx.select({ id: users.id }).from(users).orderBy(asc(users.id)).limit(1);
    return rows[0];
  }
}
