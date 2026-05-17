/// <reference path="../../test/vitest.d.ts" />
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { conversations, messages, profiles, users } from "../agent/store/schema.js";
import { channelSessions, channels, inboundMessages } from "../transport/store/schema.js";

let db: ReturnType<typeof drizzle>;
let inngestBaseUrl: string;

beforeAll(() => {
  const databaseUrl = inject("databaseUrl");
  inngestBaseUrl = inject("inngestBaseUrl");
  db = drizzle({ connection: databaseUrl });
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
});
