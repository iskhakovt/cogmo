import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DrizzleAgentStore } from "../../agent/store/index.js";
import type { Database, Transactor } from "../../db/index.js";
import { createTestDatabase, truncateAll } from "../../test/pglite.js";
import { DrizzleTransportStore } from "../store/index.js";
import { createSenders } from "./senders.js";

let db: Database;
let tx: Transactor;
let close: () => Promise<void>;
const transportStore = new DrizzleTransportStore();
const agentStore = new DrizzleAgentStore();

beforeAll(async () => {
  ({ db, tx, close } = await createTestDatabase());
});

afterEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await close();
});

async function createChannel(identityMode: string): Promise<string> {
  const { id } = await tx((trx) =>
    transportStore.createChannel(trx, { type: "telegram", credentials: {}, identityMode }),
  );
  return id;
}

async function addUser(channelId: string, platformHandle: string): Promise<void> {
  await tx(async (trx) => {
    const { id: userId } = await agentStore.createUser(trx);
    await transportStore.createIdentity(trx, { userId, channelId, platformHandle });
  });
}

function sendersOf(channelId: string) {
  return createSenders({ channelId, runInTx: tx, transportStore });
}

describe("senders.admits", () => {
  it("admits a handle with an identity row on a mapped channel, and no other", async () => {
    const channelId = await createChannel("mapped");
    await addUser(channelId, "111");

    expect(await sendersOf(channelId).admits("111")).toBe(true);
    expect(await sendersOf(channelId).admits("999")).toBe(false);
  });

  it("refuses a handle whose identity row is on another channel", async () => {
    const other = await createChannel("mapped");
    await addUser(other, "111");
    const channelId = await createChannel("mapped");

    expect(await sendersOf(channelId).admits("111")).toBe(false);
  });

  it("admits anyone on a fixed channel", async () => {
    const channelId = await createChannel("fixed");
    await tx(async (trx) => {
      const { id: userId } = await agentStore.createUser(trx);
      await transportStore.createWildcardIdentity(trx, { userId, channelId });
    });

    expect(await sendersOf(channelId).admits("999")).toBe(true);
  });

  it("admits a handle with no identity row on a create channel", async () => {
    const channelId = await createChannel("create");

    expect(await sendersOf(channelId).admits("999")).toBe(true);
  });

  it("admits no one on a channel whose mode it doesn't know", async () => {
    const channelId = await createChannel("open");
    await addUser(channelId, "111");

    expect(await sendersOf(channelId).admits("111")).toBe(false);
  });

  it("admits no one for a channel id with no row", async () => {
    expect(await sendersOf("00000000-0000-7000-8000-000000000000").admits("111")).toBe(false);
  });
});
