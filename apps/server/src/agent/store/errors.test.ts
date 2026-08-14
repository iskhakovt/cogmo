import { describe, expect, it } from "vitest";
import {
  findPostgresForeignKeyViolation,
  findPostgresUniqueViolation,
  ProfileClassInUseError,
  translateForeignKeyViolation,
} from "./errors.js";

/**
 * Driver-error shapes, as they reach the store.
 *
 * Postgres reports a referential-integrity failure under two SQLSTATEs
 * depending on the referential action: `NO ACTION` FKs raise `23503`, while
 * `ON DELETE RESTRICT` FKs raise `23001` from PostgreSQL 18 onward. The store
 * runs against PG18 in every tier (PGlite unit tests, the
 * `pgvector/pgvector:pg18` container in dev/prod), so the `23001` arm is the
 * one `deleteProfileClass` actually takes — it is load-bearing, not defensive.
 */
function pgError(code: string, constraint: string): Error {
  return Object.assign(new Error(`violation on ${constraint}`), { code, constraint });
}

/** Drizzle wraps driver errors in a `DrizzleQueryError` carrying `cause`. */
function wrapped(inner: Error): Error {
  return Object.assign(new Error("Failed query: delete from ..."), { cause: inner });
}

describe("findPostgresForeignKeyViolation", () => {
  it("matches 23503 (NO ACTION foreign-key violation)", () => {
    const found = findPostgresForeignKeyViolation(pgError("23503", "fk_a"));
    expect(found).toMatchObject({ code: "23503", constraint: "fk_a" });
  });

  it("matches 23001 (RESTRICT violation — the PG18 shape)", () => {
    const found = findPostgresForeignKeyViolation(pgError("23001", "fk_b"));
    expect(found).toMatchObject({ code: "23001", constraint: "fk_b" });
  });

  it("walks the Drizzle cause chain to reach the driver error", () => {
    const found = findPostgresForeignKeyViolation(wrapped(wrapped(pgError("23001", "fk_c"))));
    expect(found).toMatchObject({ code: "23001", constraint: "fk_c" });
  });

  it("returns null for unrelated Postgres codes", () => {
    expect(findPostgresForeignKeyViolation(pgError("23505", "uq_a"))).toBeNull();
    expect(findPostgresForeignKeyViolation(new Error("boom"))).toBeNull();
  });

  it("does not treat a unique violation as a foreign-key violation, or vice versa", () => {
    expect(findPostgresUniqueViolation(pgError("23001", "fk_d"))).toBeNull();
    expect(findPostgresUniqueViolation(pgError("23505", "uq_b"))).toMatchObject({ code: "23505" });
  });
});

describe("translateForeignKeyViolation", () => {
  const match = {
    constraintName: "fk_profiles_profile_class",
    rethrow: () => new ProfileClassInUseError(1),
  };

  it.each(["23503", "23001"])("translates a %s violation on the named constraint", async (code) => {
    await expect(
      translateForeignKeyViolation(() => {
        throw wrapped(pgError(code, "fk_profiles_profile_class"));
      }, match),
    ).rejects.toBeInstanceOf(ProfileClassInUseError);
  });

  it("propagates a violation on a different constraint unchanged", async () => {
    const original = wrapped(pgError("23001", "fk_something_else"));
    await expect(
      translateForeignKeyViolation(() => {
        throw original;
      }, match),
    ).rejects.toBe(original);
  });

  it("propagates non-violation errors unchanged", async () => {
    const original = new Error("connection reset");
    await expect(
      translateForeignKeyViolation(() => {
        throw original;
      }, match),
    ).rejects.toBe(original);
  });

  it("returns the block's value when it does not throw", async () => {
    await expect(
      translateForeignKeyViolation(async () => ({ deleted: true }), match),
    ).resolves.toEqual({
      deleted: true,
    });
  });
});
