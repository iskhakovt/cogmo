import { describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../agent/store/index.js";
import { runModelCli } from "./model.js";

const FAKE_TX = { __mockTx: true } as never;
const tx = (cb: (t: never) => Promise<unknown>) => cb(FAKE_TX) as Promise<unknown>;

interface FakeRoutingRow {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  secretId: string;
  attrs: Record<string, unknown>;
  position: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

function makeStore(
  opts: {
    providers?: ReadonlyArray<{ id: string; name: string; type: string }>;
    rowsByModel?: Record<string, ReadonlyArray<FakeRoutingRow>>;
    allModels?: ReadonlyArray<string>;
  } = {},
) {
  const allModelProviders: Array<{ model: string } & FakeRoutingRow> = [];
  for (const [model, rows] of Object.entries(opts.rowsByModel ?? {})) {
    for (const row of rows) allModelProviders.push({ model, ...row });
  }
  return {
    listProviders: vi.fn().mockResolvedValue(opts.providers ?? []),
    listProvidersForModel: vi.fn().mockImplementation(async (_tx, model: string) => {
      return opts.rowsByModel?.[model] ?? [];
    }),
    listAllModels: vi.fn().mockResolvedValue(opts.allModels ?? []),
    listAllModelProviders: vi.fn().mockResolvedValue(allModelProviders),
    addModelProvider: vi.fn().mockResolvedValue({ id: "row-1" }),
    getNextModelProviderPosition: vi.fn().mockResolvedValue(0),
    removeModelProvider: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentStore;
}

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

describe("cogmo model — usage", () => {
  it("prints usage on no args", async () => {
    const { io, out } = makeIo();
    const code = await runModelCli([], { runInTx: tx as never, agentStore: makeStore() }, io);
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Usage:/);
  });
});

describe("cogmo model add", () => {
  it("rejects when --provider is missing", async () => {
    const { io, err } = makeIo();
    const code = await runModelCli(
      ["add", "x-ai/grok-4.3"],
      { runInTx: tx as never, agentStore: makeStore() },
      io,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--provider is required/);
  });

  it("rejects when the provider is not registered", async () => {
    const { io, err } = makeIo();
    const code = await runModelCli(
      ["add", "x-ai/grok-4.3", "--provider", "missing"],
      { runInTx: tx as never, agentStore: makeStore({ providers: [] }) },
      io,
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No provider named "missing"/);
  });

  it("inserts a row and reports effective limits sourced from LiteLLM when no overrides given", async () => {
    const store = makeStore({
      providers: [{ id: "p1", name: "openrouter", type: "openai_compatible" }],
    });
    const { io, out } = makeIo();
    const code = await runModelCli(
      ["add", "x-ai/grok-4.3", "--provider", "openrouter"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(0);
    // Resolver finds x-ai/grok-4.3 in the bundled LiteLLM snapshot.
    expect(out.join("\n")).toMatch(/context=\d+ \(litellm\)/);
    expect(out.join("\n")).toMatch(/max_output=\d+ \(litellm\)/);
    expect(out.join("\n")).toMatch(/Restart `cogmo serve`/);
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        model: "x-ai/grok-4.3",
        providerId: "p1",
        contextWindow: null,
        maxOutputTokens: null,
      }),
    );
  });

  it("threads --context and --max-output as explicit overrides", async () => {
    const store = makeStore({
      providers: [{ id: "p1", name: "vllm", type: "openai_compatible" }],
    });
    const { io, out } = makeIo();
    const code = await runModelCli(
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
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(0);
    expect(store.addModelProvider).toHaveBeenCalledWith(
      FAKE_TX,
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
});

describe("cogmo model list", () => {
  it("prints (no model routing rows) when empty", async () => {
    const { io, out } = makeIo();
    const code = await runModelCli(["list"], { runInTx: tx as never, agentStore: makeStore() }, io);
    expect(code).toBe(0);
    expect(out).toContain("(no model routing rows)");
  });

  it("renders one tab-separated line per (model, provider) row with effective limits", async () => {
    const store = makeStore({
      allModels: ["claude-sonnet-4-6"],
      rowsByModel: {
        "claude-sonnet-4-6": [
          {
            id: "r1",
            name: "anthropic",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 0,
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
      },
    });
    const { io, out } = makeIo();
    await runModelCli(["list"], { runInTx: tx as never, agentStore: store }, io);
    // Header + one row.
    expect(out.length).toBe(2);
    expect(out[0]).toMatch(/model\tprovider\tposition\tcontext\tmax_output\tsource/);
    // Both columns came from LiteLLM → source collapses to the shared tag.
    expect(out[1]).toMatch(/^claude-sonnet-4-6\tanthropic\t0\t1000000\t64000\tlitellm$/);
  });

  it("renders a split `cw=…,mo=…` source tag when the two columns disagree", async () => {
    // Partial override: row pins maxOutputTokens but leaves contextWindow
    // to LiteLLM. The list view shows both sources so the operator sees
    // the LiteLLM contribution they'd otherwise have missed.
    const store = makeStore({
      allModels: ["claude-sonnet-4-6"],
      rowsByModel: {
        "claude-sonnet-4-6": [
          {
            id: "r1",
            name: "anthropic",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 0,
            contextWindow: null,
            maxOutputTokens: 8_000,
          },
        ],
      },
    });
    const { io, out } = makeIo();
    await runModelCli(["list"], { runInTx: tx as never, agentStore: store }, io);
    expect(out[1]).toMatch(/^claude-sonnet-4-6\tanthropic\t0\t1000000\t8000\tcw=litellm,mo=db$/);
  });

  it("displays the stored position, not the array index, when positions are non-sequential", async () => {
    // Row at position 5 with no other rows — array index would render 0,
    // misleading anyone trying to `cogmo model remove --position`. Stored
    // position is what `listProvidersForModel` reads from the DB.
    const store = makeStore({
      allModels: ["m"],
      rowsByModel: {
        m: [
          {
            id: "r1",
            name: "p",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 5,
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
      },
    });
    const { io, out } = makeIo();
    await runModelCli(["list"], { runInTx: tx as never, agentStore: store }, io);
    expect(out[1]).toMatch(/^m\tp\t5\t/);
  });

  it("uses one query for the whole routing table — no per-model fanout", async () => {
    const store = makeStore({
      allModels: ["m1", "m2", "m3"],
      rowsByModel: {
        m1: [
          {
            id: "r1",
            name: "p",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 0,
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
        m2: [
          {
            id: "r2",
            name: "p",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 0,
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
        m3: [
          {
            id: "r3",
            name: "p",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            position: 0,
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
      },
    });
    const { io } = makeIo();
    await runModelCli(["list"], { runInTx: tx as never, agentStore: store }, io);
    expect(store.listAllModelProviders).toHaveBeenCalledTimes(1);
    expect(store.listProvidersForModel).not.toHaveBeenCalled();
  });
});

describe("cogmo model remove", () => {
  function rowFixture(id: string, name: string, position: number): FakeRoutingRow {
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
    };
  }

  it("removes one row when --provider is given", async () => {
    const store = makeStore({
      rowsByModel: { m: [rowFixture("r1", "p1", 0), rowFixture("r2", "p2", 1)] },
    });
    const { io } = makeIo();
    const code = await runModelCli(
      ["remove", "m", "--provider", "p2"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(0);
    expect(store.removeModelProvider).toHaveBeenCalledTimes(1);
    expect(store.removeModelProvider).toHaveBeenCalledWith(FAKE_TX, "m", "r2");
  });

  it("removes every row for the model in one transaction when --provider is omitted", async () => {
    const store = makeStore({
      rowsByModel: { m: [rowFixture("r1", "p1", 0), rowFixture("r2", "p2", 1)] },
    });
    const runInTx = vi.fn().mockImplementation((cb) => cb(FAKE_TX));
    const { io } = makeIo();
    const code = await runModelCli(["remove", "m"], { runInTx, agentStore: store }, io);
    expect(code).toBe(0);
    expect(store.removeModelProvider).toHaveBeenCalledTimes(2);
    // Both deletes share one outer transaction — the loop runs inside a
    // single `runInTx` callback rather than starting a new tx per row.
    // (The initial `listProvidersForModel` call is its own tx.)
    expect(runInTx).toHaveBeenCalledTimes(2);
  });
});

describe("cogmo model — flag parsing", () => {
  it("rejects `--flag` consumed as a value for another flag", async () => {
    const store = makeStore({
      providers: [{ id: "p1", name: "openrouter", type: "openai_compatible" }],
    });
    const { io, err } = makeIo();
    // `--context` follows `--provider`, so the buggy parser would set
    // `provider = "--context"` and silently drop the real provider value.
    const code = await runModelCli(
      ["add", "x-ai/grok-4.3", "--provider", "--context", "200000"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--provider requires a value/);
    expect(store.addModelProvider).not.toHaveBeenCalled();
  });

  it("rejects a flag with no following value", async () => {
    const store = makeStore({
      providers: [{ id: "p1", name: "openrouter", type: "openai_compatible" }],
    });
    const { io, err } = makeIo();
    const code = await runModelCli(
      ["add", "x-ai/grok-4.3", "--provider"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--provider requires a value/);
  });

  it("rejects a non-numeric --context value", async () => {
    const store = makeStore({
      providers: [{ id: "p1", name: "vllm", type: "openai_compatible" }],
    });
    const { io, err } = makeIo();
    const code = await runModelCli(
      ["add", "m", "--provider", "vllm", "--context", "not-a-number"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--context expects a non-negative integer/);
  });

  it("rejects a --context value with trailing garbage (parseInt would silently accept)", async () => {
    // `Number.parseInt("200000abc", 10)` returns 200000 and silently drops
    // the trailing "abc". Number()+isInteger catches it.
    const store = makeStore({
      providers: [{ id: "p1", name: "vllm", type: "openai_compatible" }],
    });
    const { io, err } = makeIo();
    const code = await runModelCli(
      ["add", "m", "--provider", "vllm", "--context", "200000abc"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--context expects a non-negative integer/);
    expect(store.addModelProvider).not.toHaveBeenCalled();
  });
});
