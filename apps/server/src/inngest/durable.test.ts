import { InngestTestEngine } from "@inngest/test";
import { StepError } from "inngest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mock } from "vitest-mock-extended";
import { spyOnInngestSend } from "../test/factories.js";
import { inngest } from "./client.js";
import { fromStepTools } from "./durable.js";
import { inboundReady, responseReady } from "./events.js";

type InngestStep = Parameters<typeof fromStepTools>[0];

const READY = inboundReady.create({ conversationId: "conv-1", triggerInboundId: "in-1" });

describe("fromStepTools", () => {
  it("runs the body under the step id and returns its value unchanged", async () => {
    const step = mock<InngestStep>();
    step.run.mockImplementation(async (_id, body) => body());
    const value = { messages: ["a"], cursor: null };

    const result = await fromStepTools(step).run("load", async () => value);

    expect(result).toBe(value);
    expect(step.run).toHaveBeenCalledExactlyOnceWith("load", expect.any(Function));
  });

  it("rejects with the step tool's own error, so a StepError keeps its identity", async () => {
    const step = mock<InngestStep>();
    const failed = new StepError("load", new Error("gave up after retries"));
    step.run.mockRejectedValue(failed);

    await expect(fromStepTools(step).run("load", async () => 1)).rejects.toBe(failed);
  });

  it("lets a body's error escape unwrapped", async () => {
    const step = mock<InngestStep>();
    step.run.mockImplementation(async (_id, body) => body());
    const boom = new Error("boom");

    await expect(
      fromStepTools(step).run("load", async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("sends one event or a batch under the step id", async () => {
    const step = mock<InngestStep>();
    step.sendEvent.mockResolvedValue({ ids: ["e1"] });
    const durable = fromStepTools(step);

    await expect(durable.sendEvent("emit", READY)).resolves.toBeUndefined();
    await durable.sendEvent("emit-all", [READY, READY]);

    expect(step.sendEvent.mock.calls).toEqual([
      ["emit", READY],
      ["emit-all", [READY, READY]],
    ]);
  });

  it("sleeps for the duration under the step id", async () => {
    const step = mock<InngestStep>();
    step.sleep.mockResolvedValue(undefined);

    await fromStepTools(step).sleep("wait", "3000ms");

    expect(step.sleep).toHaveBeenCalledExactlyOnceWith("wait", "3000ms");
  });

  it("waits for the event with the options it was given and resolves what Inngest delivers", async () => {
    const step = mock<InngestStep>();
    const delivered = {
      name: "response/ready",
      data: { conversationId: "conv-1", messageId: "m-1" },
      id: "evt-1",
      ts: 1,
    };
    step.waitForEvent.mockResolvedValue(delivered);
    const options = { event: responseReady, timeout: "30s" as const, if: "async.data.x == 1" };

    const received = await fromStepTools(step).waitForEvent("wait-turn", options);

    expect(received).toBe(delivered);
    expect(step.waitForEvent).toHaveBeenCalledExactlyOnceWith("wait-turn", options);
  });

  it("calls each step tool at once, without waiting a tick", () => {
    // Inngest discovers a parallel group by the steps called before the
    // body yields; a primitive that deferred its call would hide a step.
    const step = mock<InngestStep>();
    step.run.mockReturnValue(new Promise(() => {}));
    step.sendEvent.mockReturnValue(new Promise(() => {}));
    step.sleep.mockReturnValue(new Promise(() => {}));
    step.waitForEvent.mockReturnValue(new Promise(() => {}));
    const durable = fromStepTools(step);

    void durable.run("a", async () => 1);
    void durable.sendEvent("b", READY);
    void durable.sleep("c", "1s");
    void durable.waitForEvent("d", { event: responseReady, timeout: "1s", if: "true" });

    expect(step.run).toHaveBeenCalledOnce();
    expect(step.sendEvent).toHaveBeenCalledOnce();
    expect(step.sleep).toHaveBeenCalledOnce();
    expect(step.waitForEvent).toHaveBeenCalledOnce();
  });
});

describe("fromStepTools over Inngest's execution engine", () => {
  let sendSpy: ReturnType<typeof spyOnInngestSend>;

  beforeEach(() => {
    sendSpy = spyOnInngestSend(inngest).mockResolvedValue({ ids: ["fake"] });
  });

  afterEach(() => {
    sendSpy.mockRestore();
  });

  const fn = inngest.createFunction(
    { id: "durable-port-probe", triggers: [{ event: "test/durable-port" }] },
    async ({ step }) => {
      const durable = fromStepTools(step);
      const loaded = await durable.run("load", async () => ({ n: 41 }));
      await durable.sendEvent("emit", READY);
      await durable.sleep("wait", "2000ms");
      return loaded.n + 1;
    },
  );

  it("plans the same steps, in order, as the step tools called directly", async () => {
    const engine = new InngestTestEngine({ function: fn, events: [{ name: "test/durable-port" }] });

    const { result } = await engine.execute({ steps: [{ id: "wait", handler: () => null }] });

    expect(result).toBe(42);
    const { step } = await engine.executeStep("wait");
    expect(step.name).toBe("2s");
  });

  it("returns a memoized result on replay without running the body", async () => {
    const engine = new InngestTestEngine({ function: fn, events: [{ name: "test/durable-port" }] });

    const { result } = await engine.execute({
      steps: [
        { id: "load", handler: () => ({ n: 99 }) },
        { id: "wait", handler: () => null },
      ],
    });

    expect(result).toBe(100);
  });
});
