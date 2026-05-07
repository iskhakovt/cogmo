import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Service } from "../service.js";
import { delegateCodingTool } from "./tool.js";

function service(coding?: Service["coding"]): Service {
  const s = mock<Service>();
  // mock<Service>() auto-mocks every property including the optional `coding`
  // sub-service; assign explicitly so an absent argument really yields
  // undefined (the path the "no sandbox" test exercises).
  s.coding = coding;
  return s;
}

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
    const parsed = JSON.parse(result);
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
    const parsed = JSON.parse(result);
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
    const delegate = vi.fn(async () => ({ taskId: "t-1", status: "queued" as const }));
    await delegateCodingTool.handler(
      {
        goal: "refactor steering rules to support per-channel scoping",
        repo: "cogmo",
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid extra input
        triggerSource: "evolution" as any,
      },
      service({ delegate }),
    );
    expect(delegate).toHaveBeenCalledWith({
      goal: "refactor steering rules to support per-channel scoping",
      repoName: "cogmo",
    });
    expect(delegate.mock.calls[0]?.[0]).not.toHaveProperty("triggerSource");
  });
});
