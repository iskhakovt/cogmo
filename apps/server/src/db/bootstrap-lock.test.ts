import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapLock } from "./bootstrap-lock.js";

// Never connected: `postgres()` opens a connection on the first query only.
const URL = "postgres://cogmo@127.0.0.1:1/cogmo";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bootstrapLock", () => {
  it.each([
    ["the max option", () => postgres(URL, { max: 1 })],
    ["a ?max= URL parameter", () => postgres(`${URL}?max=1`)],
    [
      "PGMAX",
      () => {
        vi.stubEnv("PGMAX", "1");
        return postgres(URL);
      },
    ],
  ])("refuses a one-connection pool set by %s", async (_, client) => {
    const sql = client();
    expect(() => bootstrapLock(sql)).toThrow("at least 2");
    await sql.end();
  });

  it("accepts a two-connection pool", async () => {
    const sql = postgres(URL, { max: 2 });
    expect(bootstrapLock(sql)).toBeTypeOf("function");
    await sql.end();
  });
});
