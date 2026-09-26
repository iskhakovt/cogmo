import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createTestDatabase } from "../../test/pglite.js";
import { DrizzleTransportStore } from "../../transport/store/index.js";
import { DrizzleAgentStore, type Profile } from "../store/index.js";
import { loadConversationContext } from "./load-conversation-context.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: null,
    name: "default",
    basePrompt: "be helpful",
    model: "m",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    profileClass: null,
    streamChunkChars: 4000,
    streamEdits: true,
    codingAutoapproveMode: "off",
    ...overrides,
  };
}

describe("loadConversationContext", () => {
  it("does not re-read the profile — uses the row passed in by the caller", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([{ rule: "Be concise" }]),
      getCoreMemoryBlocks: vi.fn().mockResolvedValue([{ key: "user_profile", content: "Sam" }]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", userId: "u1", profile: profile() },
    );

    expect(result).toEqual({
      channelTypes: ["telegram"],
      rules: [{ rule: "Be concise" }],
      coreMemory: [{ key: "user_profile", content: "Sam" }],
    });

    expect(agentStore.getProfile).not.toHaveBeenCalled();
    expect(transportStore.getActiveChannelTypes).toHaveBeenCalledWith(FAKE_TX, "c1");
    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram"]);
    expect(agentStore.getCoreMemoryBlocks).toHaveBeenCalledWith(FAKE_TX, "u1");
  });

  it("threads channelTypes from transport into agentStore.getActiveRules", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram", "slack"]),
    });

    await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", userId: "u1", profile: profile() },
    );

    expect(agentStore.getActiveRules).toHaveBeenCalledWith(FAKE_TX, "p1", ["telegram", "slack"]);
  });

  it("skips the rules lookup when profile is undefined", async () => {
    const agentStore = mockAgentStore({
      getActiveRules: vi.fn().mockResolvedValue([]),
    });
    const transportStore = mockTransportStore({
      getActiveChannelTypes: vi.fn().mockResolvedValue(["telegram"]),
    });

    const result = await loadConversationContext(
      { runInTx: fakeRunInTx, agentStore, transportStore },
      { conversationId: "c1", userId: "u1", profile: undefined },
    );

    expect(result.rules).toEqual([]);
    expect(agentStore.getActiveRules).not.toHaveBeenCalled();
  });
});

describe("loadConversationContext core memory (PGlite)", () => {
  let runInTx: Transactor;
  let close: () => Promise<void>;
  const agentStore = new DrizzleAgentStore();
  const transportStore = new DrizzleTransportStore();

  beforeAll(async () => {
    ({ tx: runInTx, close } = await createTestDatabase());
  });

  afterAll(async () => {
    await close();
  });

  it("loads the core memory of the user it is given, not another user's", async () => {
    // The first user created is the one bootstrap resolves as the install's
    // user; the conversation belongs to the second.
    const first = await runInTx((tx) => agentStore.createUser(tx));
    const second = await runInTx((tx) => agentStore.createUser(tx));
    await runInTx(async (tx) => {
      await agentStore.upsertCoreMemoryBlock(tx, {
        userId: first.id,
        key: "user_profile",
        content: "Name: Ana",
      });
      await agentStore.upsertCoreMemoryBlock(tx, {
        userId: second.id,
        key: "user_profile",
        content: "Name: Ben",
      });
      await agentStore.upsertCoreMemoryBlock(tx, {
        userId: second.id,
        key: "preferences",
        content: "Metric units",
      });
    });

    const context = await loadConversationContext(
      { runInTx, agentStore, transportStore },
      { conversationId: randomUUID(), userId: second.id, profile: undefined },
    );

    expect(context.coreMemory).toEqual([
      { key: "preferences", content: "Metric units" },
      { key: "user_profile", content: "Name: Ben" },
    ]);
  });
});
