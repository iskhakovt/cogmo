import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { expectDefined } from "../test/assertions.js";
import type { Database, Transaction } from "./transactor.js";
import { transactor } from "./transactor.js";

/**
 * The driver error postgres-js raises: SQLSTATE on a top-level `code`.
 * Reaches the transactor unwrapped only for the statements the driver issues
 * itself (`begin`, `commit`, `rollback`) — everything Drizzle sends is wrapped.
 */
class PostgresError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PostgresError";
  }
}

/**
 * Stand-in for drizzle-orm's `DrizzleQueryError`, which wraps every statement
 * error the ORM sends. It sets `query` / `params` / `cause` and no `code`, so
 * the SQLSTATE of a REPEATABLE READ snapshot conflict is only ever reachable
 * through `cause` — this is the shape the retry predicate has to handle.
 */
class DrizzleQueryErrorLike extends Error {
  readonly query = "update conversations set status = $1 where id = $2";
  readonly params: unknown[] = ["archived", "0198..."];
  constructor(cause: Error) {
    super(`Failed query: ${cause.message}`, { cause });
    this.name = "DrizzleQueryError";
  }
}

/** A snapshot conflict as it actually arrives: 40001 buried under Drizzle's wrapper. */
function serializationFailure(message = "could not serialize access"): DrizzleQueryErrorLike {
  return new DrizzleQueryErrorLike(new PostgresError("40001", message));
}

/**
 * Build a mock `Database` whose `transaction(cb)` records the
 * isolation level it was called with and runs each callback against
 * the next attempt-impl from `attemptImpls`. The transactor is the
 * unit under test, not Drizzle's driver, so we mock at the
 * `Database` boundary instead of going through PGlite.
 */
function mockDb(attemptImpls: Array<(tx: Transaction) => Promise<unknown>>): {
  db: Database;
  calls: { isolationLevel: string | undefined }[];
} {
  const db = mock<Database>();
  const tx = mock<Transaction>();
  const calls: { isolationLevel: string | undefined }[] = [];
  const queue = [...attemptImpls];
  db.transaction.mockImplementation(
    // The Drizzle overload makes this signature load-bearing for inference,
    // but at runtime we only care about (cb, opts).
    async (
      cb: (tx: Transaction) => Promise<unknown>,
      opts?: { isolationLevel?: string },
    ): Promise<unknown> => {
      calls.push({ isolationLevel: opts?.isolationLevel });
      const impl = queue.shift() ?? ((t) => cb(t));
      return impl(tx);
    },
  );
  return { db, calls };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("transactor", () => {
  it("wraps each call with isolationLevel: repeatable read", async () => {
    const { db, calls } = mockDb([async () => "ok"]);
    const tx = transactor(db);
    await tx(async () => "ok");
    expect(calls).toEqual([{ isolationLevel: "repeatable read" }]);
  });

  it("retries a Drizzle-wrapped 40001 and succeeds on the second attempt", async () => {
    // The whole point of the retry layer: a transient snapshot conflict
    // resolves cleanly on a fresh attempt. The SQLSTATE lives on `cause`,
    // never on the thrown error — reading `err.code` would never retry.
    vi.stubEnv("RETRY_DISABLED", "false");
    const { db, calls } = mockDb([
      async () => {
        throw serializationFailure();
      },
      async () => "ok-on-retry",
    ]);
    const tx = transactor(db);
    const result = await tx(async () => "unused");
    expect(result).toBe("ok-on-retry");
    expect(calls).toHaveLength(2);
    // Every attempt re-asserts the isolation level.
    expect(calls.every((c) => c.isolationLevel === "repeatable read")).toBe(true);
  });

  it("retries an unwrapped 40001 from the driver's own begin/commit", async () => {
    // postgres-js issues `begin` / `commit` / `rollback` outside Drizzle's
    // prepared-query path and rethrows their errors as-is, so the bare
    // top-level-`code` shape also reaches the predicate.
    vi.stubEnv("RETRY_DISABLED", "false");
    const { db, calls } = mockDb([
      async () => {
        throw new PostgresError("40001", "could not serialize access");
      },
      async () => "ok-on-retry",
    ]);
    const tx = transactor(db);
    await expect(tx(async () => "unused")).resolves.toBe("ok-on-retry");
    expect(calls).toHaveLength(2);
  });

  it("does NOT retry on non-40001 errors — surfaces them with type intact", async () => {
    // The original-type preservation is the load-bearing property of
    // the shouldRetry approach (over AbortError). A
    // UniqueViolationError thrown inside a tx must surface as
    // UniqueViolationError to the caller, not wrapped.
    vi.stubEnv("RETRY_DISABLED", "false");
    class UniqueViolationError extends Error {
      readonly code = "23505" as const;
    }
    const original = new UniqueViolationError("unique violation");
    const { db, calls } = mockDb([
      async () => {
        throw original;
      },
    ]);

    const tx = transactor(db);
    const caught = await tx(async () => "unused").catch((e) => e);
    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a Drizzle-wrapped non-40001 SQLSTATE", async () => {
    // The wrapper must not make every driver error look retryable — only a
    // 40001 anywhere in the chain counts.
    vi.stubEnv("RETRY_DISABLED", "false");
    const original = new DrizzleQueryErrorLike(
      new PostgresError("23505", "duplicate key value violates unique constraint"),
    );
    const { db, calls } = mockDb([
      async () => {
        throw original;
      },
    ]);

    const tx = transactor(db);
    await expect(tx(async () => "unused")).rejects.toBe(original);
    expect(calls).toHaveLength(1);
  });

  it("gives up after 3 total attempts on persistent 40001", async () => {
    // Bounded retries; persistent conflicts surface to the caller
    // (Inngest's outer retry budget catches them) with the wrapper intact.
    vi.stubEnv("RETRY_DISABLED", "false");
    const failures = [
      serializationFailure("attempt 1"),
      serializationFailure("attempt 2"),
      serializationFailure("attempt 3"),
    ];
    const { db, calls } = mockDb(
      failures.map((failure) => async () => {
        throw failure;
      }),
    );
    const tx = transactor(db);
    await expect(tx(async () => "unused")).rejects.toBe(expectDefined(failures[2]));
    expect(calls).toHaveLength(3);
  });
});
