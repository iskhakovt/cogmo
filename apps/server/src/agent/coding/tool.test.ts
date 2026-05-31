import { describe, expect, it, type Mock, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { z } from "zod";
import type { Service } from "../service.js";
import { delegateCodingTool } from "./tool.js";

function service(coding?: Service["coding"]): Service {
  // mock<Service>() returns a Proxy that auto-mocks every property — including
  // optional `coding` and `skills`. The "no sandbox" path needs `coding` to
  // genuinely be `undefined`, so build a hand-rolled stub for the surfaces the
  // tool actually touches and add `coding` only when supplied.
  const stub: Service = {
    memory: mock<Service["memory"]>(),
    files: mock<Service["files"]>(),
    coreMemory: mock<Service["coreMemory"]>(),
    ...(coding !== undefined && { coding }),
  };
  return stub;
}

// What `delegateCodingTool.handler` returns: a JSON-encoded ack envelope.
const DelegateAckSchema = z
  .object({
    ok: z.boolean(),
    taskId: z.string().nullable().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    plan: z.string().optional(),
    nextStep: z.string().optional(),
  })
  .passthrough();

describe("delegate_coding tool", () => {
  it("calls service.coding.delegate with parsed input and returns the queued ack", async () => {
    const delegate = vi.fn(async () => ({ taskId: "t-1", status: "queued" as const }));
    const result = await delegateCodingTool.handler(
      { goal: "refactor steering rules to support per-channel scoping", repo: "cogmo" },
      service({ delegate }),
    );
    expect(delegate).toHaveBeenCalledWith({
      goal: "refactor steering rules to support per-channel scoping",
      repoName: "cogmo",
    });
    const parsed = DelegateAckSchema.parse(JSON.parse(result));
    expect(parsed.ok).toBe(true);
    expect(parsed.taskId).toBe("t-1");
    expect(parsed.status).toBe("queued");
    // The async-submit contract: tool result no longer carries a plan.
    expect(parsed.plan).toBeUndefined();
    expect(parsed.nextStep).toMatch(/separate message/);
    expect(parsed.nextStep).toMatch(/don't speculate/);
  });

  it("throws a clear error when service.coding is unavailable", async () => {
    await expect(
      delegateCodingTool.handler(
        { goal: "refactor steering rules to support per-channel scoping", repo: "cogmo" },
        service(undefined),
      ),
    ).rejects.toThrow(/sandbox module is not initialized/);
  });

  it("returns ok=false with reason on admission rejection", async () => {
    const delegate = vi.fn(async () => ({
      taskId: null,
      status: "rejected" as const,
      reason: 'Repo "cogmo" already has 1 active task(s) (limit 1).',
    }));
    const result = await delegateCodingTool.handler(
      { goal: "refactor steering rules to support per-channel scoping", repo: "cogmo" },
      service({ delegate }),
    );
    const parsed = DelegateAckSchema.parse(JSON.parse(result));
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toMatch(/active task/);
  });

  it("rejects too-short goal at the schema layer", async () => {
    await expect(
      delegateCodingTool.handler({ goal: "fix it", repo: "cogmo" }, service({ delegate: vi.fn() })),
    ).rejects.toThrow();
  });

  it("never lets the LLM choose triggerSource — tool schema strips it", async () => {
    // service.coding.delegate hardcodes triggerSource: "user". A future
    // change opening that to LLM input would silently widen the autonomy
    // boundary (an evolution / signal_pipeline trigger skips the human
    // approval gate). Pin the contract: even if the LLM passes
    // triggerSource in the input, the tool's Zod schema strips it before
    // the handler sees it, and the handler never forwards extras to
    // service.coding.delegate.
    type Delegate = NonNullable<Service["coding"]>["delegate"];
    const delegate: Mock<Delegate> = vi.fn(async () => ({
      taskId: "t-1",
      status: "queued" as const,
    }));
    await delegateCodingTool.handler(
      // The LLM-supplied `triggerSource` is intentionally not in the tool's
      // input schema — Zod strips it. Cast away the input type so the test
      // compiles while still exercising the strip behaviour.
      {
        goal: "refactor steering rules to support per-channel scoping",
        repo: "cogmo",
        triggerSource: "evolution",
      } as Parameters<typeof delegateCodingTool.handler>[0],
      service({ delegate }),
    );
    expect(delegate).toHaveBeenCalledWith({
      goal: "refactor steering rules to support per-channel scoping",
      repoName: "cogmo",
    });
    const firstCall = delegate.mock.calls[0];
    if (!firstCall) throw new Error("expected delegate to have been called");
    expect(firstCall[0]).not.toHaveProperty("triggerSource");
  });
});
