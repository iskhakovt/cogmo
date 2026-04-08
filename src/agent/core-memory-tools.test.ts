import { describe, expect, it, vi } from "vitest";
import { coreMemoryRead, coreMemoryUpdate } from "./core-memory-tools.js";
import type { Service } from "./service.js";

function mockService(coreOverrides?: Partial<Service["coreMemory"]>): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
    },
    files: {
      read: vi.fn().mockResolvedValue(""),
      write: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(undefined),
      ...coreOverrides,
    },
  };
}

describe("core_memory_update", () => {
  it("calls service.coreMemory.update with key and content", async () => {
    const svc = mockService();
    const result = await coreMemoryUpdate.handler(
      { key: "user_profile", content: "Name: Tim" },
      svc,
    );

    expect(svc.coreMemory.update).toHaveBeenCalledWith("user_profile", "Name: Tim");
    expect(result).toContain("user_profile");
    expect(result).toContain("updated");
  });
});

describe("core_memory_read", () => {
  it("returns formatted blocks", async () => {
    const svc = mockService({
      get: vi.fn().mockResolvedValue([
        { key: "user_profile", content: "Name: Tim" },
        { key: "preferences", content: "Dark mode" },
      ]),
    });
    const result = await coreMemoryRead.handler({}, svc);

    expect(result).toContain("## user_profile");
    expect(result).toContain("Name: Tim");
    expect(result).toContain("## preferences");
    expect(result).toContain("Dark mode");
  });

  it("returns message when no blocks exist", async () => {
    const svc = mockService();
    const result = await coreMemoryRead.handler({}, svc);

    expect(result).toContain("No core memory blocks");
  });
});
