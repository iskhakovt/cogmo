import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockFilesService } from "../test/factories.js";
import { coreMemoryRead, coreMemoryUpdate } from "./core-memory-tools.js";
import type { Service } from "./service.js";

function mockService(coreOverrides?: Partial<Service["coreMemory"]>): Service {
  return {
    memory: {
      recall: vi.fn().mockResolvedValue({ memories: [] }),
      retain: vi.fn().mockResolvedValue(undefined),
      reflect: vi.fn().mockResolvedValue({ answer: "" }),
      stageRetain: vi.fn().mockResolvedValue(undefined),
    },
    files: mockFilesService(),
    coreMemory: {
      get: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue(ok({ kind: "unclassed" })),
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

  it("tells the model a restricted persona's identity is saved only there", async () => {
    const svc = mockService({
      update: vi.fn().mockResolvedValue(ok({ kind: "override", profileClass: "game" })),
    });
    const result = await coreMemoryUpdate.handler(
      { key: "identity", content: "Name: Thorin" },
      svc,
    );

    expect(result).toBe(
      'Saved "identity" for this persona only; other personas keep the shared block. ' +
        "Tell the user it is saved only here.",
    );
  });

  it("fails the call when the turn has no core memory", async () => {
    const svc = mockService({
      update: vi.fn().mockResolvedValue(err({ code: "core_memory_unavailable" })),
    });

    await expect(
      coreMemoryUpdate.handler({ key: "identity", content: "Name: Sam" }, svc),
    ).rejects.toThrow("Core memory isn't available in this profile.");
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
