import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapLock } from "./bootstrap-lock.js";

// Never connected: `postgres()` opens a connection on the first query only.
const URL = "postgres://cogmo@127.0.0.1:1/cogmo";

afterEach(() => {
  vi.unstubAllEnvs();
});

function withPgmax(value: string): ReturnType<typeof postgres> {
  vi.stubEnv("PGMAX", value);
  return postgres(URL);
}

describe("bootstrapLock", () => {
  // postgres-js keeps `max` from the URL or PGMAX as a string and compares
  // against it: a numeric string opens that many connections, any other none.
  it.each([
    ["max: 1", () => postgres(URL, { max: 1 }), "max=1 opens 1"],
    ["?max=1", () => postgres(`${URL}?max=1`), "max=1 opens 1"],
    ["PGMAX=1", () => withPgmax("1"), "max=1 opens 1"],
    ["?max=0", () => postgres(`${URL}?max=0`), "max=0 opens 0"],
    ["?max=abc", () => postgres(`${URL}?max=abc`), "max=abc opens none"],
    ["an empty ?max=", () => postgres(`${URL}?max=`), "max= opens 0"],
  ])("refuses a pool sized by %s", async (_, client, message) => {
    const sql = client();
    expect(() => bootstrapLock(sql)).toThrow(`at least 2, but ${message}`);
    await sql.end();
  });

  it.each([
    ["max: 2", () => postgres(URL, { max: 2 })],
    ["the default pool", () => postgres(URL)],
    ["?max=5", () => postgres(`${URL}?max=5`)],
    ["PGMAX=5", () => withPgmax("5")],
    [
      "an explicit max: undefined, which takes the default",
      () => postgres(URL, { max: undefined } as unknown as Parameters<typeof postgres>[1]),
    ],
  ])("accepts %s", async (_, client) => {
    const sql = client();
    expect(bootstrapLock(sql)).toBeTypeOf("function");
    await sql.end();
  });
});
