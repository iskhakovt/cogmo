import { beforeEach, describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";

const { addProviderSpy } = vi.hoisted(() => ({ addProviderSpy: vi.fn() }));

vi.mock("../agent/provider/add-provider.js", () => ({ addProvider: addProviderSpy }));

const { runProviderCli } = await import("./provider.js");

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
  it("leaves the dialect to addProvider when no flag is given", async () => {
    const { io } = makeIo();

    const code = await runProviderCli(
      ["add", "openrouter", "or", "sk-or-1234567890"],
      makeDeps(),
      io,
    );

    expect(code).toBe(0);
    expect(addProviderSpy).toHaveBeenCalledWith(expect.anything(), {
      name: "or",
      type: "openai_compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-1234567890",
    });
  });

  it("passes --cache-dialect through for a custom endpoint", async () => {
    const { io } = makeIo();

    const code = await runProviderCli(
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
    [["--cache-dialect", "bogus"], /--cache-dialect must be one of openrouter, openai, xai, none/],
    [["--cache-dialect"], /--cache-dialect needs a value/],
    [["--cache-dialect", "--other"], /--cache-dialect needs a value/],
    [["--verbose"], /Unknown flag "--verbose"/],
  ])("rejects %j with exit 2 and adds nothing", async (flags, message) => {
    const { io, err } = makeIo();

    const code = await runProviderCli(
      ["add", "custom", "gateway", "sk-gw-1234567890", "https://gateway.internal/v1", ...flags],
      makeDeps(),
      io,
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(addProviderSpy).not.toHaveBeenCalled();
  });
});
