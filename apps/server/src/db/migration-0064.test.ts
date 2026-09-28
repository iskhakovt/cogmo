/**
 * Migrations 0064–0065 add `skill` to `pending_memory_source` and tie
 * `pending_memories.skill_name` to it with `chk_pending_memories_skill_name`.
 * Replays the committed journal through `migratePerFile`, as on a production
 * upgrade.
 */

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { pendingMemories, users } from "../agent/store/schema.js";
import { expectDefined } from "../test/assertions.js";
import type { Database } from "./index.js";
import { migratePerFile } from "./migrate-per-file.js";
import * as schema from "./schemas.js";

const EnumLabelsSchema = z.object({ rows: z.array(z.object({ enumlabel: z.string() })) });

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = new PGlite();
  db = drizzle({ client, schema });
  await migratePerFile(db, { migrationsFolder: "./migrations" });
});

afterEach(async () => {
  await client.close();
});

async function insertUser(): Promise<string> {
  const [row] = await db.insert(users).values({}).returning({ id: users.id });
  return expectDefined(row, "user").id;
}

describe("migrations 0064–0065 — pending_memories skill source", () => {
  it("adds skill to pending_memory_source", async () => {
    const { rows } = EnumLabelsSchema.parse(
      await db.execute(sql`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'pending_memory_source' ORDER BY e.enumsortorder
      `),
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(["live_retain", "migration", "skill"]);
  });

  it("stores a skill row with its skill's name, and requires the name on skill rows only", async () => {
    const userId = await insertUser();

    await db
      .insert(pendingMemories)
      .values({ userId, content: "the build is green", source: "skill", skillName: "ci_watch" });
    await db
      .insert(pendingMemories)
      .values({ userId, content: "likes tea", source: "live_retain" });

    const violation = {
      cause: { message: expect.stringMatching(/chk_pending_memories_skill_name/) },
    };
    await expect(
      db.insert(pendingMemories).values({ userId, content: "nameless", source: "skill" }),
    ).rejects.toMatchObject(violation);
    await expect(
      db
        .insert(pendingMemories)
        .values({ userId, content: "stray", source: "live_retain", skillName: "ci_watch" }),
    ).rejects.toMatchObject(violation);
  });
});
