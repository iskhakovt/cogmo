/**
 * Fire-handler unit tests via `InngestTestEngine`, mocking the stores.
 * Companion to `src/agent/scheduling/dispatch-fire.test.ts` — that file
 * pins the use-case logic; this one pins the Inngest wiring around it.
 */

import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { inngest } from "../../inngest/client.js";
import { mockAgentStore, mockTransportStore, spyOnInngestSend } from "../../test/factories.js";
import { buildSyntheticInboundContent } from "./dispatch-fire.js";
import { createScheduledTaskFireHandler } from "./fire-handler.js";

let sendSpy: ReturnType<typeof spyOnInngestSend>;
beforeEach(() => {
  sendSpy = spyOnInngestSend(inngest);
  sendSpy.mockResolvedValue({ ids: ["fake"] });
});
afterEach(() => {
  sendSpy.mockRestore();
  vi.useRealTimers();
});

const FAKE_TX = { __mockTx: true } as never;
const runInTx: Transactor = (cb) => cb(FAKE_TX);

const baseEvent = {
  name: "agent/scheduled-task.fire",
  data: {
    taskId: "task-1",
    userId: "user-1",
    profileId: "profile-1",
    scheduledFor: "2026-05-14T09:00:00.000Z",
    prompt: "morning briefing",
  },
} as const;

const idleTimeoutMs = 5 * 60_000;

function deps(over: {
  agent?: Parameters<typeof mockAgentStore>[0];
  transport?: Parameters<typeof mockTransportStore>[0];
}) {
  return {
    runInTx,
    agentStore: mockAgentStore(over.agent),
    transportStore: mockTransportStore(over.transport),
    idleTimeoutMs,
  };
}

describe("createScheduledTaskFireHandler", () => {
  it("reuses an engaged conversation (last message inside idle window)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T09:01:00.000Z"));

    const d = deps({
      agent: {
        findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
          id: "conv-existing",
          lastMessageAt: new Date("2026-05-14T09:00:30.000Z"), // 30s ago
        }),
      },
      transport: {
        persistInbound: vi.fn().mockResolvedValue({ id: "inbound-7" }),
      },
    });
    const fn = createScheduledTaskFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();

    expect(result).toEqual({
      status: "dispatched",
      conversationId: "conv-existing",
      inboundId: "inbound-7",
    });
    // Reuse path: no rotation
    expect(d.transportStore.findReachableChannelsForUserProfile).not.toHaveBeenCalled();
    expect(d.transportStore.swapSession).not.toHaveBeenCalled();
    expect(d.agentStore.createConversation).not.toHaveBeenCalled();

    expect(d.transportStore.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      source: "scheduled",
      scheduledFireKey: `${baseEvent.data.taskId}:${baseEvent.data.scheduledFor}`,
      conversationId: "conv-existing",
      content: buildSyntheticInboundContent(baseEvent.data.scheduledFor, baseEvent.data.prompt),
      platformTs: new Date(baseEvent.data.scheduledFor),
    });

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "inbound/arrived",
          data: { conversationId: "conv-existing", inboundMessageId: "inbound-7" },
          id: "fire:inbound-7",
        }),
      }),
    );
  });

  it("rotates to a fresh conversation when the prior one is idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T09:00:00.000Z"));

    const d = deps({
      agent: {
        findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue({
          id: "conv-stale",
          lastMessageAt: new Date("2026-05-13T22:00:00.000Z"), // ~11 hours ago
        }),
        createConversation: vi.fn().mockResolvedValue({ id: "conv-fresh" }),
      },
      transport: {
        findReachableChannelsForUserProfile: vi.fn().mockResolvedValue([
          { channelId: "ch-tg", platformAddress: "chat-42", receive: "routed" },
          { channelId: "ch-web", platformAddress: "tab-7", receive: "all" },
        ]),
        swapSession: vi.fn().mockResolvedValue({ id: "session-new" }),
        persistInbound: vi.fn().mockResolvedValue({ id: "inbound-9" }),
      },
    });
    const fn = createScheduledTaskFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();

    expect(result).toEqual({
      status: "dispatched",
      conversationId: "conv-fresh",
      inboundId: "inbound-9",
    });

    // Created a new conversation with the task's user+profile
    expect(d.agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-1",
      isPrivate: true,
    });

    // Rotated every reachable channel onto the new conversation, preserving receive mode
    expect(d.transportStore.swapSession).toHaveBeenCalledTimes(2);
    expect(d.transportStore.swapSession).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      "ch-tg",
      "chat-42",
      { conversationId: "conv-fresh", status: "active", receive: "routed" },
    );
    expect(d.transportStore.swapSession).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "ch-web",
      "tab-7",
      { conversationId: "conv-fresh", status: "active", receive: "all" },
    );

    // Synthetic inbound on the new conversation, no originating session
    expect(d.transportStore.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      source: "scheduled",
      scheduledFireKey: `${baseEvent.data.taskId}:${baseEvent.data.scheduledFor}`,
      conversationId: "conv-fresh",
      content: buildSyntheticInboundContent(baseEvent.data.scheduledFor, baseEvent.data.prompt),
      platformTs: new Date(baseEvent.data.scheduledFor),
    });
  });

  it("rotates when there is no prior conversation at all", async () => {
    const d = deps({
      agent: {
        findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue(undefined),
        createConversation: vi.fn().mockResolvedValue({ id: "conv-first" }),
      },
      transport: {
        findReachableChannelsForUserProfile: vi
          .fn()
          .mockResolvedValue([
            { channelId: "ch-tg", platformAddress: "chat-42", receive: "routed" },
          ]),
        swapSession: vi.fn().mockResolvedValue({ id: "session-new" }),
        persistInbound: vi.fn().mockResolvedValue({ id: "inbound-1" }),
      },
    });
    const fn = createScheduledTaskFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();

    expect(result).toMatchObject({ status: "dispatched", conversationId: "conv-first" });
    expect(d.transportStore.swapSession).toHaveBeenCalledTimes(1);
  });

  it("skips with reason 'no_reachable_channel' when nothing can deliver", async () => {
    const d = deps({
      agent: {
        findMostRecentConversationForUserProfile: vi.fn().mockResolvedValue(undefined),
      },
      transport: {
        findReachableChannelsForUserProfile: vi.fn().mockResolvedValue([]),
      },
    });
    const fn = createScheduledTaskFireHandler(d, inngest);

    const { result } = await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
    }).execute();

    expect(result).toEqual({ status: "skipped", reason: "no_reachable_channel" });
    expect(d.transportStore.persistInbound).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("synthetic content carries the scheduled-for timestamp header", () => {
    const content = buildSyntheticInboundContent("2026-05-14T09:00:00.000Z", "morning briefing");
    expect(content).toBe(
      "[Scheduled task — fire time was 2026-05-14T09:00:00.000Z]\n\nmorning briefing",
    );
  });

  it("pins the function configuration (event trigger, retries, concurrency)", () => {
    const fn = createScheduledTaskFireHandler(deps({}), inngest);

    expect(fn.opts.id).toBe("scheduled-task-fire");
    expect(fn.opts.retries).toBe(2);
    expect(fn.opts.concurrency).toEqual({ limit: 1, key: "event.data.taskId" });
    expect(fn.opts.triggers).toHaveLength(1);
    expect(fn.opts.triggers?.[0]).toMatchObject({ event: "agent/scheduled-task.fire" });
  });

  it("does NOT re-run dispatch when Inngest replays with a cached step result", async () => {
    // A retry that finds `dispatch` cached must NOT re-run the use case
    // — otherwise the rotation path would create a second conversation.
    const d = deps({
      agent: {
        findMostRecentConversationForUserProfile: vi
          .fn()
          .mockRejectedValue(new Error("must not run")),
        createConversation: vi.fn().mockRejectedValue(new Error("must not run")),
      },
      transport: {
        persistInbound: vi.fn().mockRejectedValue(new Error("must not run")),
      },
    });
    const fn = createScheduledTaskFireHandler(d, inngest);

    await new InngestTestEngine({
      function: fn,
      events: [baseEvent],
      steps: [
        {
          id: "dispatch",
          handler: () => ({
            status: "dispatched",
            conversationId: "conv-cached",
            inboundId: "inbound-cached",
          }),
        },
      ],
    }).execute();

    expect(d.agentStore.findMostRecentConversationForUserProfile).not.toHaveBeenCalled();
    expect(d.agentStore.createConversation).not.toHaveBeenCalled();
    expect(d.transportStore.persistInbound).not.toHaveBeenCalled();
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          name: "inbound/arrived",
          data: { conversationId: "conv-cached", inboundMessageId: "inbound-cached" },
          id: "fire:inbound-cached",
        }),
      }),
    );
  });
});
