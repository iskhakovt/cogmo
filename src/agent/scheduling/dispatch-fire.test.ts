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
  scheduledFireKey: "task-1:2026-05-14T09:00:00.000Z",
};

const idleTimeoutMs = 5 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchScheduledFire", () => {
  it("short-circuits to the existing inbound when scheduledFireKey is already used", async () => {
    // Retry-after-commit invariant: if the prior attempt committed and
    // Inngest didn't get the step ack, the inbound row is in the DB and
    // a re-run must reuse its ids rather than rotating again.
    const agentStore = mockAgentStore({
      // If reuse short-circuits correctly, neither of these runs.
      findMostRecentConversationForUserProfile: vi
        .fn()
        .mockRejectedValue(new Error("must not run on idempotency hit")),
      createConversation: vi.fn().mockRejectedValue(new Error("must not run on idempotency hit")),
    });
    const transportStore = mockTransportStore({
      findInboundByScheduledFireKey: vi
        .fn()
        .mockResolvedValue({ id: "inbound-prior", conversationId: "conv-prior" }),
      persistInbound: vi.fn().mockRejectedValue(new Error("must not run on idempotency hit")),
      swapSession: vi.fn().mockRejectedValue(new Error("must not run on idempotency hit")),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toEqual({
      status: "dispatched",
      conversationId: "conv-prior",
      inboundId: "inbound-prior",
    });
    expect(transportStore.findInboundByScheduledFireKey).toHaveBeenCalledWith(
      expect.anything(),
      baseArgs.scheduledFireKey,
    );
  });

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
      source: "scheduled",
      scheduledFireKey: baseArgs.scheduledFireKey,
      conversationId: "conv-existing",
      content: buildSyntheticInboundContent(baseArgs.scheduledFor, baseArgs.prompt),
      platformTs: new Date(baseArgs.scheduledFor),
    });
  });

  it("reuses an empty conversation (user opened it but never typed)", async () => {
    // An empty conversation usually means the user `/new`'d on this
    // profile and hasn't engaged yet. The sessions /new attached are
    // still pointing at this conv, so the fire lands cleanly and the
    // user sees "I opened a thread, then a reminder appeared" instead
    // of a stranded empty conv next to a fresh fire-conv.
    const agentStore = mockAgentStore({
      findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
        id: "conv-empty",
        lastMessageAt: null,
      }),
      // If reuse picks this path correctly, neither runs.
      createConversation: vi.fn().mockRejectedValue(new Error("must not run on reuse")),
    });
    const transportStore = mockTransportStore({
      findReachableChannelsForUserProfile: vi
        .fn()
        .mockRejectedValue(new Error("must not run on reuse")),
      swapSession: vi.fn().mockRejectedValue(new Error("must not run on reuse")),
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-9" }),
    });

    const result = await dispatchScheduledFire(
      { runInTx, agentStore, transportStore, idleTimeoutMs },
      baseArgs,
    );

    expect(result).toMatchObject({ status: "dispatched", conversationId: "conv-empty" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(transportStore.swapSession).not.toHaveBeenCalled();
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
