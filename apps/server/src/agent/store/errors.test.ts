import { count } from "drizzle-orm";
import { err, ok } from "neverthrow";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/transactor.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import {
  findPostgresReferentialViolation,
  findPostgresUniqueViolation,
  inSavepoint,
  referentialViolationAs,
  uniqueViolationAs,
} from "./errors.js";
import { users } from "./schema.js";

/**
 * Driver-error shapes, as they reach the store.
 *
 * Postgres reports a referential-integrity failure under two SQLSTATEs
 * depending on the referential action: `NO ACTION` FKs raise `23503`, while
 * `ON DELETE RESTRICT` FKs raise `23001` from PostgreSQL 18 onward. The store
 * runs against PG18 in every tier (PGlite unit tests, the
 * `pgvector/pgvector:pg18` container in dev/prod), so the `23001` arm is the
 * one `deleteProfileClass` actually takes — it is load-bearing, not defensive.
 *
 * The constraint name arrives under a different property per driver, so both
 * spellings are exercised: PGlite (the unit tier) exposes `constraint`,
 * postgres-js (dev/prod) maps error field 110 to `constraint_name`.
 */
function pgliteError(code: string, constraint: string): Error {
  return Object.assign(new Error(`violation on ${constraint}`), { code, constraint });
}

/** The production driver's shape: the constraint lands on `constraint_name`. */
function postgresJsError(code: string, constraintName: string): Error {
  return Object.assign(new Error(`violation on ${constraintName}`), {
    code,
    constraint_name: constraintName,
  });
}

/** Drizzle wraps driver errors in a `DrizzleQueryError` carrying `cause`. */
function wrapped(inner: Error): Error {
  return Object.assign(new Error("Failed query: delete from ..."), { cause: inner });
}

describe("findPostgresReferentialViolation", () => {
  it("matches 23503 (NO ACTION foreign-key violation)", () => {
    const found = findPostgresReferentialViolation(pgliteError("23503", "fk_a"));
    expect(found).toMatchObject({ code: "23503", constraint: "fk_a" });
  });

  it("matches 23001 (RESTRICT violation — the PG18 shape)", () => {
    const found = findPostgresReferentialViolation(pgliteError("23001", "fk_b"));
    expect(found).toMatchObject({ code: "23001", constraint: "fk_b" });
  });

  it("walks the Drizzle cause chain to reach the driver error", () => {
    const found = findPostgresReferentialViolation(wrapped(wrapped(pgliteError("23001", "fk_c"))));
    expect(found).toMatchObject({ code: "23001", constraint: "fk_c" });
  });

  it("carries postgres-js's constraint_name through the extraction", () => {
    // The production driver's spelling — the unit tier only ever sees PGlite's
    // `constraint`, so this is the one field with no store-level coverage.
    const found = findPostgresReferentialViolation(
      wrapped(postgresJsError("23001", "fk_profiles_profile_class")),
    );
    expect(found).toMatchObject({ code: "23001", constraint_name: "fk_profiles_profile_class" });
  });

  it("returns null for unrelated Postgres codes", () => {
    expect(findPostgresReferentialViolation(pgliteError("23505", "uq_a"))).toBeNull();
    expect(findPostgresReferentialViolation(new Error("boom"))).toBeNull();
  });

  it("does not treat a unique violation as a foreign-key violation, or vice versa", () => {
    expect(findPostgresUniqueViolation(pgliteError("23001", "fk_d"))).toBeNull();
    expect(findPostgresUniqueViolation(pgliteError("23505", "uq_b"))).toMatchObject({
      code: "23505",
    });
  });
});

describe("referentialViolationAs", () => {
  const inUse = { kind: "profile_class_in_use", profileRefs: 1 } as const;

  it.each(["23503", "23001"])("maps a %s violation on the named constraint", async (code) => {
    const result = await referentialViolationAs("fk_profiles_profile_class", inUse, () => {
      throw wrapped(pgliteError(code, "fk_profiles_profile_class"));
    });
    expect(result).toEqual(err(inUse));
  });

  it("matches the constraint under postgres-js's constraint_name spelling", async () => {
    const result = await referentialViolationAs("fk_profiles_profile_class", inUse, () => {
      throw wrapped(postgresJsError("23001", "fk_profiles_profile_class"));
    });
    expect(result).toEqual(err(inUse));
  });

  it("propagates a violation on a different constraint unchanged", async () => {
    const original = wrapped(pgliteError("23001", "fk_something_else"));
    await expect(
      referentialViolationAs("fk_profiles_profile_class", inUse, () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("propagates non-violation errors unchanged", async () => {
    const original = new Error("connection reset");
    await expect(
      referentialViolationAs("fk_profiles_profile_class", inUse, () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("returns the block's value as Ok when it does not throw", async () => {
    const result = await referentialViolationAs("fk_a", inUse, async () => ({ deleted: true }));
    expect(result).toEqual(ok({ deleted: true }));
  });
});

describe("uniqueViolationAs", () => {
  const taken = { kind: "profile_name_taken" } as const;

  it.each([
    ["PGlite", pgliteError],
    ["postgres-js", postgresJsError],
  ])("maps a violation on the named constraint in the %s shape", async (_driver, buildError) => {
    const result = await uniqueViolationAs("uq_profiles_user_name", taken, () => {
      throw wrapped(buildError("23505", "uq_profiles_user_name"));
    });
    expect(result).toEqual(err(taken));
  });

  it("propagates a violation on a different constraint unchanged", async () => {
    const original = wrapped(pgliteError("23505", "uq_aliases_user_alias"));
    await expect(
      uniqueViolationAs("uq_profiles_user_name", taken, () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("propagates non-violation errors unchanged", async () => {
    const original = new Error("connection reset");
    await expect(
      uniqueViolationAs("uq_profiles_user_name", taken, () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});

describe("inSavepoint", () => {
  let db: Database;
  let tx: Transactor;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, tx, close } = await createTestDatabase());
  });
  afterAll(async () => close());
  beforeEach(async () => truncateAll(db));

  async function userCount(): Promise<number> {
    const [row] = await db.select({ value: count() }).from(users);
    return row?.value ?? 0;
  }

  it("keeps the savepoint's writes on Ok", async () => {
    const result = await tx((trx) =>
      inSavepoint(trx, async (sp) => {
        await sp.insert(users).values({});
        return ok("done");
      }),
    );
    expect(result).toEqual(ok("done"));
    expect(await userCount()).toBe(1);
  });

  it("rolls back only the savepoint on Err, keeping the caller's writes", async () => {
    const result = await tx(async (trx) => {
      await trx.insert(users).values({});
      const inner = await inSavepoint(trx, async (sp) => {
        await sp.insert(users).values({});
        return err({ kind: "nope" } as const);
      });
      await trx.insert(users).values({});
      return inner;
    });
    expect(result).toEqual(err({ kind: "nope" }));
    expect(await userCount()).toBe(2);
  });

  it("leaves the caller's tx usable after a violation mapped to Err", async () => {
    const id = "0198f000-0000-7000-8000-000000000001";
    await tx(async (trx) => {
      await trx.insert(users).values({ id });
      const inner = await inSavepoint(trx, (sp) =>
        uniqueViolationAs("users_pkey", { kind: "taken" } as const, async () => {
          await sp.insert(users).values({ id });
        }),
      );
      expect(inner).toEqual(err({ kind: "taken" }));
      await trx.insert(users).values({});
    });
    expect(await userCount()).toBe(2);
  });

  it("rolls back the savepoint and propagates a throw", async () => {
    const boom = new Error("boom");
    await expect(
      tx((trx) =>
        inSavepoint(trx, async (sp) => {
          await sp.insert(users).values({});
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);
    expect(await userCount()).toBe(0);
  });
});
