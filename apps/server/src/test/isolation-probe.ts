/**
 * Two integration files run this, and a leak between files fails at least one
 * of them. Each writes a global steering rule and asks llmock the same
 * question: on a shared database the later check sees the other file's rule,
 * and on a shared fixture pool both get whichever answer registered first.
 */
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DrizzleAgentStore } from "../agent/store/index.js";
import * as schema from "../db/schemas.js";
import { type Transactor, transactor } from "../db/transactor.js";
import { fileDatabaseUrl, fileLlmockUrl } from "./integration-file.js";

const PROBE = "isolation probe";

const MessagesResponseSchema = z.object({ content: z.array(z.object({ text: z.string() })) });

export function describeIsolationProbe(name: string): void {
  describe(`suite isolation (${name})`, () => {
    let sql: ReturnType<typeof postgres>;
    let runInTx: Transactor;

    beforeAll(() => {
      sql = postgres(fileDatabaseUrl(), { max: 2 });
      runInTx = transactor(drizzle(sql, { schema }));
    });

    afterAll(async () => {
      await sql.end();
    });

    it("sees only its own global steering rule", async () => {
      const store = new DrizzleAgentStore();
      await runInTx((tx) =>
        tx.insert(schema.steeringRules).values({
          rule: `${PROBE} ${name}`,
          category: "style",
          active: true,
          source: "manual",
          priority: 50,
          observationCount: 0,
          profileId: null,
          channelType: null,
        }),
      );
      const rules = await runInTx((tx) =>
        store.getActiveRules(tx, { profileId: randomUUID(), userId: null }),
      );
      expect(rules.map((r) => r.rule).filter((r) => r.startsWith(PROBE))).toEqual([
        `${PROBE} ${name}`,
      ]);
    });

    it("replays only its own cassette", async () => {
      const res = await fetch(`${fileLlmockUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "test-key",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 16,
          messages: [{ role: "user", content: PROBE }],
        }),
      });
      const { content } = MessagesResponseSchema.parse(await res.json());
      expect(content.map((c) => c.text).join("")).toBe(name);
    });
  });
}
