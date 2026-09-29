import { afterEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import { installLiveCatalog } from "../llm/litellm-data.js";
import { captureIo, fakeRunInTx } from "../test/factories.js";
import { type ModelCliDeps, modelCli } from "./model.js";
import { type CliIo, type LoadDeps, runCli } from "./run.js";

type Provider = Awaited<ReturnType<AgentStore["listProviders"]>>[number];
type RoutingRow = Awaited<ReturnType<AgentStore["listProvidersForModel"]>>[number];

function run(argv: readonly string[], deps: ModelCliDeps, io: CliIo): Promise<number> {
  return runCli(
    modelCli(io, async () => deps),
    argv,
    io,
  );
}

function provider(id: string, name: string): Provider {
  return { id, name, type: "openai_compatible", baseUrl: null, attrs: {} };
}

function routingRow(
  id: string,
  name: string,
  position: number,
  limits: Partial<Pick<RoutingRow, "contextWindow" | "maxOutputTokens">> = {},
): RoutingRow {
  return {
    id,
    name,
    type: "anthropic",
    baseUrl: null,
    secretId: "s",
    attrs: {},
    position,
    contextWindow: null,
    maxOutputTokens: null,
    ...limits,
  };
}

function makeDeps(
  opts: {
    providers?: ReadonlyArray<Provider>;
    rowsByModel?: Record<string, ReadonlyArray<RoutingRow>>;
    requestCatalogRefresh?: ModelCliDeps["requestCatalogRefresh"];
  } = {},
) {
  const rowsByModel = opts.rowsByModel ?? {};
  const agentStore = mock<AgentStore>();
  agentStore.listProviders.mockResolvedValue(opts.providers ?? []);
  agentStore.listProvidersForModel.mockImplementation(
    async (_tx, model) => rowsByModel[model] ?? [],
  );
  agentStore.listAllModelProviders.mockResolvedValue(
    Object.entries(rowsByModel).flatMap(([model, rows]) => rows.map((row) => ({ model, ...row }))),
  );
  agentStore.addModelProvider.mockResolvedValue({ id: "row-1" });
  agentStore.getNextModelProviderPosition.mockResolvedValue(0);
  return {
    runInTx: fakeRunInTx,
    agentStore,
    requestCatalogRefresh:
      opts.requestCatalogRefresh === undefined ? vi.fn(async () => {}) : opts.requestCatalogRefresh,
    loadLiveCatalog: vi.fn(async () => {}),
  };
}

describe("cogmo model — usage", () => {
  it.each([
    [[]],
    [["--help"]],
    [["add", "--help"]],
    [["list", "--help"]],
    [["remove", "--help"]],
    [["refresh", "--help"]],
  ])("prints help for %j on stdout, exits 0, and loads nothing", async (argv) => {
    const loadDeps = vi.fn<LoadDeps<ModelCliDeps>>(async () => makeDeps());
    const { io, out, err } = captureIo();

    const code = await runCli(modelCli(io, loadDeps), argv, io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/^model/);
    expect(err).toEqual([]);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("documents every add option", async () => {
    const { io, out } = captureIo();

    await run(["add", "--help"], makeDeps(), io);

    for (const flag of ["--provider", "--context", "--max-output", "--position"]) {
      expect(out.join("\n")).toContain(flag);
    }
  });
});

describe("cogmo model add", () => {
  it("rejects when --provider is missing", async () => {
    const loadDeps = vi.fn<LoadDeps<ModelCliDeps>>(async () => makeDeps());
    const { io, err } = captureIo();

    const code = await runCli(modelCli(io, loadDeps), ["add", "x-ai/grok-4.3"], io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for --provider/);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("rejects when the provider is not registered", async () => {
    const { io, err } = captureIo();
    const code = await run(["add", "x-ai/grok-4.3", "--provider", "missing"], makeDeps(), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No provider named "missing"/);
  });

  it("inserts a row and reports effective limits sourced from LiteLLM when no overrides given", async () => {
    const deps = makeDeps({ providers: [provider("p1", "openrouter")] });
    const { io, out } = captureIo();
    const code = await run(["add", "x-ai/grok-4.3", "--provider", "openrouter"], deps, io);
    expect(code).toBe(0);
    // Resolver finds x-ai/grok-4.3 in the bundled LiteLLM snapshot.
    expect(out.join("\n")).toMatch(/context=\d+ \(litellm\)/);
    expect(out.join("\n")).toMatch(/max_output=\d+ \(litellm\)/);
    expect(out.join("\n")).toMatch(/Restart `cogmo serve`/);
    expect(deps.agentStore.addModelProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "x-ai/grok-4.3",
        providerId: "p1",
        contextWindow: null,
        maxOutputTokens: null,
      }),
    );
  });

  it("threads --context and --max-output as explicit overrides", async () => {
    const deps = makeDeps({ providers: [provider("p1", "vllm")] });
    const { io, out } = captureIo();
    const code = await run(
      [
        "add",
        "my/local-llama-fine-tune",
        "--provider",
        "vllm",
        "--context",
        "200000",
        "--max-output",
        "8000",
      ],
      deps,
      io,
    );
    expect(code).toBe(0);
    expect(deps.agentStore.addModelProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
      }),
    );
    // Both columns came from the row override (no LiteLLM entry for the
    // local fine-tune slug); per-column sources both render `(db)`.
    expect(out.join("\n")).toMatch(/context=200000 \(db\)/);
    expect(out.join("\n")).toMatch(/max_output=8000 \(db\)/);
  });

  it("accepts --position 0, the primary routing slot", async () => {
    const deps = makeDeps({ providers: [provider("p1", "vllm")] });
    const { io } = captureIo();
    const code = await run(["add", "m", "--provider", "vllm", "--position", "0"], deps, io);
    expect(code).toBe(0);
    expect(deps.agentStore.addModelProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ position: 0 }),
    );
  });

  it("`--position N` round-trips into addModelRouting", async () => {
    const deps = makeDeps({ providers: [provider("p1", "openrouter")] });
    const { io } = captureIo();
    const code = await run(["add", "m", "--provider", "openrouter", "--position", "3"], deps, io);
    expect(code).toBe(0);
    expect(deps.agentStore.addModelProvider).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ position: 3 }),
    );
  });

  it("surfaces addModelRouting errors as exit code 1", async () => {
    const deps = makeDeps({ providers: [provider("p1", "openrouter")] });
    deps.agentStore.addModelProvider.mockRejectedValue(new Error("conflicting position"));
    const { io, err } = captureIo();
    const code = await run(["add", "m", "--provider", "openrouter"], deps, io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Failed to add model routing: conflicting position/);
  });
});

describe("cogmo model list", () => {
  it("prints (no model routing rows) when empty", async () => {
    const { io, out } = captureIo();
    const code = await run(["list"], makeDeps(), io);
    expect(code).toBe(0);
    expect(out).toContain("(no model routing rows)");
  });

  it("renders one tab-separated line per (model, provider) row with effective limits", async () => {
    const deps = makeDeps({
      rowsByModel: { "claude-sonnet-4-6": [routingRow("r1", "anthropic", 0)] },
    });
    const { io, out } = captureIo();
    await run(["list"], deps, io);
    // Header + one row; the catalog line goes to stderr.
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/model\tprovider\tposition\tcontext\tmax_output\tsource/);
    // Both columns came from LiteLLM → source collapses to the shared tag.
    expect(out[1]).toMatch(/^claude-sonnet-4-6\tanthropic\t0\t1000000\t64000\tlitellm$/);
  });

  describe("catalog line", () => {
    afterEach(() => installLiveCatalog(null));

    const deps = () =>
      makeDeps({ rowsByModel: { "claude-sonnet-4-6": [routingRow("r1", "anthropic", 0)] } });

    it("says on stderr that limits come from the bundled snapshot before any refresh", async () => {
      const { io, err } = captureIo();
      await run(["list"], deps(), io);
      expect(err).toEqual([
        "litellm: bundled snapshot only; no catalog refresh has run (`cogmo model refresh`)",
      ]);
    });

    it("says the refresh is off rather than pointing at `cogmo model refresh`", async () => {
      const { io, err } = captureIo();
      await run(
        ["list"],
        makeDeps({
          rowsByModel: { "claude-sonnet-4-6": [routingRow("r1", "anthropic", 0)] },
          requestCatalogRefresh: null,
        }),
        io,
      );
      expect(err).toEqual([
        "litellm: bundled snapshot only; the catalog refresh is off (MODEL_CATALOG_URL=off)",
      ]);
    });

    it("loads the stored catalog before resolving limits", async () => {
      const d = deps();
      const { io } = captureIo();
      await run(["list"], d, io);
      expect(d.loadLiveCatalog).toHaveBeenCalledTimes(1);
    });

    it("names the live catalog's fetch time and size once one is installed", async () => {
      installLiveCatalog({
        entries: { "claude-sonnet-4-6": { contextWindow: 1_000_000, maxOutputTokens: 64_000 } },
        fetchedAt: new Date("2026-09-28T06:17:00.000Z"),
      });
      const { io, err } = captureIo();
      await run(["list"], deps(), io);
      expect(err).toEqual([
        "litellm: catalog fetched 2026-09-28T06:17:00.000Z (1 models), bundled snapshot behind it",
      ]);
    });
  });

  it("renders a split `cw=…,mo=…` source tag when the two columns disagree", async () => {
    // Partial override: row pins maxOutputTokens but leaves contextWindow
    // to LiteLLM. The list view shows both sources so the operator sees
    // the LiteLLM contribution they'd otherwise have missed.
    const deps = makeDeps({
      rowsByModel: {
        "claude-sonnet-4-6": [routingRow("r1", "anthropic", 0, { maxOutputTokens: 8_000 })],
      },
    });
    const { io, out } = captureIo();
    await run(["list"], deps, io);
    expect(out[1]).toMatch(/^claude-sonnet-4-6\tanthropic\t0\t1000000\t8000\tcw=litellm,mo=db$/);
  });

  it("displays the stored position, not the array index, when positions are non-sequential", async () => {
    // A lone row at position 5: the array index would render 0.
    const deps = makeDeps({ rowsByModel: { m: [routingRow("r1", "p", 5)] } });
    const { io, out } = captureIo();
    await run(["list"], deps, io);
    expect(out[1]).toMatch(/^m\tp\t5\t/);
  });

  it("uses one query for the whole routing table — no per-model fanout", async () => {
    const deps = makeDeps({
      rowsByModel: {
        m1: [routingRow("r1", "p", 0)],
        m2: [routingRow("r2", "p", 0)],
        m3: [routingRow("r3", "p", 0)],
      },
    });
    const { io } = captureIo();
    await run(["list"], deps, io);
    expect(deps.agentStore.listAllModelProviders).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.listProvidersForModel).not.toHaveBeenCalled();
  });

  it("--model + --provider filter narrows the output", async () => {
    const deps = makeDeps({
      rowsByModel: { a: [routingRow("r1", "p1", 0)], b: [routingRow("r2", "p2", 0)] },
    });
    const { io, out } = captureIo();
    await run(["list", "--model", "a", "--provider", "p1"], deps, io);
    expect(out.join("\n")).toContain("a\tp1");
    expect(out.join("\n")).not.toContain("b\tp2");
  });
});

describe("cogmo model remove", () => {
  it("removes one row when --provider is given", async () => {
    const deps = makeDeps({
      rowsByModel: { m: [routingRow("r1", "p1", 0), routingRow("r2", "p2", 1)] },
    });
    const { io } = captureIo();
    const code = await run(["remove", "m", "--provider", "p2"], deps, io);
    expect(code).toBe(0);
    expect(deps.agentStore.removeModelProvider).toHaveBeenCalledTimes(1);
    expect(deps.agentStore.removeModelProvider).toHaveBeenCalledWith(expect.anything(), "m", "r2");
  });

  it("removes every row for the model in one transaction when --provider is omitted", async () => {
    const deps = makeDeps({
      rowsByModel: { m: [routingRow("r1", "p1", 0), routingRow("r2", "p2", 1)] },
    });
    const runInTx = vi.spyOn(deps, "runInTx");
    const { io } = captureIo();
    const code = await run(["remove", "m"], deps, io);
    expect(code).toBe(0);
    expect(deps.agentStore.removeModelProvider).toHaveBeenCalledTimes(2);
    // Both deletes share one outer transaction; the initial
    // `listProvidersForModel` call is its own tx.
    expect(runInTx).toHaveBeenCalledTimes(2);
  });

  it("returns 1 when the model has no routing rows", async () => {
    const { io, err } = captureIo();
    const code = await run(["remove", "ghost"], makeDeps(), io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No routing rows for model "ghost"/);
  });

  it("returns 1 when the model isn't routed via --provider", async () => {
    const deps = makeDeps({ rowsByModel: { m: [routingRow("r1", "p1", 0)] } });
    const { io, err } = captureIo();
    const code = await run(["remove", "m", "--provider", "p-other"], deps, io);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not routed via provider "p-other"/);
    expect(deps.agentStore.removeModelProvider).not.toHaveBeenCalled();
  });
});

describe("cogmo model refresh", () => {
  it("sends the refresh request", async () => {
    const requestCatalogRefresh = vi.fn(async () => {});
    const { io, out, err } = captureIo();

    const code = await run(["refresh"], makeDeps({ requestCatalogRefresh }), io);

    expect(code).toBe(0);
    expect(requestCatalogRefresh).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatch(/Requested a model catalog refresh/);
    expect(err).toEqual([]);
  });

  it("exits 1 when the refresh is off", async () => {
    const { io, out, err } = captureIo();

    const code = await run(["refresh"], makeDeps({ requestCatalogRefresh: null }), io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/MODEL_CATALOG_URL=off/);
    expect(out).toEqual([]);
  });

  it("exits 1 when the request can't be sent", async () => {
    const requestCatalogRefresh = vi.fn(async () => {
      throw new Error("Inngest unreachable");
    });
    const { io, err } = captureIo();

    const code = await run(["refresh"], makeDeps({ requestCatalogRefresh }), io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Inngest unreachable/);
  });
});

describe("cogmo model — rejected command lines", () => {
  it.each([
    [["bogus"], /bogus\n\s+\^ Not a valid subcommand name/],
    [["help"], /help\n\s+\^ Not a valid subcommand name/],
    [["add"], /No value provided for model-id/],
    [["remove"], /No value provided for model-id/],
    [["remove", "--provider", "p"], /No value provided for model-id/],
    // A flag after an identifier option is read as its value, then refused.
    [
      ["add", "x-ai/grok-4.3", "--provider", "--context", "200000"],
      /expected a value, got the flag "--context"/,
    ],
    [["list", "--provider", "--model", "a"], /expected a value, got the flag "--model"/],
    [["remove", "m", "--provider", "--all"], /expected a value, got the flag "--all"/],
    [["add", "x-ai/grok-4.3", "--provider"], /No value provided for --provider/],
    // An optional option given no value is refused, not read as omitted.
    [["add", "m", "--provider", "vllm", "--context"], /Expected to get a value, found a flag/],
    [["add", "m", "--provider", "vllm", "--max-output"], /Expected to get a value, found a flag/],
    [["add", "m", "--provider", "vllm", "--position"], /Expected to get a value, found a flag/],
    [["list", "--provider"], /Expected to get a value, found a flag/],
    [["list", "--model"], /Expected to get a value, found a flag/],
    [["remove", "m", "--provider"], /Expected to get a value, found a flag/],
    [
      ["add", "m", "--provider", "vllm", "--context", "not-a-number"],
      /expected an integer >= 1, got "not-a-number"/,
    ],
    // `Number.parseInt` would read 200000 and drop the "abc".
    [
      ["add", "m", "--provider", "vllm", "--context", "200000abc"],
      /expected an integer >= 1, got "200000abc"/,
    ],
    [["add", "m", "--provider", "vllm", "--position", "-1"], /expected an integer >= 0, got "-1"/],
    // A swallowed `--max-outputs` would register the model with no override
    // and still print a success line carrying the resolver's own number.
    [
      ["add", "m", "--provider", "vllm", "--max-outputs", "64000"],
      /--max-outputs 64000\n\s+\^ Unknown arguments/,
    ],
  ])("rejects %j with exit 2 before loading anything", async (argv, message) => {
    const loadDeps = vi.fn<LoadDeps<ModelCliDeps>>(async () => makeDeps());
    const { io, out, err } = captureIo();

    const code = await runCli(modelCli(io, loadDeps), argv, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(out).toEqual([]);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it.each([["--context"], ["--max-output"]])(
    "rejects %s 0 under the flag it came from",
    async (flag) => {
      // A zero limit describes no model: `addModelRouting` refuses it and
      // the resolver ignores one already stored.
      const deps = makeDeps({ providers: [provider("p1", "vllm")] });
      const { io, err } = captureIo();
      const code = await run(["add", "m", "--provider", "vllm", flag, "0"], deps, io);
      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(
        new RegExp(`${flag} 0\\n\\s+\\^ expected an integer >= 1, got "0"`),
      );
      expect(deps.agentStore.addModelProvider).not.toHaveBeenCalled();
    },
  );
});
