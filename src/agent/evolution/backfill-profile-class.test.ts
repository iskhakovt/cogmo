import { describe, expect, it, vi } from "vitest";
import {
  type BackfillDeps,
  backfillProfileClass,
  type ListMemoriesPage,
} from "./backfill-profile-class.js";

function emptyPage(): ListMemoriesPage {
  return { items: [], total: 0, limit: 100, offset: 0 };
}

function pageOf(
  items: ReadonlyArray<Record<string, unknown>>,
  total = items.length,
): ListMemoriesPage {
  return { items, total, limit: 100, offset: 0 };
}

function makeDeps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
  return {
    listMemories: vi.fn().mockResolvedValue(emptyPage()),
    clearBankMemories: vi.fn().mockResolvedValue(undefined),
    retainBatch: vi.fn().mockResolvedValue(undefined),
    writeBackup: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("backfillProfileClass", () => {
  it("rejects empty classTags up front (would otherwise be a silent no-op)", async () => {
    await expect(backfillProfileClass("ti", makeDeps(), { classTags: [] })).rejects.toThrow(
      /classTags must be non-empty/,
    );
  });

  it("returns zeros and writes empty backup when bank is empty", async () => {
    const deps = makeDeps();
    const result = await backfillProfileClass("ti", deps, { classTags: ["legacy"] });
    expect(result).toEqual({ total: 0, classified: 0, skipped: 0 });
    expect(deps.writeBackup).toHaveBeenCalledWith([]);
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
    expect(deps.retainBatch).not.toHaveBeenCalled();
  });

  it("appends profile_class tags to every un-classed row and preserves originals", async () => {
    // listMemories' return shape is `text` + `date` (server-side
    // names); the function translates to `content` + `timestamp` at
    // the retain boundary.
    const items = [
      {
        text: "homelab IP is 10.0.10.10",
        tags: ["network:world", "compartment:technical", "trust:first-party"],
        date: "2026-04-01T10:00:00Z",
      },
    ];
    const deps = makeDeps({ listMemories: vi.fn().mockResolvedValue(pageOf(items)) });

    const result = await backfillProfileClass("ti", deps, { classTags: ["general", "legacy"] });

    expect(result).toEqual({ total: 1, classified: 1, skipped: 0 });
    expect(deps.clearBankMemories).toHaveBeenCalledWith("ti");
    expect(deps.retainBatch).toHaveBeenCalledWith("ti", [
      {
        content: "homelab IP is 10.0.10.10",
        tags: [
          "network:world",
          "compartment:technical",
          "trust:first-party",
          "profile_class:general",
          "profile_class:legacy",
        ],
        timestamp: "2026-04-01T10:00:00Z",
      },
    ]);
  });

  it("preserves context when present (non-empty)", async () => {
    const items = [
      {
        text: "wife's birthday March 15",
        context: "while planning",
        tags: ["network:bank", "compartment:personal", "trust:first-party"],
      },
    ];
    const deps = makeDeps({ listMemories: vi.fn().mockResolvedValue(pageOf(items)) });

    await backfillProfileClass("ti", deps, { classTags: ["general"] });

    expect(deps.retainBatch).toHaveBeenCalledWith("ti", [
      expect.objectContaining({ context: "while planning" }),
    ]);
  });

  it("treats empty-string context as no context — drops the field on retain", async () => {
    // Hindsight returns `context: ""` for absent context (not null);
    // the function normalises that so retainBatch receives no `context`
    // field rather than a literal empty string.
    const items = [{ text: "no context", context: "", tags: [] }];
    const deps = makeDeps({ listMemories: vi.fn().mockResolvedValue(pageOf(items)) });

    await backfillProfileClass("ti", deps, { classTags: ["general"] });

    const [, retained] = vi.mocked(deps.retainBatch).mock.calls[0] ?? [];
    expect("context" in (retained?.[0] ?? {})).toBe(false);
  });

  it("passes already-classed rows through unchanged (idempotent skip)", async () => {
    const items = [
      {
        text: "already classed",
        tags: ["network:world", "compartment:technical", "trust:any", "profile_class:intimate"],
      },
      {
        text: "needs class",
        tags: ["network:bank", "compartment:personal", "trust:first-party"],
      },
    ];
    const deps = makeDeps({ listMemories: vi.fn().mockResolvedValue(pageOf(items)) });

    const result = await backfillProfileClass("ti", deps, { classTags: ["general"] });

    expect(result).toEqual({ total: 2, classified: 1, skipped: 1 });
    const [, retainedItems] = vi.mocked(deps.retainBatch).mock.calls[0] ?? [];
    // Already-classed row keeps its single profile_class:intimate, nothing added.
    expect(retainedItems?.[0]?.tags).toEqual([
      "network:world",
      "compartment:technical",
      "trust:any",
      "profile_class:intimate",
    ]);
    // Un-classed row gets the new tag.
    expect(retainedItems?.[1]?.tags).toContain("profile_class:general");
  });

  it("is a full no-op when every row is already classed (no clear, no retain)", async () => {
    const items = [
      { text: "a", tags: ["profile_class:intimate"] },
      { text: "b", tags: ["profile_class:general"] },
    ];
    const deps = makeDeps({ listMemories: vi.fn().mockResolvedValue(pageOf(items)) });

    const result = await backfillProfileClass("ti", deps, { classTags: ["general"] });

    expect(result).toEqual({ total: 2, classified: 0, skipped: 2 });
    // The whole point: re-running on a fully-classed bank doesn't churn it.
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
    expect(deps.retainBatch).not.toHaveBeenCalled();
  });

  it("writes backup before any destructive op — order matters for partial-failure recovery", async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ text: "x", tags: [] }])),
      writeBackup: vi.fn().mockImplementation(async () => {
        calls.push("backup");
      }),
      clearBankMemories: vi.fn().mockImplementation(async () => {
        calls.push("clear");
      }),
      retainBatch: vi.fn().mockImplementation(async () => {
        calls.push("retain");
      }),
    });

    await backfillProfileClass("ti", deps, { classTags: ["general"] });

    expect(calls).toEqual(["backup", "clear", "retain"]);
  });

  it("does not clear or retain when backup throws", async () => {
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ text: "x", tags: [] }])),
      writeBackup: vi.fn().mockRejectedValue(new Error("disk full")),
    });

    await expect(backfillProfileClass("ti", deps, { classTags: ["general"] })).rejects.toThrow(
      "disk full",
    );

    expect(deps.clearBankMemories).not.toHaveBeenCalled();
    expect(deps.retainBatch).not.toHaveBeenCalled();
  });

  it("paginates through multiple pages and retains all in one batch", async () => {
    const listMemories = vi
      .fn()
      .mockResolvedValueOnce({
        items: [
          { text: "p1-a", tags: [] },
          { text: "p1-b", tags: [] },
        ],
        total: 3,
        limit: 100,
        offset: 0,
      })
      .mockResolvedValueOnce({
        items: [{ text: "p2-a", tags: [] }],
        total: 3,
        limit: 100,
        offset: 2,
      });
    const deps = makeDeps({ listMemories });

    const result = await backfillProfileClass("ti", deps, { classTags: ["general"] });

    expect(result.total).toBe(3);
    expect(listMemories).toHaveBeenCalledTimes(2);
    expect(deps.retainBatch).toHaveBeenCalledTimes(1);
    const [, items] = vi.mocked(deps.retainBatch).mock.calls[0] ?? [];
    expect(items).toHaveLength(3);
  });

  it("rejects malformed list response (no text field)", async () => {
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ wrongShape: true }])),
    });
    await expect(backfillProfileClass("ti", deps, { classTags: ["general"] })).rejects.toThrow();
    expect(deps.clearBankMemories).not.toHaveBeenCalled();
  });

  it("omits timestamp/metadata/context fields when absent on the source row", async () => {
    const deps = makeDeps({
      listMemories: vi.fn().mockResolvedValue(pageOf([{ text: "minimal", tags: [] }])),
    });
    await backfillProfileClass("ti", deps, { classTags: ["general"] });
    const [, items] = vi.mocked(deps.retainBatch).mock.calls[0] ?? [];
    const item = items?.[0];
    expect(item).toBeDefined();
    if (!item) throw new Error("unreachable");
    expect("timestamp" in item).toBe(false);
    expect("metadata" in item).toBe(false);
    expect("context" in item).toBe(false);
    // But tags carry the new class entry.
    expect(item.tags).toEqual(["profile_class:general"]);
  });
});
