import { and, eq, gt } from "drizzle-orm";
import { single } from "../../db/helpers.js";
import type { Transaction } from "../../db/index.js";
import { webSessions } from "./schema.js";

// --- Interface ---

export interface WebSessionStore {
  /** Insert a session row. The caller hashes the raw token before calling. */
  create(
    tx: Transaction,
    params: { tokenHash: string; userId: string; expiresAt: Date },
  ): Promise<{ id: string }>;

  /** Look up an unexpired session by token hash. Returns undefined on miss/expiry. */
  findValidByTokenHash(
    tx: Transaction,
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string; userId: string; expiresAt: Date } | undefined>;

  /** Update last_used_at on a successful gate pass. */
  touch(tx: Transaction, id: string, now: Date): Promise<void>;

  /** Delete a session by token hash (logout). */
  deleteByTokenHash(tx: Transaction, tokenHash: string): Promise<void>;
}

// --- Implementation ---

export class DrizzleWebSessionStore implements WebSessionStore {
  async create(
    tx: Transaction,
    params: { tokenHash: string; userId: string; expiresAt: Date },
  ): Promise<{ id: string }> {
    return single(
      await tx
        .insert(webSessions)
        .values({
          tokenHash: params.tokenHash,
          userId: params.userId,
          expiresAt: params.expiresAt,
        })
        .returning({ id: webSessions.id }),
    );
  }

  async findValidByTokenHash(
    tx: Transaction,
    tokenHash: string,
    now: Date,
  ): Promise<{ id: string; userId: string; expiresAt: Date } | undefined> {
    const rows = await tx
      .select({
        id: webSessions.id,
        userId: webSessions.userId,
        expiresAt: webSessions.expiresAt,
      })
      .from(webSessions)
      .where(and(eq(webSessions.tokenHash, tokenHash), gt(webSessions.expiresAt, now)))
      .limit(1);
    return rows[0];
  }

  async touch(tx: Transaction, id: string, now: Date): Promise<void> {
    await tx.update(webSessions).set({ lastUsedAt: now }).where(eq(webSessions.id, id));
  }

  async deleteByTokenHash(tx: Transaction, tokenHash: string): Promise<void> {
    await tx.delete(webSessions).where(eq(webSessions.tokenHash, tokenHash));
  }
}
