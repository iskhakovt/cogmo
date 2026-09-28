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
  it("refuses a pool of one connection", async () => {
    const sql = postgres(URL, { max: 1 });
    expect(() => bootstrapLock(sql)).toThrow("at least 2");
    await sql.end();
  });

  // postgres-js sizes its pool with `Array(options.max)`: a string or missing
  // `max` builds one connection, whatever number the string holds.
  it.each([
    ["?max=5", () => postgres(`${URL}?max=5`)],
    ["?max=1", () => postgres(`${URL}?max=1`)],
    ["?max=abc", () => postgres(`${URL}?max=abc`)],
    ["PGMAX=5", () => withPgmax("5")],
    ["PGMAX=1", () => withPgmax("1")],
    [
      "an explicit max: undefined",
      () => postgres(URL, { max: undefined } as unknown as Parameters<typeof postgres>[1]),
    ],
  ])(
    "refuses a pool sized by %s, which postgres-js opens with one connection",
    async (_, client) => {
      const sql = client();
      expect(() => bootstrapLock(sql)).toThrow(/one connection. Set `max` in code/);
      await sql.end();
    },
  );

  it.each([
    ["max: 2", () => postgres(URL, { max: 2 })],
    ["the default pool", () => postgres(URL)],
  ])("accepts %s", async (_, client) => {
    const sql = client();
    expect(bootstrapLock(sql)).toBeTypeOf("function");
    await sql.end();
  });
});
