import { describe, expect, it, vi } from "vitest";
import type { Service } from "../service.js";
import { delegateCodingTool } from "./tool.js";

function service(coding?: Service["coding"]): Service {
  return {
    memory: {
      recall: vi.fn(),
      retain: vi.fn(),
      reflect: vi.fn(),
    },
    files: {
      read: vi.fn(),
      write: vi.fn(),
      list: vi.fn(),
    },
    coreMemory: {
      get: vi.fn(),
      update: vi.fn(),
    },
    ...(coding !== undefined && { coding }),
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock — tests don't exercise the unused fields
  } as any;
}

describe("delegate_coding tool", () => {
  it("calls service.coding.delegate with parsed input", async () => {
    const delegate = vi.fn(async () => ({
      taskId: "t-1",
      status: "awaiting_approval" as const,
      plan: "## Plan\n1. Do X",
    }));
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
    expect(parsed.plan).toBe("## Plan\n1. Do X");
    expect(parsed.status).toBe("awaiting_approval");
    expect(parsed.nextStep).toContain("slice 2");
  });

  it("throws a clear error when service.coding is unavailable", async () => {
    await expect(
      delegateCodingTool.handler(
        { goal: "refactor steering rules to support per-channel scoping", repo: "cogmo" },
        service(undefined),
      ),
    ).rejects.toThrow(/sandbox module is not initialized/);
  });

  it("returns ok=false with reason on plan failure", async () => {
    const delegate = vi.fn(async () => ({
      taskId: "t-2",
      status: "failed" as const,
      failureReason: "claude exit code 2",
    }));
    const result = await delegateCodingTool.handler(
      { goal: "refactor steering rules to support per-channel scoping", repo: "cogmo" },
      service({ delegate }),
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.taskId).toBe("t-2");
    expect(parsed.reason).toBe("claude exit code 2");
  });

  it("rejects too-short goal at the schema layer", async () => {
    await expect(
      delegateCodingTool.handler({ goal: "fix it", repo: "cogmo" }, service({ delegate: vi.fn() })),
    ).rejects.toThrow();
  });
});
