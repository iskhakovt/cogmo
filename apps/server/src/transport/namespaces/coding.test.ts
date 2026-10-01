import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../../agent/coding/store/index.js";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createCoding } from "./coding.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

describe("coding (plan-callback surface)", () => {
  const taskId = "019d0000-0000-7000-8000-000000000001";
  const conversationId = "019d0000-0000-7000-8000-000000000002";
  const ownerUserId = "user-owner";

  function buildTransport(args: {
    task: { conversationId: string | null } | null;
    conversation: { userId: string } | null;
    tapperUserId: string | null;
    approvePlanIfPending?: CodingStore["approvePlanIfPending"];
    cancelTaskIfActive?: CodingStore["cancelTaskIfActive"];
    inngestSend?: ReturnType<typeof vi.fn>;
  }) {
    const inngestSend = args.inngestSend ?? vi.fn().mockResolvedValue(undefined);
    const inngest = { send: inngestSend } as unknown as Parameters<
      typeof createCoding
    >[0]["inngest"];
    const transportStore = mockTransportStore({
      resolveUser: vi
        .fn()
        .mockResolvedValue(args.tapperUserId ? { userId: args.tapperUserId } : null),
    });
    const agentStore = mockAgentStore({
      getConversation: vi.fn().mockResolvedValue(
        args.conversation
          ? {
              id: conversationId,
              userId: args.conversation.userId,
              profileId: "p",
              isPrivate: true,
            }
          : null,
      ),
    });
    const codingStore: CodingStore = {
      ...mock<CodingStore>(),
      getTask: vi.fn().mockResolvedValue(args.task ? { id: taskId, ...args.task } : null),
      approvePlanIfPending:
        args.approvePlanIfPending ??
        vi.fn().mockResolvedValue({ kind: "approved", conversationId }),
      cancelTaskIfActive:
        args.cancelTaskIfActive ?? vi.fn().mockResolvedValue({ kind: "cancelled", conversationId }),
    };
    const coding = createCoding({
      channelId: "ch-1",
      runInTx: fakeRunInTx,
      transportStore,
      agentStore,
      codingStore,
      inngest,
    });
    return { coding, codingStore, inngestSend };
  }

  it("approvePlan: success path stamps approval, emits coding/task/plan-approved", async () => {
    const { coding, codingStore, inngestSend } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
    });

    const res = await coding.approvePlan(taskId, "owner-tg-id");

    expect(res.isOk()).toBe(true);
    expect(codingStore.approvePlanIfPending).toHaveBeenCalledWith(
      expect.anything(),
      taskId,
      expect.any(Date),
    );
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/plan-approved",
        data: expect.objectContaining({ taskId, approvedAt: expect.any(String) }),
      }),
    );
  });

  it("approvePlan: DB row and event payload carry the same approvedAt timestamp", async () => {
    // Regression for the duplicate `new Date()` calls — the event
    // claims to carry "the same timestamp downstream without a second
    // clock read", so prove the two are equal.
    const { coding, codingStore, inngestSend } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
    });

    await coding.approvePlan(taskId, "owner-tg-id");

    const storeCallDate = (codingStore.approvePlanIfPending as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[2] as Date;
    const eventArg = inngestSend.mock.calls[0]?.[0] as {
      data: { approvedAt: string };
    };
    expect(storeCallDate.toISOString()).toBe(eventArg.data.approvedAt);
  });

  it("approvePlan: a second tap recovers an emit lost after the stamp committed", async () => {
    // `coding/task/plan-approved` is the only trigger of the execute
    // orchestrator, and this method commits the stamp before sending. A
    // `send` that throws there leaves a task stamped with no event and no
    // way back — every later tap reads `already_approved`. So that arm
    // emits too, carrying the timestamp the row actually holds.
    const storedAt = new Date("2026-09-23T09:00:00.000Z");
    const { coding, inngestSend } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
      approvePlanIfPending: vi
        .fn()
        .mockResolvedValue({ kind: "already_approved", approvedAt: storedAt }),
    });

    const res = await coding.approvePlan(taskId, "owner-tg-id");

    // The toast is unchanged — the user is told it was already approved —
    // but the event goes out, which is what a double-tap relies on too.
    expect(res.isErr()).toBe(true);
    expect(inngestSend).toHaveBeenCalledTimes(1);
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "coding/task/plan-approved",
        data: { taskId, approvedAt: storedAt.toISOString() },
        id: `plan-approved-${taskId}`,
      }),
    );
  });

  it("approvePlan: not_pending emits nothing — the task left awaiting_approval", async () => {
    const { coding, inngestSend } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
      approvePlanIfPending: vi.fn().mockResolvedValue({ kind: "not_pending", status: "cancelled" }),
    });

    const res = await coding.approvePlan(taskId, "owner-tg-id");

    expect(res.isErr()).toBe(true);
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("approvePlan: identity_rejected when tapper isn't the conversation owner — no store write, no event", async () => {
    const approve = vi.fn();
    const { coding, inngestSend } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: "different-user",
      approvePlanIfPending: approve,
    });

    const res = await coding.approvePlan(taskId, "stranger-tg-id");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(approve).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });

  it("approvePlan: identity_rejected when resolveUser returns null", async () => {
    const { coding } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: null,
    });
    const res = await coding.approvePlan(taskId, "ghost-tg-id");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("approvePlan: task_already_approved on double-tap", async () => {
    const { coding } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
      approvePlanIfPending: vi
        .fn()
        .mockResolvedValue({ kind: "already_approved", approvedAt: new Date() }),
    });

    const res = await coding.approvePlan(taskId, "owner-tg-id");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "task_already_approved", taskId });
  });

  it("approvePlan: task_not_found when codingStore.getTask returns null", async () => {
    const { coding } = buildTransport({
      task: null,
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
    });
    const res = await coding.approvePlan(taskId, "owner-tg-id");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "task_not_found", taskId });
  });

  it("approvePlan: operation_not_permitted when task has no conversationId (automated trigger)", async () => {
    const { coding } = buildTransport({
      task: { conversationId: null },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
    });
    const res = await coding.approvePlan(taskId, "owner-tg-id");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "operation_not_permitted" });
  });

  it("cancelTask: success path passes the reason through to the store", async () => {
    const cancel = vi.fn().mockResolvedValue({ kind: "cancelled", conversationId });
    const { coding } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
      cancelTaskIfActive: cancel,
    });

    const res = await coding.cancelTask(taskId, "owner-tg-id", "user cancelled");
    expect(res.isOk()).toBe(true);
    expect(cancel).toHaveBeenCalledWith(expect.anything(), taskId, "user cancelled");
  });

  it("cancelTask: identity_rejected blocks store call", async () => {
    const cancel = vi.fn();
    const { coding } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: "different-user",
      cancelTaskIfActive: cancel,
    });
    const res = await coding.cancelTask(taskId, "stranger-tg-id", "x");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancelTask: task_already_terminal when the store says so", async () => {
    const cancel = vi.fn().mockResolvedValue({ kind: "already_terminal", status: "failed" });
    const { coding } = buildTransport({
      task: { conversationId },
      conversation: { userId: ownerUserId },
      tapperUserId: ownerUserId,
      cancelTaskIfActive: cancel,
    });
    const res = await coding.cancelTask(taskId, "owner-tg-id", "x");
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "task_already_terminal",
      taskId,
      status: "failed",
    });
  });

  it("returns sandbox_disabled when no codingStore is supplied", async () => {
    const coding = createCoding({
      channelId: "ch-1",
      runInTx: fakeRunInTx,
      transportStore: mockTransportStore(),
      agentStore: mockAgentStore(),
      inngest: { send: vi.fn() } as never,
      codingStore: undefined,
    });
    const a = await coding.approvePlan(taskId, "x");
    expect(a._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
    const c = await coding.cancelTask(taskId, "x", "y");
    expect(c._unsafeUnwrapErr()).toEqual({ code: "sandbox_disabled" });
  });
});
