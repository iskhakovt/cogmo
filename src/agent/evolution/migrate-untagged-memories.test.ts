import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import {
  type ListMemoriesPage,
  type MigrationDeps,
  migrateUntaggedMemories,
} from "./migrate-untagged-memories.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function emptyPage(): ListMemoriesPage {
  return { items: [], total: 0, limit: 100, offset: 0 };
}

function pageOf(
  items: ReadonlyArray<Record<string, unknown>>,
  total = items.length,
): ListMemoriesPage {
  return { items, total, limit: 100, offset: 0 };
}

function makeDeps(overrides: Partial<MigrationDeps> = {}): MigrationDeps {
  return {
    listMemories: vi.fn().mockResolvedValue(emptyPage()),
    clearBankMemories: vi.fn().mockResolvedValue(undefined),
    runInTx: fakeRunInTx,
    agentStore: { bulkStagePendingMemories: vi.fn().mockResolvedValue(undefined) },
    writeBackup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("migrateUntaggedMemories", () => {
  it("returns 0 and skips clear when bank is empty", async () => {
    const deps = makeDeps();

    const result = await migrateUntaggedMemories("ti", deps);

    expect(result).toEqual({ migrated: 0 });
    expect(deps.writeBackup).toHaveBeenCalledWith([]);
    expect(deps.agentStore.bulkStagePendingMemories).not.toHaveBeenCalled();
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
  });

  it("stages every memory as source=migration in a single batch and clears the bank", async () => {
    const items = [
      { text: "fact A", context: null },
      { text: "fact B", context: "while planning" },
    ];
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf(items)),
    });

    const result = await migrateUntaggedMemories("ti", deps);

    expect(result.migrated).toBe(2);
    expect(deps.agentStore.bulkStagePendingMemories).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.bulkStagePendingMemories).toHaveBeenCalledWith(expect.anything(), [
      { userId: "ti", content: "fact A", source: "migration" },
      { userId: "ti", content: "fact B", context: "while planning", source: "migration" },
    ]);
    expect(deps.clearBankMemories).toHaveBeenCalledWith("ti");
  });

  it("writes backup before staging or clearing — order matters", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ text: "fact" }])),
      writeBackup: vi.fn().mockImplementation(async () => {
        calls.push("backup");
      }),
      agentStore: {
        bulkStagePendingMemories: vi.fn().mockImplementation(async () => {
          calls.push("stage");
        }),
      },
      clearBankMemories: vi.fn().mockImplementation(async () => {
        calls.push("clear");
      }),
    });

    await migrateUntaggedMemories("ti", deps);

    expect(calls).toEqual(["backup", "stage", "clear"]);
  });

  it("does not stage or clear when backup write throws", async () => {
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ text: "fact" }])),
      writeBackup: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    await expect(migrateUntaggedMemories("ti", deps)).rejects.toThrow("disk full");

    expect(deps.agentStore.bulkStagePendingMemories).not.toHaveBeenCalled();
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
  });

  it("paginates through multiple pages and stages all in one batch", async () => {
    const listMemories = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ text: "p1-a" }, { text: "p1-b" }],
        total: 3,
        limit: 100,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [{ text: "p2-a" }],
        total: 3,
        limit: 100,
        offset: 2,
      });
    const deps = makeDeps({ listMemories });

    const result = await migrateUntaggedMemories("ti", deps);

    expect(result.migrated).toBe(3);
    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(deps.agentStore.bulkStagePendingMemories).toHaveBeenCalledTimes(1);
    expect(
      (deps.agentStore.bulkStagePendingMemories as ReturnType<typeof vi.fn>).mock.calls[0]?.[1],
    ).toHaveLength(3);
  });

  it("rejects malformed list response (no text field)", async () => {
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ wrongShape: true }])),
    });

    await expect(migrateUntaggedMemories("ti", deps)).rejects.toThrow();
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
  });
});
