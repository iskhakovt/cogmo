/**
 * `Transport.scheduling.{list, disable, enable, delete}` — operator-facing
 * scheduled-task admin surface used by `/schedules` in the Telegram
 * adapter. Identity check, ownership enforcement, idempotency, and
 * UUID-shape rejection are the meaningful contracts; the underlying
 * `AgentStore` is mocked.
 */

import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore, ScheduledTask } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import type { TransportStore } from "./store/index.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const KNOWN_HANDLE = "tg-known";
const UNKNOWN_HANDLE = "tg-impostor";
const USER_ID = "019e2900-0000-7000-8000-000000000aaa";
const OTHER_USER_ID = "019e2900-0000-7000-8000-000000000bbb";
const TASK_ID = "019e2900-0000-7000-8000-000000000001";

function makeTransportStore(): TransportStore {
  const ts = mockTransportStore();
  vi.mocked(ts.resolveUser).mockImplementation(async (_tx, _channelId, handle) =>
    handle === KNOWN_HANDLE ? { userId: USER_ID } : undefined,
  );
  return ts;
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: TASK_ID,
    userId: USER_ID,
    profileId: "019e2900-0000-7000-8000-000000000099",
    kind: "recurring",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "morning briefing",
    nextRunAt: new Date("2026-06-01T09:00:00Z"),
    lastRunAt: null,
    enabled: true,
    catchupMissed: false,
    source: "agent",
    createdAt: new Date("2026-05-14T18:00:00Z"),
    ...overrides,
  };
}

function makeTransport(opts: { agentStore?: AgentStore; transportStore?: TransportStore } = {}) {
  const inngest = mock<Inngest>();
  inngest.send.mockResolvedValue({ ids: [] });
  return createTransport({
    channelId: "ch-1",
    defaultUserId: USER_ID,
    defaultProfileId: "019e2900-0000-7000-8000-000000000099",
    runInTx: fakeRunInTx,
    transportStore: opts.transportStore ?? makeTransportStore(),
    agentStore: opts.agentStore ?? mockAgentStore(),
    inngest,
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 60_000,
  });
}

// --- list ---------------------------------------------------------------

describe("Transport.scheduling.list", () => {
  it("returns the user's scheduled tasks as admin entries", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.listScheduledTasks).mockResolvedValue([
      makeTask({ id: TASK_ID, prompt: "a" }),
      makeTask({ id: "019e2900-0000-7000-8000-000000000002", prompt: "b", enabled: false }),
    ]);
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.list(KNOWN_HANDLE);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({ id: TASK_ID, prompt: "a", enabled: true });
    expect(result.value[1]).toMatchObject({ enabled: false });
    // Projection drops userId/profileId/source/catchupMissed.
    expect(result.value[0]).not.toHaveProperty("userId");
    expect(result.value[0]).not.toHaveProperty("profileId");
    expect(result.value[0]).not.toHaveProperty("source");
  });

  it("scopes the store call to the authenticated user", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.listScheduledTasks).mockResolvedValue([]);
    const transport = makeTransport({ agentStore });

    await transport.scheduling.list(KNOWN_HANDLE);
    expect(agentStore.listScheduledTasks).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });

  it("rejects unknown handles with identity_rejected", async () => {
    const transport = makeTransport();
    const result = await transport.scheduling.list(UNKNOWN_HANDLE);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("identity_rejected");
  });
});

// --- disable / enable ---------------------------------------------------

describe("Transport.scheduling.disable", () => {
  it("flips enabled=false on the user's own task and reports alreadyAtState=false", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ enabled: true }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.disable(KNOWN_HANDLE, TASK_ID);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value).toEqual({ id: TASK_ID, alreadyAtState: false });
    expect(agentStore.setScheduledTaskEnabled).toHaveBeenCalledWith(
      expect.anything(),
      TASK_ID,
      false,
    );
  });

  it("is idempotent on already-disabled rows (alreadyAtState=true, no store write)", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ enabled: false }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.disable(KNOWN_HANDLE, TASK_ID);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value.alreadyAtState).toBe(true);
    expect(agentStore.setScheduledTaskEnabled).not.toHaveBeenCalled();
  });

  it("refuses cross-user ids with schedule_not_found (opaque, doesn't leak existence)", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ userId: OTHER_USER_ID }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.disable(KNOWN_HANDLE, TASK_ID);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    // Same code as unknown id — adversary can't distinguish
    // "doesn't exist" from "owned by another user".
    expect(result.error).toEqual({ code: "schedule_not_found", id: TASK_ID });
    expect(agentStore.setScheduledTaskEnabled).not.toHaveBeenCalled();
  });

  it("returns schedule_not_found for unknown ids", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(undefined);
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.disable(KNOWN_HANDLE, TASK_ID);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("schedule_not_found");
  });

  it("rejects non-UUID ids with schedule_id_malformed before any DB hit", async () => {
    const agentStore = mockAgentStore();
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.disable(KNOWN_HANDLE, "not-a-uuid");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error).toEqual({ code: "schedule_id_malformed", id: "not-a-uuid" });
    // No DB calls — the UUID-shape gate fires before identity check
    // and store lookup.
    expect(agentStore.getScheduledTask).not.toHaveBeenCalled();
    expect(agentStore.setScheduledTaskEnabled).not.toHaveBeenCalled();
  });

  it("rejects unknown handles with identity_rejected (after UUID-shape check)", async () => {
    const transport = makeTransport();
    const result = await transport.scheduling.disable(UNKNOWN_HANDLE, TASK_ID);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("identity_rejected");
  });
});

describe("Transport.scheduling.enable", () => {
  it("flips enabled=true on the user's own (currently-disabled) task", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ enabled: false }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.enable(KNOWN_HANDLE, TASK_ID);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value).toEqual({ id: TASK_ID, alreadyAtState: false });
    expect(agentStore.setScheduledTaskEnabled).toHaveBeenCalledWith(
      expect.anything(),
      TASK_ID,
      true,
    );
  });

  it("is idempotent on already-enabled rows", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ enabled: true }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.enable(KNOWN_HANDLE, TASK_ID);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error("unreachable");
    expect(result.value.alreadyAtState).toBe(true);
    expect(agentStore.setScheduledTaskEnabled).not.toHaveBeenCalled();
  });
});

// --- delete -------------------------------------------------------------

describe("Transport.scheduling.delete", () => {
  it("deletes the user's own task", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask());
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.delete(KNOWN_HANDLE, TASK_ID);
    expect(result.isOk()).toBe(true);
    expect(agentStore.deleteScheduledTask).toHaveBeenCalledWith(expect.anything(), TASK_ID);
  });

  it("refuses cross-user ids", async () => {
    const agentStore = mockAgentStore();
    vi.mocked(agentStore.getScheduledTask).mockResolvedValue(makeTask({ userId: OTHER_USER_ID }));
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.delete(KNOWN_HANDLE, TASK_ID);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("schedule_not_found");
    expect(agentStore.deleteScheduledTask).not.toHaveBeenCalled();
  });

  it("rejects non-UUID ids with schedule_id_malformed before any DB hit", async () => {
    const agentStore = mockAgentStore();
    const transport = makeTransport({ agentStore });

    const result = await transport.scheduling.delete(KNOWN_HANDLE, "abc");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("schedule_id_malformed");
    expect(agentStore.getScheduledTask).not.toHaveBeenCalled();
    expect(agentStore.deleteScheduledTask).not.toHaveBeenCalled();
  });

  it("rejects unknown handles", async () => {
    const transport = makeTransport();
    const result = await transport.scheduling.delete(UNKNOWN_HANDLE, TASK_ID);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("unreachable");
    expect(result.error.code).toBe("identity_rejected");
  });
});
