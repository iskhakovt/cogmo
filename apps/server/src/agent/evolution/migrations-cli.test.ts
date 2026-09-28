import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { type CliIo, runCli } from "../../cli/run.js";
import type { Transactor } from "../../db/index.js";
import { expectDefined } from "../../test/assertions.js";
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

const { backfillCli, migrateMemoriesCli, runMigrateMemoriesCli, runBackfillProfileClassCli } =
  await import("./migrations-cli.js");

function buildDeps(opts: { defaultBankId?: string | null } = {}) {
  return {
    hindsightUrl: "http://hindsight:8080",
    hindsightApiKey: "test-key",
    agentStore: mock<AgentStore>(),
    runInTx: fakeRunInTx,
    resolveDefaultBankId: vi.fn(async () => opts.defaultBankId ?? null),
    verifyHindsight: vi.fn(async () => undefined),
  };
}

type Deps = ReturnType<typeof buildDeps>;

/** Drives a command tree through `runCli`, capturing what cmd-ts itself prints. */
async function runTree(
  cli: (loadDeps: () => Promise<Deps>) => Parameters<typeof runCli>[0],
  argv: readonly string[],
  deps: Deps,
) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const loadDeps = vi.fn(async () => deps);
  const code = await runCli(cli(loadDeps), argv, io);
  return { code, out: out.join("\n"), err: err.join("\n"), loadDeps };
}

const NO_BANK = { bankId: undefined };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("backfillCli", () => {
  it("rejects an unknown backfill with exit 2, loading nothing", async () => {
    const deps = buildDeps({ defaultBankId: "u" });

    const r = await runTree(backfillCli, ["profile-klass", "--tag=x"], deps);

    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Not a valid subcommand name/);
    expect(r.loadDeps).not.toHaveBeenCalled();
    expect(deps.verifyHindsight).not.toHaveBeenCalled();
  });

  it.each([
    [["profile-class"], /No value provided for --tag/],
    [["profile-class", "--tag"], /No value provided for --tag/],
    [["profile-class", "--tag="], /No value provided for --tag/],
    [
      ["profile-class", "--tag=  , ,"],
      /--tag=<a,b> must contain at least one non-empty class name/,
    ],
    [["profile-class", "--tag=x", "--bankId"], /--bankId\n\s+\^ Expected to get a value/],
    [["profile-class", "--tag=x", "--bankId=a", "--bankId=b"], /Too many times provided/],
    [["profile-class", "--tag=x", "--frob=baz"], /--frob=baz\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2, loading nothing", async (argv, message) => {
    const deps = buildDeps({ defaultBankId: "u" });

    const r = await runTree(backfillCli, argv, deps);

    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.loadDeps).not.toHaveBeenCalled();
    expect(backfillProfileClassSpy).not.toHaveBeenCalled();
  });

  it("answers --help on stdout without loading dependencies", async () => {
    const r = await runTree(backfillCli, ["profile-class", "--help"], buildDeps());

    expect(r.code).toBe(0);
    expect(r.out).toMatch(/--tag <a,b>/);
    expect(r.out).toMatch(/--bankId <bankId>/);
    expect(r.loadDeps).not.toHaveBeenCalled();
  });

  it.each([[["--tag=general, legacy ,general"]], [["--tag", "general, legacy ,general"]]])(
    "trims and de-duplicates the classes in %j",
    async (tagArgs) => {
      const deps = buildDeps({ defaultBankId: "u" });
      listMemoriesSpy.mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 });
      backfillProfileClassSpy.mockResolvedValueOnce({ total: 0, classified: 0, skipped: 0 });

      const r = await runTree(backfillCli, ["profile-class", ...tagArgs], deps);

      expect(r.code).toBe(0);
      expect(backfillProfileClassSpy).toHaveBeenCalledWith("u", expect.any(Object), {
        classTags: ["general", "legacy"],
      });
    },
  );

  it.each([[["--bankId=explicit"]], [["--bankId", "explicit"]]])(
    "backfills the bank %j names instead of the default",
    async (bankArgs) => {
      const deps = buildDeps({ defaultBankId: "fallback" });
      backfillProfileClassSpy.mockResolvedValueOnce({ total: 0, classified: 0, skipped: 0 });

      const r = await runTree(backfillCli, ["profile-class", "--tag=x", ...bankArgs], deps);

      expect(r.code).toBe(0);
      expect(deps.resolveDefaultBankId).not.toHaveBeenCalled();
      expect(backfillProfileClassSpy).toHaveBeenCalledWith("explicit", expect.any(Object), {
        classTags: ["x"],
      });
    },
  );
});

describe("migrateMemoriesCli", () => {
  it("migrates the bank it names", async () => {
    const deps = buildDeps({ defaultBankId: "fallback" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    const r = await runTree(migrateMemoriesCli, ["explicit-bank"], deps);

    expect(r.code).toBe(0);
    expect(deps.resolveDefaultBankId).not.toHaveBeenCalled();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("explicit-bank", expect.any(Object));
  });

  it("migrates the default bank when none is named", async () => {
    const deps = buildDeps({ defaultBankId: "user-default" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    const r = await runTree(migrateMemoriesCli, [], deps);

    expect(r.code).toBe(0);
    expect(deps.resolveDefaultBankId).toHaveBeenCalledOnce();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("user-default", expect.any(Object));
  });

  it.each([
    [["--frob"], /--frob\n\s+\^ Unknown arguments/],
    [["a", "b"], /b\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2, loading nothing", async (argv, message) => {
    const r = await runTree(migrateMemoriesCli, argv, buildDeps({ defaultBankId: "u" }));

    expect(r.code).toBe(2);
    expect(r.err).toMatch(message);
    expect(r.loadDeps).not.toHaveBeenCalled();
    expect(migrateUntaggedMemoriesSpy).not.toHaveBeenCalled();
  });
});

describe("Hindsight verification in the memory CLIs", () => {
  it("migrate-memories reports a usage error without probing Hindsight", async () => {
    const deps = buildDeps({ defaultBankId: null });

    expect(await runMigrateMemoriesCli(NO_BANK, deps)).toBe(1);
    expect(deps.verifyHindsight).not.toHaveBeenCalled();
    expect(hindsightCtor).not.toHaveBeenCalled();
  });

  it("backfill reports a missing bank without probing Hindsight", async () => {
    const deps = buildDeps({ defaultBankId: null });

    expect(await runBackfillProfileClassCli({ classTags: ["x"], ...NO_BANK }, deps)).toBe(1);
    expect(deps.verifyHindsight).not.toHaveBeenCalled();
    expect(hindsightCtor).not.toHaveBeenCalled();
  });

  it("migrate-memories verifies Hindsight before building a client for the bank", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    await runMigrateMemoriesCli(NO_BANK, deps);

    expect(deps.verifyHindsight).toHaveBeenCalledTimes(1);
    const verifiedAt = expectDefined(deps.verifyHindsight.mock.invocationCallOrder[0], "verify");
    const constructedAt = expectDefined(hindsightCtor.mock.invocationCallOrder[0], "client");
    expect(verifiedAt).toBeLessThan(constructedAt);
  });

  it.each([
    [
      "migrate-memories",
      (deps: ReturnType<typeof buildDeps>) => runMigrateMemoriesCli(NO_BANK, deps),
      migrateUntaggedMemoriesSpy,
    ],
    [
      "backfill",
      (deps: ReturnType<typeof buildDeps>) =>
        runBackfillProfileClassCli({ classTags: ["general"], ...NO_BANK }, deps),
      backfillProfileClassSpy,
    ],
  ])("%s touches no bank when Hindsight fails verification", async (_name, run, command) => {
    const deps = buildDeps({ defaultBankId: "u" });
    deps.verifyHindsight.mockRejectedValueOnce(new Error("hindsight auth check failed"));

    await expect(run(deps)).rejects.toThrow("hindsight auth check failed");
    expect(hindsightCtor).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
});

describe("runMigrateMemoriesCli", () => {
  it("usage-errors when no bankId arg AND no default resolves", async () => {
    const deps = buildDeps({ defaultBankId: null });
    const code = await runMigrateMemoriesCli(NO_BANK, deps);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Usage: cogmo migrate-memories/),
    );
    expect(migrateUntaggedMemoriesSpy).not.toHaveBeenCalled();
  });

  it("falls back to resolveDefaultBankId when no positional arg", async () => {
    const deps = buildDeps({ defaultBankId: "user-default" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 7 });

    const code = await runMigrateMemoriesCli(NO_BANK, deps);

    expect(code).toBe(0);
    expect(deps.resolveDefaultBankId).toHaveBeenCalledOnce();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("user-default", expect.any(Object));
  });

  it("uses the positional bankId when provided", async () => {
    const deps = buildDeps({ defaultBankId: "fallback" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    const code = await runMigrateMemoriesCli({ bankId: "explicit-bank" }, deps);

    expect(code).toBe(0);
    expect(deps.resolveDefaultBankId).not.toHaveBeenCalled();
    expect(migrateUntaggedMemoriesSpy).toHaveBeenCalledWith("explicit-bank", expect.any(Object));
  });

  it("wires HindsightClient with the configured base URL and API key", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    migrateUntaggedMemoriesSpy.mockResolvedValueOnce({ migrated: 0 });

    await runMigrateMemoriesCli(NO_BANK, deps);

    expect(hindsightCtor).toHaveBeenCalledWith({
      baseUrl: "http://hindsight:8080",
      apiKey: "test-key",
    });
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

    const code = await runMigrateMemoriesCli(NO_BANK, deps);
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

    const code = await runMigrateMemoriesCli(NO_BANK, deps);
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

    const code = await runMigrateMemoriesCli(NO_BANK, deps);
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

    const code = await runMigrateMemoriesCli(NO_BANK, deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });
});

describe("runBackfillProfileClassCli", () => {
  it("usage-errors when no override AND no default resolves", async () => {
    const deps = buildDeps({ defaultBankId: null });
    const code = await runBackfillProfileClassCli({ classTags: ["general"], ...NO_BANK }, deps);
    expect(code).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Usage: cogmo backfill profile-class/),
    );
  });

  it("happy path: single tag, no multi-tag probe needed", async () => {
    const deps = buildDeps({ defaultBankId: "u" });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 3, classified: 2, skipped: 1 });

    const code = await runBackfillProfileClassCli({ classTags: ["general"], ...NO_BANK }, deps);

    expect(code).toBe(0);
    expect(listMemoriesSpy).not.toHaveBeenCalled();
    expect(backfillProfileClassSpy).toHaveBeenCalledWith("u", expect.any(Object), {
      classTags: ["general"],
    });
  });

  it("--bankId override wins over default resolver", async () => {
    const deps = buildDeps({ defaultBankId: "fallback" });
    backfillProfileClassSpy.mockResolvedValueOnce({ total: 0, classified: 0, skipped: 0 });

    await runBackfillProfileClassCli({ classTags: ["x"], bankId: "explicit" }, deps);

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

    const code = await runBackfillProfileClassCli(
      { classTags: ["general", "legacy"], ...NO_BANK },
      deps,
    );

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

    await runBackfillProfileClassCli({ classTags: ["a", "b"], ...NO_BANK }, deps);

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

    const code = await runBackfillProfileClassCli({ classTags: ["x"], ...NO_BANK }, deps);
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

    const code = await runBackfillProfileClassCli({ classTags: ["x"], ...NO_BANK }, deps);
    expect(code).toBe(0);
    expect(depAsserted).toBe(true);
  });
});
