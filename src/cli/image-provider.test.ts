import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type { AgentStore, ImageProviderRow } from "../agent/store/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { runImageProviderCli } from "./image-provider.js";

const FAKE_TX = { __mockTx: true } as never;
const tx = ((cb: (t: never) => Promise<unknown>) => cb(FAKE_TX)) as never;

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

function makeProviderRow(overrides: Partial<ImageProviderRow> = {}): ImageProviderRow {
  return {
    id: "p-1",
    name: "fal",
    type: "fal",
    baseUrl: null,
    secretId: "sec-1",
    attrs: {},
    ...overrides,
  };
}

describe("runImageProviderCli", () => {
  it("prints USAGE for no command / --help", async () => {
    const { io, out } = makeIo();
    const agentStore = {} as AgentStore;
    const secretsStore = {} as SecretsStore;
    const rc = await runImageProviderCli([], { runInTx: tx, agentStore, secretsStore }, io);
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/Usage: cogmo image-provider/);
  });

  it("lists providers", async () => {
    const { io, out } = makeIo();
    const agentStore = {
      listImageProviders: vi.fn().mockResolvedValue([
        makeProviderRow({ name: "fal" }),
        makeProviderRow({
          name: "venice",
          type: "openai_compatible",
          baseUrl: "https://api.venice.ai/api/v1",
        }),
      ]),
    } as unknown as AgentStore;
    const secretsStore = {} as SecretsStore;
    const rc = await runImageProviderCli(["list"], { runInTx: tx, agentStore, secretsStore }, io);
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/fal\tfal/);
    expect(out.join("\n")).toMatch(/venice\topenai_compatible\thttps:\/\/api.venice.ai/);
  });

  it('reports "no providers" when the catalog is empty', async () => {
    const { io, out } = makeIo();
    const agentStore = {
      listImageProviders: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
    const rc = await runImageProviderCli(
      ["list"],
      { runInTx: tx, agentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/no image providers/);
  });

  it("rejects an unknown type at the CLI boundary", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const secretsStore = {} as SecretsStore;
    const rc = await runImageProviderCli(
      ["add", "bogus", "foo", "sk-key"],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/expected fal\|openai_compatible\|venice/);
  });

  it("creates a fal provider (writes secret + provider row)", async () => {
    const { io, out } = makeIo();
    const putSecret = vi.fn().mockResolvedValue({ id: "sec-fal" });
    const createImageProvider = vi.fn().mockResolvedValue({ id: "p-fal" });
    const agentStore = { createImageProvider } as unknown as AgentStore;
    const secretsStore = { putSecret } as unknown as SecretsStore;
    const rc = await runImageProviderCli(
      ["add", "fal", "fal", "sk-fal"],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(0);
    expect(putSecret).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "fal_api_key", plaintext: "sk-fal" }),
    );
    expect(createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ name: "fal", type: "fal", baseUrl: null, secretId: "sec-fal" }),
    );
    expect(out.join("\n")).toMatch(/Added image provider "fal"/);
  });

  it("creates a venice provider with safe_mode default", async () => {
    const { io, out } = makeIo();
    const putSecret = vi.fn().mockResolvedValue({ id: "sec-venice" });
    const createImageProvider = vi.fn().mockResolvedValue({ id: "p-venice" });
    const agentStore = { createImageProvider } as unknown as AgentStore;
    const secretsStore = { putSecret } as unknown as SecretsStore;
    const rc = await runImageProviderCli(
      [
        "add",
        "venice",
        "venice",
        "sk-venice",
        "https://api.venice.ai/api/v1",
        "--safe-mode",
        "false",
      ],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(0);
    expect(createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        name: "venice",
        type: "venice",
        baseUrl: "https://api.venice.ai/api/v1",
        attrs: { imageGenerationDefaults: { safe_mode: false } },
      }),
    );
    expect(out.join("\n")).toMatch(/Added image provider "venice"/);
  });

  it("rejects venice extras for non-venice provider types", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const secretsStore = {} as SecretsStore;
    const rc = await runImageProviderCli(
      [
        "add",
        "openai_compatible",
        "openai",
        "sk-openai",
        "https://api.openai.com/v1",
        "--safe-mode",
        "true",
      ],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/are venice-only/);
  });

  it("forwards all four venice extras into imageGenerationDefaults", async () => {
    // Wizard docs and image-generation.md both claim cfg_scale,
    // hide_watermark, and style_preset are reachable via `cogmo
    // image-provider`. This test pins the CLI side of that claim so a
    // future flag-parser refactor doesn't drop one silently.
    const { io, out } = makeIo();
    const agentStore = mock<AgentStore>();
    agentStore.createImageProvider.mockResolvedValue({ id: "p-2" });
    const secretsStore = mock<SecretsStore>();
    secretsStore.putSecret.mockResolvedValue({ id: "s-2" });
    const rc = await runImageProviderCli(
      [
        "add",
        "venice",
        "venice-all",
        "sk-venice",
        "https://api.venice.ai/api/v1",
        "--safe-mode",
        "false",
        "--cfg-scale",
        "7.5",
        "--hide-watermark",
        "true",
        "--style-preset",
        "Photographic",
      ],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(0);
    expect(agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        attrs: {
          imageGenerationDefaults: {
            safe_mode: false,
            cfg_scale: 7.5,
            hide_watermark: true,
            style_preset: "Photographic",
          },
        },
      }),
    );
    expect(out.join("\n")).toMatch(/Added image provider "venice-all"/);
  });

  it("rejects --cfg-scale outside 0–20", async () => {
    const { io, err } = makeIo();
    const agentStore = mock<AgentStore>();
    const secretsStore = mock<SecretsStore>();
    const rc = await runImageProviderCli(
      ["add", "venice", "venice", "sk-v", "https://api.venice.ai/api/v1", "--cfg-scale", "25"],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--cfg-scale requires a number 0–20/);
  });

  it("removes a provider by name", async () => {
    const { io, out } = makeIo();
    const findImageProviderByName = vi.fn().mockResolvedValue(makeProviderRow({ name: "fal" }));
    const deleteImageProvider = vi.fn().mockResolvedValue(undefined);
    const agentStore = { findImageProviderByName, deleteImageProvider } as unknown as AgentStore;
    const rc = await runImageProviderCli(
      ["remove", "fal"],
      { runInTx: tx, agentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(0);
    expect(deleteImageProvider).toHaveBeenCalledWith(FAKE_TX, "p-1");
    expect(out.join("\n")).toMatch(/Removed image provider "fal"/);
  });

  it("reports not-found when removing an unknown provider", async () => {
    const { io, err } = makeIo();
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
    const rc = await runImageProviderCli(
      ["remove", "ghost"],
      { runInTx: tx, agentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/No image provider named "ghost"/);
  });

  it("rejects unknown commands with exit code 1 and the usage banner", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["bogosity"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/Unknown command: bogosity/);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-provider/);
  });

  it("traps thrown errors mid-dispatch and surfaces exit code 2", async () => {
    const { io, err } = makeIo();
    const agentStore = {
      listImageProviders: vi.fn().mockRejectedValue(new Error("db gone")),
    } as unknown as AgentStore;
    const rc = await runImageProviderCli(
      ["list"],
      { runInTx: tx, agentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Error: db gone/);
  });

  it("rejects --safe-mode with a non-boolean value", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "venice", "venice", "sk", "https://x", "--safe-mode", "maybe"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--safe-mode requires "true" or "false"/);
  });

  it("rejects --safe-mode when value is missing entirely", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "venice", "venice", "sk", "https://x", "--safe-mode"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--safe-mode requires "true" or "false"/);
  });

  it("rejects --hide-watermark with a non-boolean value", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "venice", "venice", "sk", "https://x", "--hide-watermark", "yes"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--hide-watermark requires "true" or "false"/);
  });

  it("rejects --style-preset when value is missing or empty", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "venice", "venice", "sk", "https://x", "--style-preset"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--style-preset requires a non-empty string/);
  });

  it("rejects a missing positional triple with the usage banner", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "fal", "fal"], // missing api-key
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-provider add/);
  });

  it("rejects an invalid provider name (shell-unsafe chars)", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["add", "fal", "Bad Name", "sk-fal"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Invalid name "Bad Name"/);
  });

  it("maps InvalidProviderConfigError to exit code 2", async () => {
    const { io, err } = makeIo();
    const { InvalidProviderConfigError } = await import("../agent/store/errors.js");
    const agentStore = mock<AgentStore>();
    agentStore.createImageProvider.mockRejectedValue(
      new InvalidProviderConfigError("not allowed here"),
    );
    const secretsStore = mock<SecretsStore>();
    secretsStore.putSecret.mockResolvedValue({ id: "s-1" });
    const rc = await runImageProviderCli(
      ["add", "fal", "fal", "sk"],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Invalid config: not allowed here/);
  });

  it("maps generic creation failures to exit code 1", async () => {
    const { io, err } = makeIo();
    const agentStore = mock<AgentStore>();
    agentStore.createImageProvider.mockRejectedValue(new Error("upstream timeout"));
    const secretsStore = mock<SecretsStore>();
    secretsStore.putSecret.mockResolvedValue({ id: "s-1" });
    const rc = await runImageProviderCli(
      ["add", "fal", "fal", "sk"],
      { runInTx: tx, agentStore, secretsStore },
      io,
    );
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/Failed to add image provider: upstream timeout/);
  });

  it("`remove` with no name returns 2 and prints usage", async () => {
    const { io, err } = makeIo();
    const rc = await runImageProviderCli(
      ["remove"],
      { runInTx: tx, agentStore: {} as AgentStore, secretsStore: {} as SecretsStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-provider remove/);
  });
});
