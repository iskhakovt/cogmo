/// <reference path="../../test/vitest.d.ts" />

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectDefined } from "../test/assertions.js";
import { fileDatabaseUrl } from "../test/integration-file.js";
import { BOOTSTRAP_LOCK_KEY, withBootstrapLock } from "./bootstrap-lock.js";

let sql: ReturnType<typeof postgres>;
let observerSql: ReturnType<typeof postgres>;

beforeAll(() => {
  sql = postgres(fileDatabaseUrl(), { max: 2 });
  observerSql = postgres(fileDatabaseUrl(), { max: 1 });
});

afterAll(async () => {
  await Promise.all([sql.end(), observerSql.end()]);
});

/** Whether another session could take the lock now; releases it again if so. */
async function lockIsFree(): Promise<boolean> {
  const [row] = await observerSql<{ free: boolean }[]>`
    SELECT pg_try_advisory_lock(${BOOTSTRAP_LOCK_KEY}) AS free`;
  const { free } = expectDefined(row, "try-lock row");
  if (free) await observerSql`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`;
  return free;
}

describe("withBootstrapLock (real Postgres)", () => {
  it("holds the lock while `fn` runs and releases it after", async () => {
    const heldDuring = await withBootstrapLock(sql, () => lockIsFree().then((free) => !free));

    expect(heldDuring).toBe(true);
    expect(await lockIsFree()).toBe(true);
  });

  it("releases the lock and its connection when `fn` throws", async () => {
    await expect(
      withBootstrapLock(sql, () => Promise.reject(new Error("seed failed"))),
    ).rejects.toThrow("seed failed");

    expect(await lockIsFree()).toBe(true);
    // A second hold needs both of the pool's two connections: one reserved, one for `fn`.
    const [row] = await withBootstrapLock(sql, () => sql<{ one: number }[]>`SELECT 1 AS one`);
    expect(row?.one).toBe(1);
  });
});
