import { describe, expect, it, vi } from "vitest";
import { logger } from "../../logger.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { resolveSession } from "./resolve-session.js";

const FAKE_TX = { __mockTx: true } as never;
const HOUR_MS = 60 * 60 * 1000;

const activeSession = {
  id: "session-1",
  channelId: "ch-1",
  platformAddress: "addr-1",
  conversationId: "conv-1",
  status: "active" as const,
  receive: "routed" as const,
};

function stores(lastMessageAgoMs: number | null, closeOutcome?: unknown) {
  const transportStore = mockTransportStore({
    resolveSession: vi.fn().mockResolvedValue(activeSession),
    ...(closeOutcome !== undefined && { closeSession: vi.fn().mockResolvedValue(closeOutcome) }),
  });
  const agentStore = mockAgentStore({
    getLastMessageTime: vi
      .fn()
      .mockResolvedValue(
        lastMessageAgoMs === null ? null : new Date(Date.now() - lastMessageAgoMs),
      ),
  });
  return { transportStore, agentStore };
}

const args = { channelId: "ch-1", platformAddress: "addr-1", idleTimeoutMs: HOUR_MS };

describe("resolveSession", () => {
  it("returns null when the address has no active session", async () => {
    const deps = { transportStore: mockTransportStore(), agentStore: mockAgentStore() };
    expect(await resolveSession(deps, FAKE_TX, args)).toBeNull();
    expect(deps.transportStore.resolveSession).toHaveBeenCalledWith(
      expect.anything(),
      "ch-1",
      "addr-1",
    );
  });

  it("closes a session whose conversation is idle past the window and returns null", async () => {
    const deps = stores(2 * HOUR_MS);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    try {
      expect(await resolveSession(deps, FAKE_TX, args)).toBeNull();
      expect(deps.transportStore.closeSession).toHaveBeenCalledWith(expect.anything(), "session-1");
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1" }),
        expect.stringContaining("idle-expired"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("returns null and logs when the close finds the session already closed", async () => {
    const deps = stores(2 * HOUR_MS, { kind: "stale", status: "closed" });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    try {
      expect(await resolveSession(deps, FAKE_TX, args)).toBeNull();
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "session-1", kind: "stale", status: "closed" }),
        expect.stringContaining("already closed"),
      );
    } finally {
      info.mockRestore();
    }
  });

  it("returns the session when its conversation is within the window", async () => {
    const deps = stores(5 * 60 * 1000);
    expect(await resolveSession(deps, FAKE_TX, args)).toEqual(activeSession);
    expect(deps.transportStore.closeSession).not.toHaveBeenCalled();
  });

  it("returns the session when the conversation has no messages yet", async () => {
    const deps = stores(null);
    expect(await resolveSession(deps, FAKE_TX, args)).toEqual(activeSession);
  });

  it("skips the idle check when rotation is disabled", async () => {
    const deps = stores(2 * HOUR_MS);
    expect(await resolveSession(deps, FAKE_TX, { ...args, idleTimeoutMs: 0 })).toEqual(
      activeSession,
    );
    expect(deps.agentStore.getLastMessageTime).not.toHaveBeenCalled();
  });
});
