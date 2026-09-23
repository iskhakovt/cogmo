/**
 * `Transport.pipelines.resolveGate` — the one place a user's gate decision
 * enters the engine, from an inline-keyboard tap or a `/gate` command.
 * Identity, liveness and the emitted event's dedup id are the contracts;
 * the stores are mocked.
 */

import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { PipelineRunStore, PipelineStore } from "../agent/pipeline/store/index.js";
import { pipelineDefinitionRow, pipelineRunRow } from "../agent/pipeline/test-fixtures.js";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import { expectDefined } from "../test/assertions.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const OWNER_HANDLE = "tg-owner";
const STRANGER_HANDLE = "tg-stranger";
const USER_ID = "019e2900-0000-7000-8000-000000000aaa";
const OTHER_USER_ID = "019e2900-0000-7000-8000-000000000bbb";
const RUN_ID = "019e2900-0000-7000-8000-000000000001";
const CONVERSATION_ID = "019e2900-0000-7000-8000-0000000000cc";

const PARKED_RUN = pipelineRunRow({
  id: RUN_ID,
  conversationId: CONVERSATION_ID,
  currentStage: "plan-gate",
  status: "waiting_gate",
});

function makeTransport(
  opts: {
    run?: ReturnType<typeof pipelineRunRow>;
    conversationUserId?: string;
    withStores?: boolean;
  } = {},
) {
  const inngest = mock<Inngest>();
  inngest.send.mockResolvedValue({ ids: [] });

  const transportStore = mockTransportStore();
  vi.mocked(transportStore.resolveUser).mockImplementation(async (_tx, _channelId, handle) =>
    handle === OWNER_HANDLE ? { userId: USER_ID } : undefined,
  );

  const agentStore: AgentStore = mockAgentStore();
  vi.mocked(agentStore.getConversation).mockResolvedValue({
    id: CONVERSATION_ID,
    userId: opts.conversationUserId ?? USER_ID,
    profileId: "019e2900-0000-7000-8000-000000000099",
    isPrivate: true,
    cooldownState: null,
    voiceMode: null,
  });

  const pipelineStore = mock<PipelineStore>();
  pipelineStore.getDefinition.mockResolvedValue(pipelineDefinitionRow());
  const pipelineRunStore = mock<PipelineRunStore>();
  const run = opts.run === undefined ? PARKED_RUN : opts.run;
  pipelineRunStore.getRun.mockResolvedValue(run);
  pipelineRunStore.findActiveRunByConversation.mockResolvedValue(run);

  const transport = createTransport({
    channelId: "ch-1",
    defaultUserId: USER_ID,
    defaultProfileId: "019e2900-0000-7000-8000-000000000099",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    ...(opts.withStores === false ? {} : { pipelineStore, pipelineRunStore }),
    inngest,
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 60_000,
  });
  return { transport, inngest, pipelineRunStore };
}

describe("pipelines.resolveGate", () => {
  it("emits the decision against the run's current cursor", async () => {
    const { transport, inngest } = makeTransport();

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ runId: RUN_ID, pipelineName: "issue-to-pr" });
    const [payload] = expectDefined(inngest.send.mock.calls[0], "gate.resolved emission");
    expect(payload).toMatchObject({
      name: "pipeline/gate.resolved",
      data: { runId: RUN_ID, stageId: "plan-gate", iteration: 0, decision: "approve" },
      id: `pipeline-gate-resolved-${RUN_ID}:plan-gate:0:approve`,
    });
  });

  it("finds the parked run by conversation for the /gate command", async () => {
    const { transport, pipelineRunStore, inngest } = makeTransport();

    const result = await transport.pipelines.resolveGate({
      target: { kind: "conversation", conversationId: CONVERSATION_ID },
      decision: "revise",
      tapperPlatformHandle: OWNER_HANDLE,
      feedback: "use staging",
    });

    expect(result.isOk()).toBe(true);
    expect(pipelineRunStore.findActiveRunByConversation).toHaveBeenCalled();
    const [payload] = expectDefined(inngest.send.mock.calls[0], "gate.resolved emission");
    expect(payload).toMatchObject({ data: { feedback: "use staging", decision: "revise" } });
  });

  it("gives a double tap on the same button one dedup id", async () => {
    const { transport, inngest } = makeTransport();
    const tap = () =>
      transport.pipelines.resolveGate({
        target: { kind: "run", runId: RUN_ID },
        decision: "approve",
        tapperPlatformHandle: OWNER_HANDLE,
      });

    await tap();
    await tap();

    const ids = inngest.send.mock.calls.map(([payload]) => (payload as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
  });

  it("gives a different decision its own id, so a change of mind is delivered", async () => {
    const { transport, inngest } = makeTransport();

    await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });
    await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "cancel",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    const ids = inngest.send.mock.calls.map(([payload]) => (payload as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  it("rejects a tap from someone who isn't the conversation's owner", async () => {
    const { transport, inngest } = makeTransport();

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: STRANGER_HANDLE,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("rejects a known user who does not own this run's conversation", async () => {
    const { transport, inngest } = makeTransport({ conversationUserId: OTHER_USER_ID });

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("reports no pending gate when the run is running rather than parked", async () => {
    const { transport, inngest } = makeTransport({
      run: pipelineRunRow({ id: RUN_ID, status: "running" }),
    });

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "no_pending_gate" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("reports no pending gate for a run id that does not exist", async () => {
    const { transport, pipelineRunStore, inngest } = makeTransport();
    pipelineRunStore.getRun.mockResolvedValue(undefined);

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: "019e2900-0000-7000-8000-00000000dead" },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "no_pending_gate" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("returns pipelines_disabled when the stores aren't wired", async () => {
    const { transport, inngest } = makeTransport({ withStores: false });

    const result = await transport.pipelines.resolveGate({
      target: { kind: "run", runId: RUN_ID },
      decision: "approve",
      tapperPlatformHandle: OWNER_HANDLE,
    });

    expect(result._unsafeUnwrapErr()).toEqual({ code: "pipelines_disabled" });
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
