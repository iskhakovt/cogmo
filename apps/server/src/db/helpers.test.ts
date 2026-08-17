import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonbZod, pk, single, stringifyWellFormedJson, ts } from "./helpers.js";

/**
 * A value that serializes itself to a string carrying a lone surrogate. Models
 * anything reaching a `jsonb` column through a field the schema leaves opaque
 * (`z.unknown()`, as `tool_use.input` does) while owning its own encoding.
 */
class SelfEncoding {
  toJSON(): string {
    return "bad\uD800end";
  }
}

/** A non-plain object whose lone surrogate sits in an ordinary field. */
class Tagged {
  readonly note = "tag\uDC00ged";
}

describe("stringifyWellFormedJson", () => {
  const COLUMN = "content";

  it("matches JSON.stringify for well-formed values", () => {
    const value = { a: 1, b: ["x", null, true], c: { d: "é😀" } };
    expect(stringifyWellFormedJson(value, COLUMN)).toBe(JSON.stringify(value));
  });

  // Postgres rejects an escaped lone surrogate with 22P02 ("Unicode low
  // surrogate must follow a high surrogate"). The write happens after the
  // turn's tool side effects have run, so an unsanitized value is a poison
  // pill: every Inngest retry fails identically.
  it("replaces a lone surrogate in a string value with U+FFFD", () => {
    const encoded = stringifyWellFormedJson({ q: "bad\uD800end" }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ q: "bad�end" });
  });

  it("replaces a lone surrogate in an object key with U+FFFD", () => {
    const encoded = stringifyWellFormedJson({ "k\uDC00": "v" }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ "k�": "v" });
  });

  it("reaches lone surrogates nested inside arrays and objects", () => {
    const encoded = stringifyWellFormedJson(
      [{ type: "tool_use", input: { nested: ["ok", "x\uD800"] } }],
      COLUMN,
    );
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual([{ type: "tool_use", input: { nested: ["ok", "x�"] } }]);
  });

  it("leaves well-formed surrogate pairs intact", () => {
    const value = { q: "😀🎉" };
    expect(JSON.parse(stringifyWellFormedJson(value, COLUMN))).toEqual(value);
  });

  // The fast-negative regex runs over encoded text, where a backslash in the
  // source string is itself escaped — so `\ud800` as literal characters looks
  // like an escape and triggers the sanitising pass. That pass must be a
  // no-op on it.
  it("does not corrupt a string whose text spells a surrogate escape", () => {
    const value = { pattern: "\\ud800 matches high surrogates" };
    expect(stringifyWellFormedJson(value, COLUMN)).toBe(JSON.stringify(value));
  });

  it("leaves values with their own toJSON to serialize themselves", () => {
    const at = new Date("2026-01-02T03:04:05.000Z");
    expect(stringifyWellFormedJson({ at, q: "x\uD800" }, COLUMN)).toBe(
      JSON.stringify({ at, q: "x�" }),
    );
  });

  // A value's `toJSON` output lands in the encoded text as the same `\udXXX`
  // escape a plain string field produces, so the shape of the value graph it
  // came from doesn't matter.
  it("replaces a lone surrogate a value's own toJSON emits", () => {
    const encoded = stringifyWellFormedJson({ input: new SelfEncoding() }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ input: "bad�end" });
  });

  it("replaces a lone surrogate in a field of a non-plain object", () => {
    const encoded = stringifyWellFormedJson({ input: new Tagged() }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ input: { note: "tag�ged" } });
  });

  // A literal backslash in front of a lone surrogate makes the encoded text
  // read `\\\ud800`. Reading it escape by escape consumes the leading `\\` as
  // one, leaving the third backslash to open the surrogate escape that gets
  // rewritten.
  it("replaces consecutive lone surrogates behind a literal backslash", () => {
    const encoded = stringifyWellFormedJson({ q: "\\\uD800\uDBFF" }, COLUMN);
    expect(encoded).not.toMatch(/\\ud[89a-f]/i);
    expect(JSON.parse(encoded)).toEqual({ q: "\\��" });
  });

  // Sanitising walks every escape of the encoded text, so the escapes that
  // aren't surrogates — the short forms, and the `\u00XX` form control
  // characters take — have to come through untouched.
  it("keeps escapes that are not surrogates", () => {
    const control = String.fromCharCode(1);
    const encoded = stringifyWellFormedJson({ q: `tab\there${control}"quoted"\uD800` }, COLUMN);
    expect(JSON.parse(encoded)).toEqual({ q: `tab\there${control}"quoted"�` });
  });
});

/**
 * The encoding contract is "text Postgres accepts for a `jsonb` column", so it
 * is pinned against a real column rather than against `JSON.parse`.
 *
 * The one table here is declared and created locally: no app schema is
 * involved, so this skips `createTestDatabase`'s full-schema push and boots a
 * bare PGlite instead. `uuidv7()` comes from PGlite's bundled PostgreSQL 18.
 */
describe("jsonbZod against a jsonb column", () => {
  const probe = pgTable("jsonb_probe", {
    id: pk(),
    createdAt: ts(),
    payload: jsonbZod("payload", z.object({ input: z.unknown() })),
  });

  const client = new PGlite();
  const db = drizzle({ client });

  beforeAll(async () => {
    await db.execute(sql`
      CREATE TABLE jsonb_probe (
        id UUID PRIMARY KEY DEFAULT uuidv7(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await client.close();
  });

  // The rejection this encoding exists to prevent. Postgres raises 22P02 on the
  // escaped lone surrogate, and because the write happens after the turn's tool
  // side effects have run, that rejection is a poison pill — identical on every
  // Inngest retry.
  it("rejects an escaped lone surrogate that reached the wire unsanitized", async () => {
    const raw = JSON.stringify({ input: new SelfEncoding() });
    expect(raw).toMatch(/\\ud800/i);

    const rejection = await db.execute(sql`SELECT ${raw}::jsonb AS payload`).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Drizzle wraps the driver error; the SQLSTATE travels on its cause.
    expect(rejection).toBeInstanceOf(Error);
    const cause = rejection instanceof Error ? rejection.cause : undefined;
    expect(cause).toMatchObject({
      code: "22P02",
      detail: expect.stringContaining("surrogate"),
    });
  });

  it("stores a lone surrogate a value's own toJSON emits", async () => {
    const rows = await db
      .insert(probe)
      .values({ payload: { input: new SelfEncoding() } })
      .returning({ payload: probe.payload });
    expect(single(rows).payload).toEqual({ input: "bad�end" });
  });

  it("stores a lone surrogate carried by a plain string field", async () => {
    const rows = await db
      .insert(probe)
      .values({ payload: { input: { nested: ["ok", "x\uD800"] } } })
      .returning({ payload: probe.payload });
    expect(single(rows).payload).toEqual({ input: { nested: ["ok", "x�"] } });
  });

  it("stores text that merely spells a surrogate escape verbatim", async () => {
    const rows = await db
      .insert(probe)
      .values({ payload: { input: "\\ud800 matches high surrogates" } })
      .returning({ payload: probe.payload });
    expect(single(rows).payload).toEqual({ input: "\\ud800 matches high surrogates" });
  });
});
