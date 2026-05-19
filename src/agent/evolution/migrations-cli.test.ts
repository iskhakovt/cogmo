import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { Transactor } from "../../db/index.js";
import type { AgentStore } from "../store/index.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

const { hindsightCtor, listMemoriesSpy, retainBatchSpy, clearSpy, createClientSpy } = vi.hoisted(
  () => ({
    hindsightCtor: vi.fn(),
    listMemoriesSpy: vi.fn(),
    retainBatchSpy: vi.fn(),
    clearSpy: vi.fn(),
    createClientSpy: vi.fn(() => ({})),
  }),
);

vi.mock("@vectorize-io/hindsight-client", () => ({
  HindsightClient: class {
    listMemories: typeof listMemoriesSpy;
    retainBatch: typeof retainBatchSpy;
    constructor(opts: { baseUrl: string }) {
      hindsightCtor(opts);
      this.listMemories = listMemoriesSpy;
      this.retainBatch = retainBatchSpy;
    }
  },
  createClient: createClientSpy,
  createConfig: vi.fn((c: unknown) => c),
  sdk: {
    clearBankMemories: clearSpy,
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

const { migrateUntaggedMemoriesSpy, backfillProfileClassSpy } = vi.hoisted(() => ({
  migrateUntaggedMemoriesSpy: vi.fn(),
  backfillProfileClassSpy: vi.fn(),
}));

vi.mock("./migrate-untagged-memories.js", () => ({
  migrateUntaggedMemories: migrateUntaggedMemoriesSpy,
}));

vi.mock("./backfill-profile-class.js", () => ({
  backfillProfileClass: backfillProfileClassSpy,
}));

const { parseBackfillArgs, runMigrateMemoriesCli, runBackfillProfileClassCli } = await import(
  "./migrations-cli.js"
);

function buildDeps(opts: { defaultBankId?: string | null } = {}) {
  return {
    hindsightUrl: "http://hindsight:8080",
    agentStore: mock<AgentStore>(),
    runInTx: fakeRunInTx,
    resolveDefaultBankId: vi.fn(async () => opts.defaultBankId ?? null),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("parseBackfillArgs", () => {
  it("rejects when first positional isn't `profile-class`", () => {
    const r = parseBackfillArgs(["foo", "--tag=general"]);
    expect(typeof r).toBe("string");
  });

  it("rejects missing --tag", () => {
    const r = parseBackfillArgs(["profile-class"]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain("--tag");
  });

  it("rejects --tag with no values", () => {
    const r = parseBackfillArgs(["profile-class", "--tag="]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain("non-empty");
  });

  it("rejects --tag with only whitespace/commas", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=  , ,"]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain("non-empty");
  });

  it("parses single-tag form", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general"]);
    expect(r).toEqual({ classTags: ["general"], bankIdOverride: null });
  });

  it("parses comma-separated tags + dedupes whitespace", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general, legacy ,general"]);
    expect(r).toEqual({ classTags: ["general", "legacy"], bankIdOverride: null });
  });

  it("parses --bankId override", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general", "--bankId=user-42"]);
    expect(r).toEqual({ classTags: ["general"], bankIdOverride: "user-42" });
  });

  it("rejects unknown flags", () => {
    const r = parseBackfillArgs(["profile-class", "--tag=general", "--frob=baz"]);
    expect(typeof r).toBe("string");
    if (typeof r === "string") expect(r).toContain('Unknown argument "--frob=baz"');
  });
});

describe("runMigrateMemoriesCli", () => {
  it("usage-errors when no bankId arg AND no default resolves", async () => {
    const deps = buildDeps({ defaultBankId: null });
    const code = await runMigrateMemoriesCli([], deps);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Usage: cogmo migrate-memories/),
    );
    expect(migrateUntaggedMemoriesSpy).not.toHaveBeenCalled();
  });

  it("falls back to resolveDefaultBankId when no positional arg", async () => {
    const deps = buildDeps({ defaultBankId: "user-default" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 7 });

    const code = await runMigrateMemoriesCli([], deps);

    expect(code).toBe(0);
    expect(deps.resolveDefaultBankId).toHaveBeenCalledOnce();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("user-default", expect.any(Object));
  });

  it("uses the positional bankId when provided", async () => {
    const deps = buildDeps({ defaultBankId: "fallback" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    const code = await runMigrateMemoriesCli(["explicit-bank"], deps);

    expect(code).toBe(0);
    expect(deps.resolveDefaultBankId).not.toHaveBeenCalled();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("explicit-bank", expect.any(Object));
  });

  it("wires HindsightClient with the configured base URL", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    await runMigrateMemoriesCli([], deps);

    expect(hindsightCtor).toHaveBeenCalledWith({ baseUrl: "http://hindsight:8080" });
  });

  // The four tests below assert *both* that the CLI dispatch completes
  // with `code === 0` AND that the closure-built `migrationDeps.<dep>`
  // behaves correctly. The dep assertion has to run from inside the
  // mocked `migrateUntaggedMemories` implementation because that's the
  // only place the real `migrationDeps` is in scope. The CLI exit-code
  // check is the bookend that proves the dispatch didn't crash on the
  // dep's behaviour.
  it("CLI exits 0; clearBankMemories dep translates an sdk error into a thrown Error", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    let depAsserted = false;
    migrateUntaggedMemoriesSpy.mockImplementationOnce(async (_id, migrationDeps) => {
      clearSpy.mockResolvedValueOnce({ error: { detail: "boom" } });
      await expect(migrationDeps.clearBankMemories("u")).rejects.toThrow(
        /clearBankMemories failed/,
      );
      depAsserted = true;
      return { migrated: 0 };
    });

    const code = await runMigrateMemoriesCli([], deps);
    expect(code).toBe(0);
    // Confirm the inner assertion actually ran — guards against a future
    // refactor that bypasses the mock implementation entirely.
    expect(depAsserted).toBe(true);
  });

  it("CLI exits 0; clearBankMemories dep resolves to undefined on sdk success", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    let depAsserted = false;
    migrateUntaggedMemoriesSpy.mockImplementationOnce(async (_id, migrationDeps) => {
      clearSpy.mockResolvedValueOnce({ data: { ok: true } });
      await expect(migrationDeps.clearBankMemories("u")).resolves.toBeUndefined();
      depAsserted = true;
      return { migrated: 0 };
    });

    const code = await runMigrateMemoriesCli([], deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });

  it("CLI exits 0; writeBackup dep persists the staged rows", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    const fs = await import("node:fs");
    migrateUntaggedMemoriesSpy.mockImplementationOnce(async (_id, migrationDeps) => {
      await migrationDeps.writeBackup([{ text: "row" } as unknown as never]);
      return { migrated: 1 };
    });

    const code = await runMigrateMemoriesCli([], deps);
    expect(code).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/u-.*\.json$/),
      expect.any(String),
    );
  });

  it("CLI exits 0; listMemories dep proxies through HindsightClient", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    let depAsserted = false;
    migrateUntaggedMemoriesSpy.mockImplementationOnce(async (_id, migrationDeps) => {
      listMemoriesSpy.mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 });
      await migrationDeps.listMemories("u", { limit: 100, offset: 0 });
      expect(listMemoriesSpy).toHaveBeenCalledWith("u", { limit: 100, offset: 0 });
      depAsserted = true;
      return { migrated: 0 };
    });

    const code = await runMigrateMemoriesCli([], deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });
});

describe("runBackfillProfileClassCli", () => {
  it("returns 1 and prints the parse error when args are invalid", async () => {
    const code = await runBackfillProfileClassCli(["wrong-subcommand"], buildDeps());
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Usage:/));
  });

  it("usage-errors when no override AND no default resolves", async () => {
    const deps = buildDeps({ defaultBankId: null });
    const code = await runBackfillProfileClassCli(["profile-class", "--tag=general"], deps);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Usage: cogmo backfill profile-class/),
    );
  });

  it("happy path: single tag, no multi-tag probe needed", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 3, classified: 2, skipped: 1 });

    const code = await runBackfillProfileClassCli(["profile-class", "--tag=general"], deps);

    expect(code).toBe(0);
    expect(listMemoriesSpy).not.toHaveBeenCalled();
    expect(backfillProfileClassSpy).toHaveBeenCalledWith("u", expect.any(Object), {
      classTags: ["general"],
    });
  });

  it("--bankId override wins over default resolver", async () => {
    const deps = buildDeps({ defaultBankId: "fallback" });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 0, classified: 0, skipped: 0 });

    await runBackfillProfileClassCli(["profile-class", "--tag=x", "--bankId=explicit"], deps);

    expect(deps.resolveDefaultBankId).not.toHaveBeenCalled();
    expect(backfillProfileClassSpy).toHaveBeenCalledWith("explicit", expect.any(Object), {
      classTags: ["x"],
    });
  });

  it("multi-tag: probes bank and warns when classed rows already exist", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    listMemoriesSpy.mockResolvedValueOnce({
      items: [{ tags: ["profile_class:something"] }],
      total: 1,
      limit: 100,
      offset: 0,
    });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 1, classified: 0, skipped: 1 });

    const code = await runBackfillProfileClassCli(["profile-class", "--tag=general,legacy"], deps);

    expect(code).toBe(0);
    expect(listMemoriesSpy).toHaveBeenCalledWith("u", { limit: 100, offset: 0 });
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already carry a profile_class:\* tag/),
    );
  });

  it("multi-tag: no probe-warning when no rows are classed yet", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    listMemoriesSpy.mockResolvedValueOnce({
      items: [{ tags: ["network:world"] }, { tags: [] }, {}],
      total: 3,
      limit: 100,
      offset: 0,
    });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 3, classified: 3, skipped: 0 });

    await runBackfillProfileClassCli(["profile-class", "--tag=a,b"], deps);

    const warnCalls = vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    expect(warnCalls.some((s) => /already carry/.test(s))).toBe(false);
    expect(warnCalls.some((s) => /Pause Observer/.test(s))).toBe(true);
  });

  it("CLI exits 0; backfillDeps.clearBankMemories surfaces sdk error", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    let depAsserted = false;
    backfillProfileClassSpy.mockImplementationOnce(async (_id, backfillDeps) => {
      clearSpy.mockResolvedValueOnce({ error: { detail: "boom" } });
      await expect(backfillDeps.clearBankMemories("u")).rejects.toThrow(/clearBankMemories failed/);
      depAsserted = true;
      return { total: 0, classified: 0, skipped: 0 };
    });

    const code = await runBackfillProfileClassCli(["profile-class", "--tag=x"], deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });

  it("CLI exits 0; backfillDeps.retainBatch awaits async:false retain", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    let depAsserted = false;
    backfillProfileClassSpy.mockImplementationOnce(async (_id, backfillDeps) => {
      retainBatchSpy.mockResolvedValueOnce(undefined);
      await backfillDeps.retainBatch("u", [{ content: "x", tags: [], timestamp: "t" }]);
      expect(retainBatchSpy).toHaveBeenCalledWith("u", expect.any(Array), { async: false });
      depAsserted = true;
      return { total: 0, classified: 0, skipped: 0 };
    });

    const code = await runBackfillProfileClassCli(["profile-class", "--tag=x"], deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });
});
