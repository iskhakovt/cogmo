import { StepError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { notifyAfterRetries } from "./notify.js";

describe("notifyAfterRetries", () => {
  it("delivers the notice inside the named step", async () => {
    const notifyConversation = vi.fn().mockResolvedValue(undefined);
    const run = vi.fn((_id: string, body: () => Promise<unknown>) => body());

    await notifyAfterRetries(
      { run },
      "notify-completed",
      { notifyConversation },
      "conv-1",
      "done",
      { runId: "run-1" },
    );

    expect(run).toHaveBeenCalledWith("notify-completed", expect.any(Function));
    expect(notifyConversation).toHaveBeenCalledWith("conv-1", "done");
  });

  it("lets a failure escape the step body, so the step keeps its retries", async () => {
    const failure = new Error("session lookup failed");
    const notifyConversation = vi.fn().mockRejectedValue(failure);
    let bodyOutcome: unknown;
    const run = vi.fn(async (id: string, body: () => Promise<unknown>) => {
      bodyOutcome = await body().catch((e: unknown) => e);
      throw new StepError(id, bodyOutcome);
    });

    await expect(
      notifyAfterRetries({ run }, "notify", { notifyConversation }, "conv-1", "done", {
        runId: "run-1",
      }),
    ).resolves.toBeUndefined();
    // The body itself rejected: nothing inside the step swallowed the error.
    expect(bodyOutcome).toBe(failure);
  });

  it("swallows a step that failed permanently", async () => {
    const run = vi.fn().mockRejectedValue(new StepError("notify", new Error("gave up")));

    await expect(
      notifyAfterRetries({ run }, "notify", { notifyConversation: vi.fn() }, "conv-1", "done", {
        runId: "run-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("rethrows anything that isn't a permanently failed step", async () => {
    const bug = new TypeError("step.run is not a function");
    const run = vi.fn().mockRejectedValue(bug);

    await expect(
      notifyAfterRetries({ run }, "notify", { notifyConversation: vi.fn() }, "conv-1", "done", {
        runId: "run-1",
      }),
    ).rejects.toBe(bug);
  });
});
