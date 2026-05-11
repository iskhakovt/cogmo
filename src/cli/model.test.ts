import { describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../agent/store/index.js";
import { runModelCli } from "./model.js";

const FAKE_TX = { __mockTx: true } as never;
const tx = (cb: (t: never) => Promise<unknown>) => cb(FAKE_TX) as Promise<unknown>;

function makeStore(
  opts: {
    providers?: ReadonlyArray<{ id: string; name: string; type: string }>;
    rowsByModel?: Record<
      string,
      ReadonlyArray<{
        id: string;
        name: string;
        type: string;
        baseUrl: string | null;
        secretId: string;
        attrs: Record<string, unknown>;
        contextWindow: number | null;
        maxOutputTokens: number | null;
      }>
    >;
    allModels?: ReadonlyArray<string>;
  } = {},
) {
  return {
    listProviders: vi.fn().mockResolvedValue(opts.providers ?? []),
    listProvidersForModel: vi.fn().mockImplementation(async (_tx, model: string) => {
      return opts.rowsByModel?.[model] ?? [];
    }),
    listAllModels: vi.fn().mockResolvedValue(opts.allModels ?? []),
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
    expect(out.join("\n")).toMatch(/source: litellm/);
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
    // db source signals the row override is winning over the (missing)
    // LiteLLM entry.
    expect(out.join("\n")).toMatch(/source: db/);
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
    expect(out[1]).toMatch(/^claude-sonnet-4-6\tanthropic\t0\t1000000\t64000\tlitellm$/);
  });
});

describe("cogmo model remove", () => {
  it("removes one row when --provider is given", async () => {
    const store = makeStore({
      rowsByModel: {
        m: [
          {
            id: "r1",
            name: "p1",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            contextWindow: null,
            maxOutputTokens: null,
          },
          {
            id: "r2",
            name: "p2",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
      },
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

  it("removes every row for the model when --provider is omitted", async () => {
    const store = makeStore({
      rowsByModel: {
        m: [
          {
            id: "r1",
            name: "p1",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            contextWindow: null,
            maxOutputTokens: null,
          },
          {
            id: "r2",
            name: "p2",
            type: "anthropic",
            baseUrl: null,
            secretId: "s",
            attrs: {},
            contextWindow: null,
            maxOutputTokens: null,
          },
        ],
      },
    });
    const { io } = makeIo();
    const code = await runModelCli(
      ["remove", "m"],
      { runInTx: tx as never, agentStore: store },
      io,
    );
    expect(code).toBe(0);
    expect(store.removeModelProvider).toHaveBeenCalledTimes(2);
  });
});
