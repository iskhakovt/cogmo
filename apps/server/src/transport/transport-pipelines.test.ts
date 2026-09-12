/**
 * `Transport.pipelines.resolveGate` — the pipeline gate keyboard's entry
 * point. Identity against the pinned definition's owner, the parked-gate
 * check, the gate key built from the run row, and the emitted decision are
 * the contracts; the run store and Inngest client are mocked.
 */

import type { Inngest } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type {
  PipelineRunRow,
  PipelineRunStore,
  PipelineRunWithDefinition,
} from "../agent/pipeline/store/index.js";
import { validPipelineDefinition } from "../agent/pipeline/test-fixtures.js";
import type { Transactor } from "../db/index.js";
import { inboundArrived } from "../inngest/events.js";
import { expectDefined } from "../test/assertions.js";
import { mockAgentStore, mockTransportStore } from "../test/factories.js";
import type { AttachmentStore } from "./attachment-store.js";
import { createTransport } from "./transport.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const OWNER_HANDLE = "tg-owner";
const OTHER_HANDLE = "tg-other";
const OWNER_ID = "019d0000-0000-7000-8000-000000000001";
const OTHER_ID = "019d0000-0000-7000-8000-000000000002";
const RUN_ID = "019d0000-0000-7000-8000-0000000000aa";

function loaded(overrides: Partial<PipelineRunRow> = {}): PipelineRunWithDefinition {
  return {
    run: {
      id: RUN_ID,
      definitionId: "def-1",
      conversationId: "conv-1",
      status: "waiting_gate",
      currentStage: "plan-gate",
      iteration: 0,
      stageOutputs: {},
      failureReason: null,
      idempotencyKey: null,
      createdAt: new Date("2026-09-12T00:00:00Z"),
      ...overrides,
    },
    definition: {
      id: "def-1",
      userId: OWNER_ID,
      name: "issue-to-pr",
      version: 1,
      sourceText: "source",
      compiled: validPipelineDefinition(),
      active: true,
      createdAt: new Date("2026-09-12T00:00:00Z"),
    },
  };
}

function makeTransport(opts: { runStore?: PipelineRunStore } = {}) {
  const transportStore = mockTransportStore();
  vi.mocked(transportStore.resolveUser).mockImplementation(async (_tx, _channelId, handle) => {
    if (handle === OWNER_HANDLE) return { userId: OWNER_ID };
    if (handle === OTHER_HANDLE) return { userId: OTHER_ID };
    return undefined;
  });
  // A plain spy for `send`: typing the whole client as a MockProxy<Inngest>
  // exceeds the compiler's instantiation depth.
  const send = vi.fn().mockResolvedValue({ ids: [] });
  const inngest = mock<Inngest>({ send });
  const transport = createTransport({
    channelId: "ch-1",
    defaultUserId: OWNER_ID,
    defaultProfileId: "019d0000-0000-7000-8000-000000000099",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore: mockAgentStore(),
    ...(opts.runStore !== undefined && { pipelineRunStore: opts.runStore }),
    inngest,
    inboundArrived,
    attachments: mock<AttachmentStore>(),
    idleTimeoutMs: 60_000,
  });
  return { transport, send };
}

describe("Transport.pipelines.resolveGate", () => {
  it.each([
    ["approve", "approved"],
    ["cancel", "cancelled"],
  ] as const)(
    "%s by the owner emits gate.resolved as %s for the parked gate",
    async (action, decision) => {
      const runStore = mock<PipelineRunStore>();
      runStore.getRunWithDefinition.mockResolvedValue(loaded());
      const { transport, send } = makeTransport({ runStore });

      const result = await transport.pipelines.resolveGate(RUN_ID, action, OWNER_HANDLE);

      expect(result._unsafeUnwrap()).toEqual({
        runId: RUN_ID,
        pipelineName: "issue-to-pr",
        stageId: "plan-gate",
      });
      expect(send).toHaveBeenCalledTimes(1);
      const sent = expectDefined(send.mock.calls[0], "send call")[0];
      expect(sent).toMatchObject({
        name: "pipeline/gate.resolved",
        data: { runId: RUN_ID, gateKey: `${RUN_ID}:plan-gate:0`, decision },
      });
      // Not bus-deduped: a tap racing the gate's timeout must reach the
      // resolver so its conditional transition can pick the winner.
      expect(sent).not.toMatchObject({ id: expect.anything() });
    },
  );

  it("builds the gate key from the run's current stage and iteration, not the tap", async () => {
    const runStore = mock<PipelineRunStore>();
    runStore.getRunWithDefinition.mockResolvedValue(
      loaded({ currentStage: "sign-off", iteration: 2 }),
    );
    const { transport, send } = makeTransport({ runStore });

    await transport.pipelines.resolveGate(RUN_ID, "approve", OWNER_HANDLE);

    expect(expectDefined(send.mock.calls[0], "send call")[0]).toMatchObject({
      data: { gateKey: `${RUN_ID}:sign-off:2` },
    });
  });

  it("rejects a tapper who does not own the pipeline, without emitting", async () => {
    const runStore = mock<PipelineRunStore>();
    runStore.getRunWithDefinition.mockResolvedValue(loaded());
    const { transport, send } = makeTransport({ runStore });

    for (const handle of [OTHER_HANDLE, "tg-unknown"]) {
      const result = await transport.pipelines.resolveGate(RUN_ID, "approve", handle);
      expect(result._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("answers a late tap with the run's actual status, without emitting", async () => {
    const runStore = mock<PipelineRunStore>();
    runStore.getRunWithDefinition.mockResolvedValue(loaded({ status: "cancelled" }));
    const { transport, send } = makeTransport({ runStore });

    const result = await transport.pipelines.resolveGate(RUN_ID, "approve", OWNER_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({
      code: "pipeline_gate_not_pending",
      runId: RUN_ID,
      status: "cancelled",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports an unknown run", async () => {
    const runStore = mock<PipelineRunStore>();
    runStore.getRunWithDefinition.mockResolvedValue(undefined);
    const { transport } = makeTransport({ runStore });

    const result = await transport.pipelines.resolveGate(RUN_ID, "cancel", OWNER_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({ code: "pipeline_run_not_found", runId: RUN_ID });
  });

  it("returns pipelines_disabled when no run store is wired", async () => {
    const { transport, send } = makeTransport();

    const result = await transport.pipelines.resolveGate(RUN_ID, "approve", OWNER_HANDLE);

    expect(result._unsafeUnwrapErr()).toEqual({ code: "pipelines_disabled" });
    expect(send).not.toHaveBeenCalled();
  });
});
