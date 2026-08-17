import { describe, expect, it } from "vitest";
import { constraintNameOf, findPgErrorByCode } from "./pg-errors.js";

/** A driver error: SQLSTATE on a top-level `code`. */
function driverError(code: string, fields: Record<string, string> = {}): Error {
  return Object.assign(new Error(`pg error ${code}`), { code, ...fields });
}

/** Drizzle's `DrizzleQueryError`: query/params/cause, never a `code`. */
function wrapped(cause: unknown): Error {
  return Object.assign(new Error("Failed query: select ..."), {
    query: "select 1",
    params: [],
    cause,
  });
}

const CODES = ["40001"] as const;

describe("findPgErrorByCode", () => {
  it("matches a code on the thrown error itself", () => {
    expect(findPgErrorByCode(driverError("40001"), CODES)).toMatchObject({ code: "40001" });
  });

  it("matches a code buried under Drizzle's wrapper", () => {
    expect(findPgErrorByCode(wrapped(driverError("40001")), CODES)).toMatchObject({
      code: "40001",
    });
  });

  it("matches any of the supplied codes and reports which one hit", () => {
    const found = findPgErrorByCode(wrapped(driverError("23001")), ["23503", "23001"]);
    expect(found).toMatchObject({ code: "23001" });
  });

  it("preserves both constraint spellings", () => {
    expect(
      findPgErrorByCode(wrapped(driverError("23505", { constraint_name: "uq_a" })), ["23505"]),
    ).toMatchObject({ constraint_name: "uq_a" });
    expect(
      findPgErrorByCode(wrapped(driverError("23505", { constraint: "uq_b" })), ["23505"]),
    ).toMatchObject({ constraint: "uq_b" });
  });

  it("returns null for a different code, a code-less chain, or a non-error cause", () => {
    expect(findPgErrorByCode(wrapped(driverError("23505")), CODES)).toBeNull();
    expect(findPgErrorByCode(wrapped(new Error("no code here")), CODES)).toBeNull();
    expect(findPgErrorByCode(wrapped("just a string"), CODES)).toBeNull();
    expect(findPgErrorByCode(null, CODES)).toBeNull();
  });

  it("walks a bounded number of levels", () => {
    // Real chains are one or two deep; the bound keeps a self-referential or
    // pathologically nested `cause` from turning the predicate into a walk.
    expect(findPgErrorByCode(wrapped(wrapped(wrapped(driverError("40001")))), CODES)).toMatchObject(
      { code: "40001" },
    );
    expect(findPgErrorByCode(wrapped(wrapped(wrapped(wrapped(driverError("40001"))))), CODES)).toBe(
      null,
    );
  });
});

describe("constraintNameOf", () => {
  it("reads either driver's spelling, falling back to 'unknown'", () => {
    expect(constraintNameOf({ code: "23505", constraint_name: "uq_a" })).toBe("uq_a");
    expect(constraintNameOf({ code: "23505", constraint: "uq_b" })).toBe("uq_b");
    expect(constraintNameOf({ code: "23505" })).toBe("unknown");
  });
});
