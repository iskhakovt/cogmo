import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Database, Transaction } from "./transactor.js";
import { transactor } from "./transactor.js";

/** Postgres SQLSTATE for serialization_failure. Drivers expose it on `err.code`. */
class SerializationFailureError extends Error {
  readonly code = "40001";
  constructor(message = "could not serialize access") {
    super(message);
    this.name = "SerializationFailureError";
  }
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

  it("retries on 40001 and succeeds on the second attempt", async () => {
    // The whole point of the retry layer: a transient snapshot conflict
    // resolves cleanly on a fresh attempt.
    vi.stubEnv("RETRY_DISABLED", "false");
    const { db, calls } = mockDb([
      async () => {
        throw new SerializationFailureError();
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

  it("gives up after 3 total attempts on persistent 40001", async () => {
    // Bounded retries; persistent conflicts surface to the caller
    // (Inngest's outer retry budget catches them).
    vi.stubEnv("RETRY_DISABLED", "false");
    const { db, calls } = mockDb([
      async () => {
        throw new SerializationFailureError("attempt 1");
      },
      async () => {
        throw new SerializationFailureError("attempt 2");
      },
      async () => {
        throw new SerializationFailureError("attempt 3");
      },
    ]);
    const tx = transactor(db);
    const caught = await tx(async () => "unused").catch((e) => e);
    expect(caught).toBeInstanceOf(SerializationFailureError);
    expect((caught as SerializationFailureError).code).toBe("40001");
    expect(calls).toHaveLength(3);
  });
});
