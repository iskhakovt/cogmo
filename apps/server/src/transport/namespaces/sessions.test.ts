import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { inboundArrived } from "../../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import type { AttachmentStore } from "../attachment-store.js";
import { createSessions } from "./sessions.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const activeSession = {
  id: "session-live",
  channelId: "ch-1",
  platformAddress: "addr-1",
  conversationId: "conv-live",
  status: "active" as const,
  receive: "routed" as const,
};

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
  idleTimeoutMs?: number;
  runInTx?: Transactor;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const inngestSend = vi.fn().mockResolvedValue(undefined);
  const inngest = { send: inngestSend } as any;
  const mockEvent = {
    create: vi.fn((data: any) => ({ name: "inbound/arrived", data })),
  } as unknown as typeof inboundArrived;

  const sessions = createSessions({
    channelId: "ch-1",
    runInTx: overrides?.runInTx ?? fakeRunInTx,
    transportStore,
    agentStore,
    defaultProfileId: "profile-1",
    inngest,
    inboundArrived: mockEvent,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: overrides?.idleTimeoutMs ?? 0,
    sessionReceive: "routed",
  });

  return { sessions, transportStore, agentStore, inngestSend, mockEvent };
}

describe("resolveSession", () => {
  it("runs the lookup, the idle check and any rotation in one transaction", async () => {
    const ts = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const as = mockAgentStore({
      getLastMessageTime: vi.fn().mockResolvedValue(new Date(Date.now() - 2 * 60 * 60 * 1000)),
    });
    let transactions = 0;
    const countingRunInTx: Transactor = (cb) => {
      transactions += 1;
      return cb(FAKE_TX);
    };
    const { sessions } = setup({
      transportStore: ts,
      agentStore: as,
      idleTimeoutMs: 60 * 60 * 1000,
      runInTx: countingRunInTx,
    });

    expect(await sessions.resolveSession("addr-1")).toBeNull();
    expect(ts.resolveSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
    expect(ts.closeSession).toHaveBeenCalledWith(expect.anything(), "session-live");
    expect(transactions).toBe(1);
  });
});

describe("createConversation", () => {
  it("returns identity_rejected when resolveUser returns null, touching nothing", async () => {
    const ts = mockTransportStore({ resolveUser: vi.fn().mockResolvedValue(null) });
    const { sessions, agentStore } = setup({ transportStore: ts });

    const result = await sessions.createConversation("addr-1", "unknown-user", {
      isPrivate: true,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(ts.swapSession).not.toHaveBeenCalled();
  });

  it("opens a conversation for the resolved user and swaps the free address onto it", async () => {
    const ts = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue({ userId: "resolved-user-42" }),
    });
    const { sessions, agentStore } = setup({ transportStore: ts });

    const result = await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(ts.resolveUser).toHaveBeenCalledWith(expect.anything(), "ch-1", "handle-1");
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "resolved-user-42",
      profileId: "profile-1",
      isPrivate: true,
    });
    expect(ts.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(result._unsafeUnwrap()).toEqual({
      id: "session-swapped",
      channelId: "ch-1",
      platformAddress: "addr-1",
      conversationId: "conv-1",
      status: "active",
      receive: "routed",
      profileName: "assistant",
    });
  });

  it("returns the address's active session when there is one", async () => {
    const ts = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const { sessions, agentStore } = setup({ transportStore: ts });

    const result = await sessions.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(result._unsafeUnwrap()).toMatchObject(activeSession);
    expect(agentStore.createConversation).not.toHaveBeenCalled();
    expect(ts.swapSession).not.toHaveBeenCalled();
  });

  it("with supersede, swaps the address onto the fresh conversation under the explicit profile, consulting nothing", async () => {
    const ts = mockTransportStore({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
    });
    const { sessions, agentStore } = setup({ transportStore: ts });

    const result = await sessions.createConversation("addr-1", "handle-1", {
      isPrivate: true,
      supersede: true,
      profileId: "profile-explicit",
    });

    expect(ts.resolveSession).not.toHaveBeenCalled();
    expect(ts.closeSession).not.toHaveBeenCalled();
    expect(agentStore.createConversation).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileId: "profile-explicit",
      isPrivate: true,
    });
    expect(ts.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(result._unsafeUnwrap()).toMatchObject({
      id: "session-swapped",
      conversationId: "conv-1",
      profileName: "assistant",
    });
  });
});

describe("closeSession", () => {
  it("delegates to the store transition and returns its outcome", async () => {
    const transportStore = mockTransportStore({
      closeSession: vi.fn().mockResolvedValue({ kind: "stale", status: "closed" }),
    });
    const { sessions } = setup({ transportStore });
    const outcome = await sessions.closeSession("session-1");
    expect(transportStore.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
    expect(outcome).toEqual({ kind: "stale", status: "closed" });
  });
});

describe("closeActiveSession", () => {
  it("closes by address on the scoped channel and returns the store's outcome", async () => {
    const transportStore = mockTransportStore({
      closeActiveSession: vi.fn().mockResolvedValue({ kind: "none" }),
    });
    const { sessions } = setup({ transportStore });
    const outcome = await sessions.closeActiveSession("addr-1");
    expect(transportStore.closeActiveSession).toHaveBeenCalledWith(
      expect.anything(),
      "ch-1",
      "addr-1",
    );
    expect(outcome).toEqual({ kind: "none" });
  });
});

describe("emit", () => {
  it("persists inbound and sends inngest event", async () => {
    const ts = mockTransportStore({
      lockSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "ch-1",
        platformAddress: "addr-1",
        conversationId: "conv-1",
        status: "active",
        receive: "routed",
      }),
    });
    const { sessions, inngestSend, mockEvent } = setup({ transportStore: ts });

    await sessions.emit("session-1", "hello", new Date("2026-01-01"));

    expect(ts.persistInbound).toHaveBeenCalledWith(expect.anything(), {
      channelSessionId: "session-1",
      conversationId: "conv-1",
      content: "hello",
      platformTs: new Date("2026-01-01"),
      source: "user",
    });
    expect(mockEvent.create).toHaveBeenCalledWith({
      conversationId: "conv-1",
      inboundMessageId: "inbound-1",
    });
    expect(inngestSend).toHaveBeenCalled();
  });

  it("returns session_not_found when no row exists", async () => {
    const { sessions, transportStore } = setup();
    const result = await sessions.emit("nonexistent", "hello", new Date());
    expect(result._unsafeUnwrapErr()).toEqual({
      code: "session_not_found",
      sessionId: "nonexistent",
    });
    expect(transportStore.lockSession).toHaveBeenCalledWith(expect.anything(), "nonexistent");
    expect(transportStore.getSession).not.toHaveBeenCalled();
  });

  it("refuses a closed session as session_closed instead of persisting into its superseded conversation", async () => {
    const ts = mockTransportStore({
      lockSession: vi.fn().mockResolvedValue({
        id: "session-1",
        channelId: "ch-1",
        platformAddress: "addr-1",
        conversationId: "conv-old",
        status: "closed",
        receive: "routed",
      }),
    });
    const { sessions, inngestSend } = setup({ transportStore: ts });

    const result = await sessions.emit("session-1", "hello", new Date());

    expect(result._unsafeUnwrapErr()).toEqual({ code: "session_closed", sessionId: "session-1" });
    expect(ts.persistInbound).not.toHaveBeenCalled();
    expect(inngestSend).not.toHaveBeenCalled();
  });
});

describe("resumeConversation", () => {
  const ownedPrivate = {
    getConversation: vi
      .fn()
      .mockResolvedValue({ id: "conv-1", userId: "user-1", profileId: "p1", isPrivate: true }),
  };

  it("resolves the alias for the caller and swaps the address onto the conversation", async () => {
    const agentStore = mockAgentStore({
      ...ownedPrivate,
      findConversationByAlias: vi.fn().mockResolvedValue({ conversationId: "conv-1" }),
    });
    const { sessions, transportStore } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", { alias: "work" });

    expect(agentStore.findConversationByAlias).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "work",
    );
    expect(transportStore.swapSession).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1", {
      conversationId: "conv-1",
      receive: "routed",
    });
    expect(res._unsafeUnwrap()).toMatchObject({ id: "session-swapped", conversationId: "conv-1" });
  });

  it("accepts a conversationId target directly, skipping the alias lookup", async () => {
    const agentStore = mockAgentStore(ownedPrivate);
    const { sessions } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", {
      conversationId: "conv-1",
    });

    expect(res.isOk()).toBe(true);
    expect(agentStore.findConversationByAlias).not.toHaveBeenCalled();
  });

  it("returns identity_rejected for an unknown handle", async () => {
    const ts = mockTransportStore({ resolveUser: vi.fn().mockResolvedValue(null) });
    const { sessions } = setup({ transportStore: ts });
    const res = await sessions.resumeConversation("addr-1", "nobody", { alias: "work" });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns conversation_not_found when the alias resolves to nothing", async () => {
    const { sessions } = setup();
    const res = await sessions.resumeConversation("addr-1", "handle-1", { alias: "ghost" });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
  });

  it("passes the resume transition's refusal through", async () => {
    const agentStore = mockAgentStore({
      getConversation: vi
        .fn()
        .mockResolvedValue({ id: "c1", userId: "someone-else", profileId: "p", isPrivate: true }),
    });
    const { sessions, transportStore } = setup({ agentStore });

    const res = await sessions.resumeConversation("addr-1", "handle-1", {
      conversationId: "c1",
    });

    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
    expect(transportStore.swapSession).not.toHaveBeenCalled();
  });
});
