import { describe, expect, it, vi } from "vitest";
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
    expect(err.join("\n")).toMatch(/expected fal\|openai_compatible/);
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
});
