import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { StepRun } from "../../inngest/index.js";
import { logger } from "../../logger.js";
import { makeStepRun, nullStepSendEvent } from "../../test/factories.js";
import type { DeliveryRouter } from "../../transport/delivery-router.js";
import type { TransportStore } from "../../transport/store/index.js";
import type { DebounceConfig } from "../debounce.js";
import type { AgentStore, Profile } from "../store/index.js";
import type { CooldownState } from "../store/schema.js";
import { admitTurn } from "./admit-turn.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

interface Setup {
  lastAssistant?: { id: string; lastInboundMessageId: string };
  inbound?: ReadonlyArray<{ id: string; content: string; source: "user" }>;
  cooldownState?: CooldownState | null;
  resumePolicy?: DebounceConfig["resumePolicy"];
}

function setup(opts: Setup = {}) {
  const agentStore = mock<AgentStore>();
  agentStore.getConversation.mockResolvedValue({
    id: "conv",
    userId: "user",
    profileId: "profile",
    isPrivate: true,
    cooldownState: opts.cooldownState ?? null,
    voiceMode: null,
  });
  agentStore.getLastAssistantMessage.mockResolvedValue(opts.lastAssistant);
  agentStore.getProfile.mockResolvedValue(
    mock<Profile>({ model: "model-a", summarizationModel: null }),
  );
  const transportStore = mock<TransportStore>();
  transportStore.getUnbatchedInbound.mockResolvedValue(
    opts.inbound ?? [{ id: "in-2", content: "hello", source: "user" }],
  );
  const deliveryRouter = mock<DeliveryRouter>();
  const stepIds: string[] = [];
  const inline = makeStepRun();
  const run: StepRun = (idOrOptions, fn, ...input) => {
    stepIds.push(String(idOrOptions));
    return inline(idOrOptions, fn, ...input);
  };
  const step = { run, sendEvent: nullStepSendEvent() };
  const deps = {
    runInTx: fakeRunInTx,
    agentStore,
    transportStore,
    deliveryRouter,
    resumePolicy: opts.resumePolicy ?? "debounce",
  };
  return { step, stepIds, deps, agentStore, transportStore, deliveryRouter };
}

const args = (triggerInboundId: string | null) => ({
  conversationId: "conv",
  triggerInboundId,
  turnLogger: logger,
});

describe("admitTurn", () => {
  it("admits a fresh trigger with the snapshot and the unbatched batch", async () => {
    const { step, stepIds, deps, transportStore } = setup({
      lastAssistant: { id: "msg-1", lastInboundMessageId: "in-1" },
    });
    const admission = await admitTurn(step, deps, args("in-2"));
    expect(admission).toMatchObject({
      kind: "admitted",
      snapshot: { profileId: "profile", model: "model-a", summarizationModel: "model-a" },
      inboundMessages: [{ id: "in-2" }],
    });
    expect(transportStore.getUnbatchedInbound).toHaveBeenCalledWith(
      expect.anything(),
      "conv",
      "in-1",
    );
    expect(stepIds).toEqual([
      "load-conversation",
      "last-assistant",
      "load-turn-snapshot",
      "load-inbound",
    ]);
  });

  it("skips a trigger an earlier turn already consumed, before loading inbound", async () => {
    const { step, stepIds, deps } = setup({
      lastAssistant: { id: "msg-1", lastInboundMessageId: "in-5" },
    });
    expect(await admitTurn(step, deps, args("in-3"))).toEqual({ kind: "skipped", reason: "stale" });
    expect(stepIds).not.toContain("load-inbound");
  });

  it("skips a trigger older than the last reply under await_input", async () => {
    const { step, deps } = setup({
      lastAssistant: { id: "msg-5", lastInboundMessageId: "in-1" },
      resumePolicy: "await_input",
    });
    expect(await admitTurn(step, deps, args("in-2"))).toEqual({
      kind: "skipped",
      reason: "await_input",
    });
  });

  it("skips a flush with nothing unbatched", async () => {
    const { step, deps } = setup({ inbound: [] });
    expect(await admitTurn(step, deps, args(null))).toEqual({
      kind: "skipped",
      reason: "no_messages",
    });
  });

  it("replies with the cooldown notice and skips while the cooldown is open", async () => {
    const { step, stepIds, deps, deliveryRouter } = setup({
      cooldownState: {
        lastErroredAt: new Date().toISOString(),
        cooldownSeconds: 3600,
        consecutiveFailures: 1,
      },
    });
    expect(await admitTurn(step, deps, args("in-2"))).toEqual({
      kind: "skipped",
      reason: "cooldown",
    });
    expect(stepIds.at(-1)).toBe("in-cooldown-reply");
    expect(deliveryRouter.notifyConversation).toHaveBeenCalledWith("conv", expect.any(String));
  });

  it("still skips when the cooldown notice fails to send", async () => {
    const { step, deps, deliveryRouter } = setup({
      cooldownState: {
        lastErroredAt: new Date().toISOString(),
        cooldownSeconds: 3600,
        consecutiveFailures: 1,
      },
    });
    deliveryRouter.notifyConversation.mockRejectedValue(new Error("no session"));
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(await admitTurn(step, deps, args("in-2"))).toEqual({
        kind: "skipped",
        reason: "cooldown",
      });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("admits a probe turn once the cooldown has elapsed", async () => {
    const { step, deps } = setup({
      cooldownState: {
        lastErroredAt: "2020-01-01T00:00:00.000Z",
        cooldownSeconds: 60,
        consecutiveFailures: 1,
      },
    });
    expect((await admitTurn(step, deps, args("in-2"))).kind).toBe("admitted");
  });
});
