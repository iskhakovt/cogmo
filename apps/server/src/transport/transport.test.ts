import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { CodingStore } from "../agent/coding/store/index.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import { createTransport, type TransportDeps } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

/** A transport with every optional dependency omitted. */
function setup(overrides: Partial<TransportDeps> = {}) {
  const transportStore = mockTransportStore();
  const agentStore = mockAgentStore();
  const transport = createTransport({
    channelId: "ch-1",
    defaultUserId: "user-1",
    defaultProfileId: "profile-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    inngest: mock<Inngest>({ send: vi.fn().mockResolvedValue({ ids: [] }) }),
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 0,
    ...overrides,
  });
  return { transport, transportStore };
}

describe("createTransport", () => {
  it('stamps sessions it opens with receive "routed" when sessionReceive is omitted', async () => {
    const { transport, transportStore } = setup();

    await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(transportStore.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receive: "routed" }),
    );
  });

  it("passes an explicit sessionReceive through", async () => {
    const { transport, transportStore } = setup({ sessionReceive: "all" });

    await transport.createConversation("addr-1", "handle-1", { isPrivate: true });

    expect(transportStore.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receive: "all" }),
    );
  });

  it("reports each omitted optional dependency as its namespace's disabled code", async () => {
    const { transport } = setup();

    expect((await transport.repos.list())._unsafeUnwrapErr()).toEqual({
      code: "sandbox_disabled",
    });
    expect((await transport.coding.approvePlan("t-1", "handle-1"))._unsafeUnwrapErr()).toEqual({
      code: "sandbox_disabled",
    });
    expect((await transport.skills.list("handle-1"))._unsafeUnwrapErr()).toEqual({
      code: "skills_disabled",
    });
    expect(
      (
        await transport.pipelines.resolveGate("r-1", "tok", "approve", "handle-1")
      )._unsafeUnwrapErr(),
    ).toEqual({ code: "pipelines_disabled" });
    expect((await transport.mcp.listServers("handle-1"))._unsafeUnwrapErr()).toEqual({
      code: "mcp_disabled",
    });
    expect(
      (await transport.evolution.triggerReflection("handle-1", "addr-1"))._unsafeUnwrapErr(),
    ).toEqual({ code: "evolution_unavailable" });
    expect(
      (await transport.conversations.compact("handle-1", "addr-1"))._unsafeUnwrapErr(),
    ).toEqual({ code: "compaction_unavailable" });
  });

  it("reports omitted secrets and repos dir as github_identity_unavailable", async () => {
    const { transport } = setup({ codingStore: mock<CodingStore>() });

    const res = await transport.repos.cloneAndAdd({ name: "x", remoteUrl: "git@x:y/z.git" });

    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "github_identity_unavailable" });
  });

  it("hands the coding store to repos and coding", async () => {
    const codingStore = mock<CodingStore>();
    codingStore.listRepos.mockResolvedValue([]);
    codingStore.getTask.mockResolvedValue(undefined);
    const { transport } = setup({ codingStore });

    expect((await transport.repos.list())._unsafeUnwrap()).toEqual([]);
    expect((await transport.coding.cancelTask("t-1", "handle-1", "r"))._unsafeUnwrapErr()).toEqual({
      code: "task_not_found",
      taskId: "t-1",
    });
  });
});
