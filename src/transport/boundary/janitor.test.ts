import { InngestTestEngine } from "@inngest/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inngest } from "../../inngest/client.js";
import {
  fakeRunInTx,
  mockAgentStore,
  mockTransportStore,
  spyOnInngestSend,
} from "../../test/factories.js";
import { createBoundaryJanitor } from "./janitor.js";

// Event emission shape (dedup ids, inboundArrived per buffered entry) is
// covered by resolve-boundary.test.ts; these tests focus on the janitor
// scan + delegation contract.
describe("createBoundaryJanitor", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest);
    sendSpy.mockResolvedValue({ ids: ["fake"] });
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  it("pins the function configuration (cron, retries, concurrency)", () => {
    const fn = createBoundaryJanitor({
      runInTx: fakeRunInTx,
      transportStore: mockTransportStore(),
      agentStore: mockAgentStore(),
      inngest,
      defaultProfileId: "profile-default",
    });
    expect(fn.opts.id).toBe("boundary-janitor");
    expect(fn.opts.retries).toBe(0);
    expect(fn.opts.concurrency).toEqual({ limit: 1 });
    expect(fn.opts.triggers).toEqual([{ cron: "* * * * *" }]);
  });

  it("scans with cutoff = now − gracePeriodMs and resolves each expired row as fresh", async () => {
    const baseRow = (
      id: string,
      platformAddress: string,
    ): {
      id: string;
      channelId: string;
      platformAddress: string;
      platformUserHandle: string;
      priorConversationId: string;
      promptMessageId: string;
      bufferedInbounds: { content: string; platformTs: string }[];
      expiresAt: Date;
      createdAt: Date;
    } => ({
      id,
      channelId: "ch-1",
      platformAddress,
      platformUserHandle: "tg-7",
      priorConversationId: "conv-prior",
      promptMessageId: "tg-msg:1",
      bufferedInbounds: [{ content: "hi", platformTs: "2026-05-19T12:00:00.000Z" }],
      expiresAt: new Date("2026-05-19T11:00:00.000Z"),
      createdAt: new Date("2026-05-19T10:00:00.000Z"),
    });

    const listExpired = vi.fn().mockResolvedValue([
      { id: "b1", channelId: "ch-1", platformAddress: "chat-A" },
      { id: "b2", channelId: "ch-1", platformAddress: "chat-B" },
    ]);
    const fullRowsById = new Map([
      ["b1", baseRow("b1", "chat-A")],
      ["b2", baseRow("b2", "chat-B")],
    ]);
    const transportStore = mockTransportStore({
      listExpiredBoundaryPending: listExpired,
      getBoundaryPendingById: vi
        .fn()
        .mockImplementation(async (_tx, id: string) => fullRowsById.get(id)),
      resolveUser: vi.fn().mockResolvedValue({ userId: "u-7" }),
      createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
      persistInbound: vi.fn().mockResolvedValue({ id: "inbound-new" }),
      getChatDefaultProfile: vi.fn().mockResolvedValue(undefined),
      deleteBoundaryPending: vi.fn().mockResolvedValue(undefined),
    });
    const agentStore = mockAgentStore({
      createConversation: vi.fn().mockResolvedValue({ id: "conv-new" }),
    });

    const fn = createBoundaryJanitor({
      runInTx: fakeRunInTx,
      transportStore,
      agentStore,
      inngest,
      defaultProfileId: "profile-default",
      gracePeriodMs: 60_000,
    });

    const result = (await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
    }).execute()) as { result?: { resolved: number; scanned: number } };

    // Both rows resolved fresh — the orphan-recovery contract.
    expect(result.result).toEqual({ resolved: 2, scanned: 2 });

    // listExpiredBoundaryPending invoked once with a cutoff ~60s in the past.
    expect(listExpired).toHaveBeenCalledTimes(1);
    const cutoff = (listExpired.mock.calls[0]?.[1] as Date) ?? null;
    expect(cutoff).toBeInstanceOf(Date);
    expect(Date.now() - cutoff!.getTime()).toBeGreaterThanOrEqual(60_000 - 100);

    // Each row drained: persistInbound once per buffered entry + deleteBoundaryPending per row.
    expect(transportStore.persistInbound).toHaveBeenCalledTimes(2);
    expect(transportStore.deleteBoundaryPending).toHaveBeenCalledWith(expect.anything(), "b1");
    expect(transportStore.deleteBoundaryPending).toHaveBeenCalledWith(expect.anything(), "b2");
  });

  it("returns 0 resolved when no rows are expired", async () => {
    const fn = createBoundaryJanitor({
      runInTx: fakeRunInTx,
      transportStore: mockTransportStore({
        listExpiredBoundaryPending: vi.fn().mockResolvedValue([]),
      }),
      agentStore: mockAgentStore(),
      inngest,
      defaultProfileId: "profile-default",
    });

    const result = (await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
    }).execute()) as { result?: { resolved: number; scanned?: number } };

    expect(result.result).toEqual({ resolved: 0 });
  });

  it("treats boundary_not_found as a benign race (resolved count stays accurate)", async () => {
    // The waiter / button tap can win the race between list and resolve.
    // Janitor should not log this as an error and should not count it as
    // resolved by itself.
    const transportStore = mockTransportStore({
      listExpiredBoundaryPending: vi
        .fn()
        .mockResolvedValue([{ id: "ghost", channelId: "ch-1", platformAddress: "chat-X" }]),
      getBoundaryPendingById: vi.fn().mockResolvedValue(undefined), // already gone
    });
    const fn = createBoundaryJanitor({
      runInTx: fakeRunInTx,
      transportStore,
      agentStore: mockAgentStore(),
      inngest,
      defaultProfileId: "profile-default",
    });

    const result = (await new InngestTestEngine({
      function: fn,
      events: [{ name: "inngest/function.invoked", data: {} } as never],
    }).execute()) as { result?: { resolved: number; scanned: number } };

    expect(result.result).toEqual({ resolved: 0, scanned: 1 });
    // No drain happened — getBoundaryPendingById returned undefined.
    expect(transportStore.persistInbound).not.toHaveBeenCalled();
  });
});
