import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import type { ProviderCliDeps } from "./provider.js";
import { type CliIo, runCli } from "./run.js";

const { addProviderSpy } = vi.hoisted(() => ({ addProviderSpy: vi.fn() }));

vi.mock("../agent/provider/add-provider.js", () => ({ addProvider: addProviderSpy }));

const { providerCli } = await import("./provider.js");

function run(argv: readonly string[], deps: ProviderCliDeps, io: CliIo): Promise<number> {
  return runCli(
    providerCli(io, async () => deps),
    argv,
    io,
  );
}

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function makeDeps() {
  return {
    runInTx: fakeRunInTx,
    agentStore: mock<AgentStore>(),
    secretsStore: mock<SecretsStore>(),
  };
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

beforeEach(() => {
  addProviderSpy.mockReset();
  addProviderSpy.mockResolvedValue({
    providerId: "p-1",
    secretId: "s-1",
    validation: { valid: true },
  });
});

describe("cogmo provider add — cache dialect", () => {
  it("leaves a custom provider's dialect to addProvider when no flag is given", async () => {
    const { io } = makeIo();

    const code = await run(
      ["add", "custom", "gateway", "sk-gw-1234567890", "https://gateway.internal/v1"],
      makeDeps(),
      io,
    );

    expect(code).toBe(0);
    expect(addProviderSpy).toHaveBeenCalledWith(expect.anything(), {
      name: "gateway",
      type: "openai_compatible",
      baseUrl: "https://gateway.internal/v1",
      apiKey: "sk-gw-1234567890",
    });
  });

  it.each([
    [[], "https://openrouter.ai/api/v1"],
    [["https://gateway.internal/openrouter/v1"], "https://gateway.internal/openrouter/v1"],
  ])(
    "gives the openrouter type the openrouter dialect, whatever its base URL (%j)",
    async (baseUrlArg, baseUrl) => {
      const { io } = makeIo();

      const code = await run(
        ["add", "openrouter", "or", "sk-or-1234567890", ...baseUrlArg],
        makeDeps(),
        io,
      );

      expect(code).toBe(0);
      expect(addProviderSpy).toHaveBeenCalledWith(expect.anything(), {
        name: "or",
        type: "openai_compatible",
        baseUrl,
        apiKey: "sk-or-1234567890",
        cacheDialect: "openrouter",
      });
    },
  );

  it("lets --cache-dialect override the openrouter type's dialect", async () => {
    const { io } = makeIo();

    const code = await run(
      ["add", "openrouter", "or", "sk-or-1234567890", "--cache-dialect", "none"],
      makeDeps(),
      io,
    );

    expect(code).toBe(0);
    expect(addProviderSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cacheDialect: "none" }),
    );
  });

  it("passes --cache-dialect through for a custom endpoint", async () => {
    const { io } = makeIo();

    const code = await run(
      [
        "add",
        "custom",
        "gateway",
        "sk-gw-1234567890",
        "https://gateway.internal/v1",
        "--cache-dialect",
        "openrouter",
      ],
      makeDeps(),
      io,
    );

    expect(code).toBe(0);
    expect(addProviderSpy).toHaveBeenCalledWith(expect.anything(), {
      name: "gateway",
      type: "openai_compatible",
      baseUrl: "https://gateway.internal/v1",
      apiKey: "sk-gw-1234567890",
      cacheDialect: "openrouter",
    });
  });

  it.each([
    [
      ["--cache-dialect", "bogus"],
      /Invalid value 'bogus'. Expected one of: 'openrouter', 'openai', 'xai', 'none'/,
    ],
    [["--cache-dialect"], /--cache-dialect\n\s+\^ Expected to get a value, found a flag/],
    [["--cache-dialect", "--other"], /Invalid value '--other'/],
    [["--verbose"], /--verbose\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2 and adds nothing", async (flags, message) => {
    const { io, err } = makeIo();

    const code = await run(
      ["add", "custom", "gateway", "sk-gw-1234567890", "https://gateway.internal/v1", ...flags],
      makeDeps(),
      io,
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(addProviderSpy).not.toHaveBeenCalled();
  });

  it("rejects --cache-dialect for an anthropic provider, which takes none", async () => {
    const { io, err } = makeIo();

    const code = await run(
      ["add", "anthropic", "claude", "sk-ant-1234567890", "--cache-dialect", "none"],
      makeDeps(),
      io,
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--cache-dialect applies to OpenAI-compatible providers only/);
    expect(addProviderSpy).not.toHaveBeenCalled();
  });

  it("reports addProvider's failure as a failed add, exit 1", async () => {
    addProviderSpy.mockRejectedValue(new Error("duplicate provider name"));
    const { io, err } = makeIo();

    const code = await run(["add", "openrouter", "or", "sk-or-1234567890"], makeDeps(), io);

    expect(code).toBe(1);
    expect(err).toEqual(["Failed to add provider: duplicate provider name"]);
  });

  it("lets a bootstrap failure propagate instead of reporting a failed add", async () => {
    const { io, err } = makeIo();
    const cli = providerCli(io, async () => {
      throw new Error("DATABASE_URL unreachable");
    });

    await expect(runCli(cli, ["add", "openrouter", "or", "sk-or-1234567890"], io)).rejects.toThrow(
      "DATABASE_URL unreachable",
    );
    expect(err).toEqual([]);
    expect(addProviderSpy).not.toHaveBeenCalled();
  });
});

const CLAUDE = {
  id: "p-claude",
  name: "claude",
  type: "anthropic",
  baseUrl: null,
  attrs: {},
} as const;
const GATEWAY = {
  id: "p-gateway",
  name: "gateway",
  type: "openai_compatible",
  baseUrl: "https://gateway.internal/v1",
  attrs: { cacheDialect: "openrouter" },
} as const;
// No `cacheDialect` in its attrs, which reads as `none`.
const LEGACY = {
  id: "p-legacy",
  name: "legacy",
  type: "openai_compatible",
  baseUrl: "https://llm.internal/v1",
  attrs: {},
} as const;

describe("cogmo provider list", () => {
  it("shows each provider's base URL and cache dialect", async () => {
    const deps = makeDeps();
    deps.agentStore.listProviders.mockResolvedValue([CLAUDE, GATEWAY, LEGACY]);
    const { io, out } = makeIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(out).toEqual([
      "name\ttype\tbase_url\tcache_dialect",
      "claude\tanthropic\t-\t-",
      "gateway\topenai_compatible\thttps://gateway.internal/v1\topenrouter",
      "legacy\topenai_compatible\thttps://llm.internal/v1\tnone",
    ]);
  });

  it("says so when no provider is registered", async () => {
    const deps = makeDeps();
    deps.agentStore.listProviders.mockResolvedValue([]);
    const { io, out } = makeIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(out).toEqual(["(no providers registered)"]);
  });
});

describe("cogmo provider set", () => {
  function depsWith(...providers: Array<typeof CLAUDE | typeof GATEWAY | typeof LEGACY>) {
    const deps = makeDeps();
    deps.agentStore.listProviders.mockResolvedValue(providers);
    deps.agentStore.setProviderCacheDialect.mockResolvedValue(true);
    return deps;
  }

  it("sets an OpenAI-compatible provider's cache dialect", async () => {
    const deps = depsWith(CLAUDE, GATEWAY);
    const { io, out } = makeIo();

    const code = await run(["set", "gateway", "--cache-dialect", "none"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.setProviderCacheDialect).toHaveBeenCalledWith(
      expect.anything(),
      "p-gateway",
      "none",
    );
    expect(out.join("\n")).toMatch(/Set "gateway" cache dialect: openrouter → none/);
    expect(out.join("\n")).toMatch(/Restart `cogmo serve`/);
  });

  it("reads a provider without a dialect as none", async () => {
    const deps = depsWith(LEGACY);
    const { io, out } = makeIo();

    const code = await run(["set", "legacy", "--cache-dialect", "openai"], deps, io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Set "legacy" cache dialect: none → openai/);
  });

  it.each([
    [["set"], /No value provided for name/],
    [["set", "gateway"], /No value provided for --cache-dialect/],
    [["set", "--cache-dialect", "none"], /No value provided for name/],
    [["set", "gateway", "--cache-dialect", "bogus"], /Invalid value 'bogus'/],
    [["set", "gateway", "--cache-dialect"], /No value provided for --cache-dialect/],
    [["set", "gateway", "--verbose"], /--verbose\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2 and changes nothing", async (argv, message) => {
    const deps = depsWith(GATEWAY);
    const { io, err } = makeIo();

    const code = await run(argv, deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(deps.agentStore.setProviderCacheDialect).not.toHaveBeenCalled();
  });

  it("rejects an anthropic provider, which takes no dialect", async () => {
    const deps = depsWith(CLAUDE);
    const { io, err } = makeIo();

    const code = await run(["set", "claude", "--cache-dialect", "none"], deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/--cache-dialect applies to OpenAI-compatible providers only/);
    expect(deps.agentStore.setProviderCacheDialect).not.toHaveBeenCalled();
  });

  it("exits 1 for an unknown provider", async () => {
    const deps = depsWith(GATEWAY);
    const { io, err } = makeIo();

    const code = await run(["set", "nope", "--cache-dialect", "none"], deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No provider named "nope"/);
    expect(deps.agentStore.setProviderCacheDialect).not.toHaveBeenCalled();
  });

  it("exits 1 when the provider is gone by the time it writes", async () => {
    const deps = depsWith(GATEWAY);
    deps.agentStore.setProviderCacheDialect.mockResolvedValue(false);
    const { io, err, out } = makeIo();

    const code = await run(["set", "gateway", "--cache-dialect", "none"], deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No provider named "gateway"/);
    expect(out).toEqual([]);
  });
});
