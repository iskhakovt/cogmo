import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database, Transaction } from "./transactor.js";
import { transactor } from "./transactor.js";

const FAKE_TX = { __fakeTx: true } as unknown as Transaction;

/** Postgres SQLSTATE for serialization_failure. Drivers expose it on `err.code`. */
class SerializationFailureError extends Error {
  readonly code = "40001";
  constructor(message = "could not serialize access") {
    super(message);
    this.name = "SerializationFailureError";
  }
}

/**
 * Build a minimal `Database` stub that records `db.transaction` calls
 * and runs each callback against `FAKE_TX`. We don't go through
 * Drizzle / PGlite here — the unit under test is the retry + isolation
 * wiring around `db.transaction`, not the driver behaviour.
 */
function mockDb(): {
  db: Database;
  calls: { isolationLevel: string | undefined }[];
  setBehavior: (impls: Array<(tx: Transaction) => Promise<unknown>>) => void;
} {
  const calls: { isolationLevel: string | undefined }[] = [];
  let impls: Array<(tx: Transaction) => Promise<unknown>> = [];
  const transaction = vi.fn(
    async (
      cb: (tx: Transaction) => Promise<unknown>,
      opts?: { isolationLevel?: string },
    ): Promise<unknown> => {
      calls.push({ isolationLevel: opts?.isolationLevel });
      const impl = impls.shift();
      if (impl) return impl(FAKE_TX);
      return cb(FAKE_TX);
    },
  );
  return {
    db: { transaction } as unknown as Database,
    calls,
    setBehavior: (next) => {
      impls = next;
    },
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("transactor", () => {
  it("wraps each call with isolationLevel: repeatable read", async () => {
    const { db, calls } = mockDb();
    const tx = transactor(db);
    await tx(async () => "ok");
    expect(calls).toEqual([{ isolationLevel: "repeatable read" }]);
  });

  it("retries on 40001 and succeeds on the second attempt", async () => {
    // The whole point of the retry layer: a transient snapshot conflict
    // resolves cleanly on a fresh attempt.
    vi.stubEnv("RETRY_DISABLED", "false");
    const { db, calls, setBehavior } = mockDb();
    setBehavior([
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
    const { db, calls } = mockDb();
    db.transaction = vi.fn(async () => {
      calls.push({ isolationLevel: "repeatable read" });
      throw original;
    }) as unknown as Database["transaction"];

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
    const { db, calls, setBehavior } = mockDb();
    setBehavior([
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
    expect((caught as SerializationFailureError).code).toBe("40001");
    expect(calls).toHaveLength(3);
  });
});
