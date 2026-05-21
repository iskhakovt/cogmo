/// <reference path="../../test/vitest.d.ts" />
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles, users } from "../agent/store/schema.js";
import * as schema from "../db/schemas.js";
import { transactor } from "../db/transactor.js";
import { DrizzleTransportStore } from "../transport/store/index.js";
import {
  boundaryPending,
  channelSessions,
  channels,
  inboundMessages,
} from "../transport/store/schema.js";

let db: ReturnType<typeof drizzle<typeof schema>>;
let inngestBaseUrl: string;

beforeAll(() => {
  const databaseUrl = inject("databaseUrl");
  inngestBaseUrl = inject("inngestBaseUrl");
  db = drizzle({ connection: databaseUrl, schema });
});

afterAll(async () => {
  await db.$client.end();
});

describe("e2e smoke", () => {
  it("migrations applied — all tables queryable", async () => {
    expect(await db.select().from(users).limit(0)).toEqual([]);
    expect(await db.select().from(profiles).limit(0)).toEqual([]);
    expect(await db.select().from(conversations).limit(0)).toEqual([]);
    expect(await db.select().from(messages).limit(0)).toEqual([]);
    expect(await db.select().from(channels).limit(0)).toEqual([]);
    expect(await db.select().from(channelSessions).limit(0)).toEqual([]);
    expect(await db.select().from(inboundMessages).limit(0)).toEqual([]);
  });

  it("processes one message end-to-end", async () => {
    const defaultUserId = inject("defaultUserId");
    const eventKey = inject("inngestEventKey");

    const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
    const profileId = profileRows[0]!.id;
    const channelId = channelRows[0]!.id;

    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId, isPrivate: true })
      .returning({ id: conversations.id });

    const [session] = await db
      .insert(channelSessions)
      .values({
        channelId,
        platformAddress: `smoke-${Date.now()}`,
        conversationId: conv!.id,
        status: "active",
        receive: "routed",
      })
      .returning({ id: channelSessions.id });

    const [inbound] = await db
      .insert(inboundMessages)
      .values({
        channelSessionId: session!.id,
        conversationId: conv!.id,
        content: "Hello integration test",
        platformTs: new Date(),
        source: "user",
      })
      .returning({ id: inboundMessages.id });

    // Emit event via Inngest API
    const res = await fetch(`${inngestBaseUrl}/e/${eventKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "inbound/arrived",
        data: { conversationId: conv!.id, inboundMessageId: inbound!.id },
      }),
    });
    expect(res.ok).toBe(true);

    // Poll for assistant response
    const start = Date.now();
    let assistantMsg = null;
    while (Date.now() - start < 30_000) {
      const rows = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
      assistantMsg = rows.find((r) => r.role === "assistant");
      if (assistantMsg) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toBeDefined();
  });

  it("bundled binary loads the LiteLLM snapshot — `cogmo model list` reports source=litellm", async () => {
    // Regression for a path-resolution bug: `litellm-data.ts` originally
    // computed the snapshot path relative to `import.meta.url`. tsup
    // flattens the build into `dist/`, so the `../../` depth in source
    // doesn't survive — bundled, the resolver looked for `/data/...`
    // instead of `/app/data/...` and silently fell back to the
    // conservative default for every model. The build-time
    // `RUN test -s data/litellm-models.json` doesn't catch this because
    // the file IS in the image; the bug is in how the bundled module
    // resolves the path.
    //
    // We seed `claude-sonnet-4-6` as the default profile's model and
    // route it via the e2e provider. With the snapshot loaded, the
    // resolver finds LiteLLM data for that id and the CLI prints
    // `litellm`. Without the snapshot (the regressed state), every
    // column would render `default`.
    const containerId = inject("appContainerId");
    const stdout = execFileSync(
      "docker",
      ["exec", containerId, "node", "dist/main.js", "model", "list"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    expect(stdout).toMatch(/claude-sonnet-4-6/);
    // The source column for the seeded model is either `litellm` (both
    // columns from snapshot) or `cw=litellm,mo=litellm` if some future
    // refactor splits — anything matching `litellm` proves the snapshot
    // was readable from the bundled dist path. A regression would render
    // `default` (or `cw=default,mo=default`) and miss this match.
    expect(stdout).toMatch(/litellm/);
    expect(stdout).not.toMatch(/\bdefault\b/);
  });

  it("boundary-janitor query roundtrips a Date param through postgres-js", async () => {
    // Exercises `listExpiredBoundaryPending` on the real driver. Drizzle's
    // PGLite tier accepts a JS `Date` in the parameter slot and silently
    // coerces; postgres-js's prepared-statement bind rejects anything that
    // isn't a string, throwing `ERR_INVALID_ARG_TYPE` from `Buffer.byteLength`
    // before the query leaves the client. Typed operators (`lt`/`gt`/...)
    // apply the column's `mapToDriverValue` (Date → ISO-8601 string) so the
    // bind phase sees a string — this smoke pins that contract.
    const defaultUserId = inject("defaultUserId");
    const profileRows = await db.select({ id: profiles.id }).from(profiles).limit(1);
    const channelRows = await db.select({ id: channels.id }).from(channels).limit(1);
    const profileId = profileRows[0]!.id;
    const channelId = channelRows[0]!.id;

    const [conv] = await db
      .insert(conversations)
      .values({ userId: defaultUserId, profileId, isPrivate: true })
      .returning({ id: conversations.id });

    const platformAddress = `boundary-smoke-${Date.now()}`;
    const [pending] = await db
      .insert(boundaryPending)
      .values({
        channelId,
        platformAddress,
        platformUserHandle: "boundary-smoke",
        priorConversationId: conv!.id,
        promptMessageId: "tg:boundary-smoke",
        bufferedInbounds: [],
        expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      })
      .returning({ id: boundaryPending.id });
    const pendingId = pending!.id;

    const store = new DrizzleTransportStore();
    const tx = transactor(db);
    try {
      const expired = await tx((trx) =>
        store.listExpiredBoundaryPending(trx, new Date(Date.now() - 60_000)),
      );
      expect(expired).toContainEqual(
        expect.objectContaining({ id: pendingId, channelId, platformAddress }),
      );
    } finally {
      await db.delete(boundaryPending).where(eq(boundaryPending.id, pendingId));
    }
  });
});
