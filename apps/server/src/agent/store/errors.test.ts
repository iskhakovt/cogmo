import { describe, expect, it } from "vitest";
import {
  findPostgresReferentialViolation,
  findPostgresUniqueViolation,
  ProfileClassInUseError,
  translateReferentialViolation,
  translateUniqueViolation,
  UniqueViolationError,
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

describe("translateReferentialViolation", () => {
  const match = {
    constraintName: "fk_profiles_profile_class",
    rethrow: () => new ProfileClassInUseError(1),
  };

  it.each(["23503", "23001"])("translates a %s violation on the named constraint", async (code) => {
    await expect(
      translateReferentialViolation(() => {
        throw wrapped(pgliteError(code, "fk_profiles_profile_class"));
      }, match),
    ).rejects.toBeInstanceOf(ProfileClassInUseError);
  });

  it("matches the constraint under postgres-js's constraint_name spelling", async () => {
    await expect(
      translateReferentialViolation(() => {
        throw wrapped(postgresJsError("23001", "fk_profiles_profile_class"));
      }, match),
    ).rejects.toBeInstanceOf(ProfileClassInUseError);
  });

  it("propagates a violation on a different constraint unchanged", async () => {
    const original = wrapped(pgliteError("23001", "fk_something_else"));
    await expect(
      translateReferentialViolation(() => {
        throw original;
      }, match),
    ).rejects.toBe(original);
  });

  it("propagates non-violation errors unchanged", async () => {
    const original = new Error("connection reset");
    await expect(
      translateReferentialViolation(() => {
        throw original;
      }, match),
    ).rejects.toBe(original);
  });

  it("returns the block's value when it does not throw", async () => {
    await expect(
      translateReferentialViolation(async () => ({ deleted: true }), match),
    ).resolves.toEqual({
      deleted: true,
    });
  });
});

describe("translateUniqueViolation", () => {
  it.each([
    ["PGlite", pgliteError],
    ["postgres-js", postgresJsError],
  ])("carries the constraint name through the %s shape", async (_driver, buildError) => {
    const caught = await translateUniqueViolation(() => {
      throw wrapped(buildError("23505", "uq_profiles_user_name"));
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(UniqueViolationError);
    expect(caught).toMatchObject({ constraint: "uq_profiles_user_name" });
  });

  it("propagates non-violation errors unchanged", async () => {
    const original = new Error("connection reset");
    await expect(
      translateUniqueViolation(() => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
