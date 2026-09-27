import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mockFilesService } from "../test/factories.js";
import type { CoreMemoryScope } from "./core-memory/scope.js";
import { coreMemoryRead, coreMemoryUpdate, offeredBuiltIns } from "./core-memory-tools.js";
import type { Service } from "./service.js";
import { defineTool, type ToolSpec } from "./tools.js";

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
      get: vi.fn().mockResolvedValue({ scope: { kind: "unclassed" }, blocks: [] }),
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
      update: vi
        .fn()
        .mockResolvedValue(ok({ kind: "override", profileClass: "game", leftOut: [] })),
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

  it("names the lines an override left out as shared", async () => {
    const svc = mockService({
      update: vi.fn().mockResolvedValue(
        ok({
          kind: "override",
          profileClass: "game",
          leftOut: ["Name: Samuel Carter", 'Languages: English, "some" Portuguese'],
        }),
      ),
    });
    const result = await coreMemoryUpdate.handler(
      { key: "identity", content: "Name: Samuel Carter\nLocation: Lisbon" },
      svc,
    );

    expect(result).toBe(
      'Saved "identity" for this persona only, keeping the lines that differ from the shared ' +
        'block (left out as shared: "Name: Samuel Carter", "Languages: English, \\"some\\" ' +
        'Portuguese"). Tell the user it is saved only here.',
    );
  });

  it("says nothing was saved when every line of an override is shared", async () => {
    const svc = mockService({
      update: vi
        .fn()
        .mockResolvedValue(ok({ kind: "override-matches-shared", profileClass: "game" })),
    });
    const result = await coreMemoryUpdate.handler(
      { key: "identity", content: "Name: Samuel Carter" },
      svc,
    );

    expect(result).toBe(
      "Nothing saved for this persona: every line matches the shared identity block, " +
        "so this persona follows it.",
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
      get: vi.fn().mockResolvedValue({
        scope: { kind: "unclassed" },
        blocks: [
          { profileClass: null, key: "user_profile", content: "Name: Tim" },
          { profileClass: null, key: "preferences", content: "Dark mode" },
        ],
      }),
    });
    const result = await coreMemoryRead.handler({}, svc);

    expect(result).toContain("## user_profile");
    expect(result).toContain("Name: Tim");
    expect(result).toContain("## preferences");
    expect(result).toContain("Dark mode");
  });

  it("groups a classed persona's blocks as the prompt does", async () => {
    const svc = mockService({
      get: vi.fn().mockResolvedValue({
        scope: { kind: "classed", profileClass: "coder", restricted: false },
        blocks: [
          { profileClass: null, key: "identity", content: "Name: Tim" },
          { profileClass: "coder", key: "preferences", content: "Dark mode" },
        ],
      }),
    });
    const result = await coreMemoryRead.handler({}, svc);

    expect(result).toBe(
      "Shared by every persona:\n\n## identity\nName: Tim\n\n" +
        "Only in this persona:\n\n## preferences\nDark mode",
    );
  });

  it("returns message when no blocks exist", async () => {
    const svc = mockService();
    const result = await coreMemoryRead.handler({}, svc);

    expect(result).toContain("No core memory blocks");
  });
});

describe("core_memory_update routing", () => {
  it("names identity and its two routing lines", () => {
    expect(coreMemoryUpdate.description).toContain(
      "`identity` holds their name and what to call them, home, timezone and the languages " +
        "they speak, as true in every persona",
    );
    expect(coreMemoryUpdate.description).toContain(
      "a name or form of address for one persona goes in that persona's other blocks",
    );
    expect(coreMemoryUpdate.description).toContain(
      "When you write `identity`, remove from other blocks any line it now holds.",
    );
  });
});

describe("offeredBuiltIns", () => {
  const builtIns = [coreMemoryUpdate, coreMemoryRead, toolNamed("memory_recall")];

  it("drops the core-memory tools from a turn without core memory", () => {
    expect(offeredBuiltIns({ kind: "none" }, builtIns).map((t) => t.name)).toEqual([
      "memory_recall",
    ]);
  });

  it.each<CoreMemoryScope>([
    { kind: "unclassed" },
    { kind: "classed", profileClass: "game", restricted: true },
  ])("keeps them for a turn with core memory (%o)", (scope) => {
    expect(offeredBuiltIns(scope, builtIns)).toEqual(builtIns);
  });
});

function toolNamed(name: string): ToolSpec {
  return defineTool({ name, description: name, schema: z.object({}), handler: async () => "" });
}
