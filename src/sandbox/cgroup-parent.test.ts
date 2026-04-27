import { describe, expect, it } from "vitest";
import { taskSliceName } from "./cgroup-parent.js";

describe("taskSliceName", () => {
  it("produces a stable systemd slice unit name from a task id", () => {
    const taskId = "019d0000-0000-7000-8000-00000000aaaa";
    expect(taskSliceName(taskId)).toBe("cogmo-task-019d000000007000800000000000aaaa.slice");
  });

  it("strips UUID dashes so the id portion is a single token", () => {
    const slice = taskSliceName("019d1234-5678-7abc-89de-f01234567890");
    // The `cogmo-task-` prefix has its own dash; strip the prefix before
    // checking the id portion is dashless.
    expect(slice.replace(/^cogmo-task-/, "")).not.toContain("-");
    expect(slice.endsWith(".slice")).toBe(true);
  });

  it("two different task ids produce different slice names", () => {
    const a = taskSliceName("019d0000-0000-7000-8000-000000000001");
    const b = taskSliceName("019d0000-0000-7000-8000-000000000002");
    expect(a).not.toBe(b);
  });
});
