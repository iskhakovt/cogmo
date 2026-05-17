/**
 * Unit tests for `dispatchScheduledFire` — the engaged-reuse vs
 * idle-rotate decision, pinned directly so it survives any restructuring
 * of the Inngest handler that wraps it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { buildSyntheticInboundContent, dispatchScheduledFire } from "./dispatch-fire.js";

const FAKE_TX = { __mockTx: true } as never;
const runInTx: Transactor = (cb) => cb(FAKE_TX);

const baseArgs = {
  userId: "user-1",
  profileId: "profile-1",
  scheduledFor: "2026-05-14T09:00:00.000Z",
  prompt: "morning briefing",
};

const idleTimeoutMs = 5 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchScheduledFire", () => {
  it("reuses an engaged conversation without rotating sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T09:01:00.000Z"));

    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
        id: "conv-existing",
        lastMessageAt: new Date("2026-05-14T09:00:30.000Z"), // 30s ago
      }),
    });
    const transportStore = mockTransportStore({
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-7" }),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toEqual({
      status: "dispatched",
      conversationId: "conv-existing",
      inboundId: "inbound-7",
    });
    expect(transportStore.findReachableChannelsForUserProfile).not.toHaveBeenCalled();
    expect(transportStore.swapSession).not.toHaveBeenCalled();
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(transportStore.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      channelSessionId: null,
      conversationId: "conv-existing",
      content: buildSyntheticInboundContent(baseArgs.scheduledFor, baseArgs.prompt),
      platformTs: new Date(baseArgs.scheduledFor),
      source: "scheduled",
    });
  });

  it("treats lastMessageAt === null (no messages yet) as idle and rotates", async () => {
    // An empty conversation is "most recent" but not engaged — reusing
    // would dump the fire into a conversation the user never opened.
    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
        id: "conv-empty",
        lastMessageAt: null,
      }),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-fresh" }),
    });
    const transportStore = mockTransportStore({
      findReachableChannelsForUserProfile: vi
        .fn()
        .mockResolvedValue([{ channelId: "ch-tg", platformAddress: "chat-42", receive: "routed" }]),
      swapSession: vi.fn().mockResolvedValue({ id: "session-new" }),
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-9" }),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toMatchObject({ status: "dispatched", conversationId: "conv-fresh" });
    expect(agentStore.createConversation).toHaveBeenCalledTimes(1);
    expect(transportStore.swapSession).toHaveBeenCalledTimes(1);
  });

  it("preserves the prior receive mode when rotating each channel", async () => {
    // Carrying forward `receive` keeps Web UI's `'all'` semantics intact
    // on the new conversation.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T09:00:00.000Z"));

    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
        id: "conv-stale",
        lastMessageAt: new Date("2026-05-13T22:00:00.000Z"),
      }),
      createConversation: vi.fn().mockResolvedValue({ id: "conv-fresh" }),
    });
    const transportStore = mockTransportStore({
      findReachableChannelsForUserProfile: vi.fn().mockResolvedValue([
        { channelId: "ch-tg", platformAddress: "chat-42", receive: "routed" },
        { channelId: "ch-web", platformAddress: "tab-7", receive: "all" },
      ]),
      swapSession: vi.fn().mockResolvedValue({ id: "session-new" }),
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-9" }),
    });

    await dispatchScheduledFire({ runInTx, agentStore, transportStore, idleTimeoutMs }, baseArgs);

    expect(transportStore.swapSession).toHaveBeenCalledTimes(2);
    expect(transportStore.swapSession).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "ch-tg",
      "chat-42",
      { conversationId: "conv-fresh", status: "active", receive: "routed" },
    );
    expect(transportStore.swapSession).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "ch-web",
      "tab-7",
      { conversationId: "conv-fresh", status: "active", receive: "all" },
    );
  });

  it("skips with no_reachable_channel when there is nothing to rotate to", async () => {
    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue(undefined),
    });
    const transportStore = mockTransportStore({
      findReachableChannelsForUserProfile: vi.fn().mockResolvedValue([]),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toEqual({ status: "skipped", reason: "no_reachable_channel" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });

  it("skips when prior conversation is idle and no channels are reachable", async () => {
    // Don't create a stranded conversation with no sessions attached.
    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
        id: "conv-stale",
        lastMessageAt: new Date(Date.now() - 24 * 3600 * 1000),
      }),
    });
    const transportStore = mockTransportStore({
      findReachableChannelsForUserProfile: vi.fn().mockResolvedValue([]),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toEqual({ status: "skipped", reason: "no_reachable_channel" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
  });
});
