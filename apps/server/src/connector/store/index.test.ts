import { sql } from "drizzle-orm";
import { err } from "neverthrow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Database, Transactor } from "../../db/index.js";
import { expectOk, expectPgError } from "../../test/assertions.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleConnectorStore } from "./index.js";
import { connectors } from "./schema.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
let store: DrizzleConnectorStore;

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
  store = new DrizzleConnectorStore();
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

const REVOKED_AT = new Date("2026-11-08T12:00:00.000Z");
const LATER = new Date("2026-11-09T12:00:00.000Z");

function add(name: string, tokenHash: string) {
  return tx((trx) => store.insert(trx, { name, kind: "coding", tokenHash }));
}

function revoke(name: string) {
  return tx((trx) => store.revoke(trx, { name, now: REVOKED_AT }));
}

describe("DrizzleConnectorStore", () => {
  describe("insert", () => {
    it("inserts an active connector", async () => {
      const { id } = expectOk(await add("laptop", "h1"));
      expect(await tx((trx) => store.listActive(trx))).toEqual([
        { id, name: "laptop", kind: "coding", tokenHash: "h1" },
      ]);
    });

    it("refuses a name an active connector holds", async () => {
      expectOk(await add("laptop", "h1"));
      expect(await add("laptop", "h2")).toEqual(err({ kind: "name_taken" }));
      expect(await tx((trx) => store.list(trx))).toHaveLength(1);
    });

    it("adds a revoked connector's name again as a new row", async () => {
      const first = expectOk(await add("laptop", "h1"));
      expectOk(await revoke("laptop"));
      const second = expectOk(await add("laptop", "h2"));
      expect(second.id).not.toBe(first.id);
      expect(await tx((trx) => store.list(trx))).toMatchObject([
        { id: first.id, status: "revoked" },
        { id: second.id, status: "active" },
      ]);
    });
  });

  describe("rotateToken", () => {
    it("replaces the active connector's token hash", async () => {
      const { id } = expectOk(await add("laptop", "h1"));
      expect(
        expectOk(await tx((trx) => store.rotateToken(trx, { name: "laptop", tokenHash: "h2" }))),
      ).toEqual({ id });
      expect(await tx((trx) => store.listActive(trx))).toEqual([
        { id, name: "laptop", kind: "coding", tokenHash: "h2" },
      ]);
    });

    it("reports not_found for an unknown name", async () => {
      expect(await tx((trx) => store.rotateToken(trx, { name: "ghost", tokenHash: "h2" }))).toEqual(
        err({ kind: "not_found" }),
      );
    });

    it("reports not_found for a revoked name and leaves its hash alone", async () => {
      expectOk(await add("laptop", "h1"));
      expectOk(await revoke("laptop"));
      expect(
        await tx((trx) => store.rotateToken(trx, { name: "laptop", tokenHash: "h2" })),
      ).toEqual(err({ kind: "not_found" }));
      expect(await db.select({ tokenHash: connectors.tokenHash }).from(connectors)).toEqual([
        { tokenHash: "h1" },
      ]);
    });
  });

  describe("revoke", () => {
    it("moves the active connector to revoked and stamps revoked_at", async () => {
      const { id } = expectOk(await add("laptop", "h1"));
      expect(expectOk(await revoke("laptop"))).toEqual({ id });
      expect(await tx((trx) => store.list(trx))).toMatchObject([
        { id, status: "revoked", revokedAt: REVOKED_AT },
      ]);
      expect(await tx((trx) => store.listActive(trx))).toEqual([]);
    });

    it("reports not_found for an unknown name", async () => {
      expect(await revoke("ghost")).toEqual(err({ kind: "not_found" }));
    });

    it("reports not_found for an already-revoked name and keeps its revoked_at", async () => {
      expectOk(await add("laptop", "h1"));
      expectOk(await revoke("laptop"));
      expect(await tx((trx) => store.revoke(trx, { name: "laptop", now: LATER }))).toEqual(
        err({ kind: "not_found" }),
      );
      expect(await tx((trx) => store.list(trx))).toMatchObject([{ revokedAt: REVOKED_AT }]);
    });

    it("revokes only the active row when a revoked one shares the name", async () => {
      const first = expectOk(await add("laptop", "h1"));
      expectOk(await revoke("laptop"));
      const second = expectOk(await add("laptop", "h2"));
      expect(
        expectOk(await tx((trx) => store.revoke(trx, { name: "laptop", now: LATER }))),
      ).toEqual({ id: second.id });
      expect(await tx((trx) => store.list(trx))).toMatchObject([
        { id: first.id, revokedAt: REVOKED_AT },
        { id: second.id, revokedAt: LATER },
      ]);
    });
  });

  describe("list", () => {
    it("returns every connector, active and revoked, oldest first", async () => {
      const a = expectOk(await add("alpha", "h1"));
      const b = expectOk(await add("bravo", "h2"));
      const c = expectOk(await add("charlie", "h3"));
      expectOk(await revoke("bravo"));
      const rows = await tx((trx) => store.list(trx));
      expect(rows).toEqual([
        {
          id: a.id,
          name: "alpha",
          kind: "coding",
          status: "active",
          createdAt: expect.any(Date),
          revokedAt: null,
        },
        {
          id: b.id,
          name: "bravo",
          kind: "coding",
          status: "revoked",
          createdAt: expect.any(Date),
          revokedAt: REVOKED_AT,
        },
        {
          id: c.id,
          name: "charlie",
          kind: "coding",
          status: "active",
          createdAt: expect.any(Date),
          revokedAt: null,
        },
      ]);
    });

    it("is empty with no connectors", async () => {
      expect(await tx((trx) => store.list(trx))).toEqual([]);
    });
  });

  describe("listActive", () => {
    it("excludes revoked connectors", async () => {
      const a = expectOk(await add("alpha", "h1"));
      expectOk(await add("bravo", "h2"));
      const c = expectOk(await add("charlie", "h3"));
      expectOk(await revoke("bravo"));
      expect(await tx((trx) => store.listActive(trx))).toEqual([
        { id: a.id, name: "alpha", kind: "coding", tokenHash: "h1" },
        { id: c.id, name: "charlie", kind: "coding", tokenHash: "h3" },
      ]);
    });
  });

  describe("chk_connectors_revoked_at", () => {
    const rejected = (statement: Promise<unknown>) =>
      statement.then(
        () => null,
        (error: unknown) => error,
      );

    it("rejects a revoked row without revoked_at", async () => {
      expectOk(await add("laptop", "h1"));
      expectPgError(
        await rejected(
          db.execute(sql`UPDATE connectors SET status = 'revoked' WHERE name = 'laptop'`),
        ),
        "23514",
        "chk_connectors_revoked_at",
      );
    });

    it("rejects an active row with revoked_at", async () => {
      expectOk(await add("laptop", "h1"));
      expectPgError(
        await rejected(
          db.execute(sql`UPDATE connectors SET revoked_at = now() WHERE name = 'laptop'`),
        ),
        "23514",
        "chk_connectors_revoked_at",
      );
    });
  });
});
