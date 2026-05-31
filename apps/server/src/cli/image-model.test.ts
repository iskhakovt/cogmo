import { describe, expect, it, vi } from "vitest";
import type {
  AgentStore,
  ImageModelRow,
  ImageModelWithProvider,
  ImageProviderRow,
} from "../agent/store/index.js";
import { runImageModelCli } from "./image-model.js";

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

function fakeProvider(overrides: Partial<ImageProviderRow> = {}): ImageProviderRow {
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

function fakeModel(
  overrides: Partial<ImageModelRow> = {},
  providerOverrides: Partial<ImageProviderRow> = {},
): ImageModelWithProvider {
  return {
    id: "m-1",
    providerId: "p-1",
    name: "fal/flux-dev",
    modelString: "fal-ai/flux/dev",
    description: "balanced",
    capabilities: { aspectRatios: ["1:1"], seed: true },
    userSelectable: true,
    ...overrides,
    provider: fakeProvider(providerOverrides),
  };
}

describe("runImageModelCli", () => {
  it("prints USAGE on no command", async () => {
    const { io, out } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli([], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/Usage: cogmo image-model/);
  });

  it("rejects `add` without --provider", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(["add", "fal/x"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--provider is required/);
  });

  it("rejects `add` without --model-string or --description", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider", "fal"],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--model-string is required/);
  });

  it("creates a model with parsed capabilities", async () => {
    const { io, out } = makeIo();
    const createImageModel = vi.fn().mockResolvedValue({ id: "m-new" });
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(fakeProvider()),
      createImageModel,
    } as unknown as AgentStore;
    const rc = await runImageModelCli(
      [
        "add",
        "fal/custom",
        "--provider",
        "fal",
        "--model-string",
        "fal-ai/custom",
        "--description",
        "test row",
        "--ratios",
        "1:1,16:9",
        "--seed",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(0);
    expect(createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        providerId: "p-1",
        name: "fal/custom",
        modelString: "fal-ai/custom",
        description: "test row",
        capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
        userSelectable: true,
      }),
    );
    expect(out.join("\n")).toMatch(/Added image model "fal\/custom"/);
  });

  it("honours --no-selectable", async () => {
    const { io } = makeIo();
    const createImageModel = vi.fn().mockResolvedValue({ id: "m-hidden" });
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(fakeProvider()),
      createImageModel,
    } as unknown as AgentStore;
    await runImageModelCli(
      [
        "add",
        "fal/hidden",
        "--provider",
        "fal",
        "--model-string",
        "fal-ai/hidden",
        "--description",
        "experimental",
        "--no-selectable",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ userSelectable: false }),
    );
  });

  it("accepts --image-input required and writes it into capabilities", async () => {
    const { io } = makeIo();
    const createImageModel = vi.fn().mockResolvedValue({ id: "m-edit" });
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(fakeProvider()),
      createImageModel,
    } as unknown as AgentStore;
    await runImageModelCli(
      [
        "add",
        "fal/edit",
        "--provider",
        "fal",
        "--model-string",
        "fal-ai/edit",
        "--description",
        "edits an image",
        "--image-input",
        "required",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        capabilities: { imageInput: "required" },
      }),
    );
  });

  it("writes capabilities.negativePrompt=true when --negative-prompt is passed", async () => {
    const { io } = makeIo();
    const createImageModel = vi.fn().mockResolvedValue({ id: "m-np" });
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(fakeProvider({ type: "venice" })),
      createImageModel,
    } as unknown as AgentStore;
    await runImageModelCli(
      [
        "add",
        "venice/flux-dev",
        "--provider",
        "venice",
        "--model-string",
        "flux-dev",
        "--description",
        "Venice",
        "--negative-prompt",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        capabilities: { negativePrompt: true },
      }),
    );
  });

  it("rejects --image-input with an unknown value", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      [
        "add",
        "fal/edit",
        "--provider",
        "fal",
        "--model-string",
        "fal-ai/edit",
        "--description",
        "x",
        "--image-input",
        "kinda",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--image-input got "kinda"/);
  });

  it("rejects an unknown aspect ratio in --ratios", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      [
        "add",
        "fal/x",
        "--provider",
        "fal",
        "--model-string",
        "fal-ai/x",
        "--description",
        "x",
        "--ratios",
        "horizontal",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Error: --ratios got "horizontal"/);
  });

  it("lists models with --all and provider filter", async () => {
    const { io, out } = makeIo();
    const agentStore = {
      listImageModelsWithProvider: vi.fn().mockImplementation(async (_t, opts) => {
        // Hidden row only appears when userSelectableOnly is false (--all).
        if (opts?.userSelectableOnly) {
          return [fakeModel({ name: "fal/visible" })];
        }
        return [
          fakeModel({ name: "fal/visible" }),
          fakeModel({ name: "fal/hidden", userSelectable: false }),
        ];
      }),
    } as unknown as AgentStore;
    const rc = await runImageModelCli(["list", "--all"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/fal\/visible/);
    expect(out.join("\n")).toMatch(/fal\/hidden/);
  });

  it("removes a model by name", async () => {
    const { io, out } = makeIo();
    const deleteImageModel = vi.fn().mockResolvedValue(undefined);
    const agentStore = {
      listImageModels: vi.fn().mockResolvedValue([fakeModel({ name: "fal/flux-dev" })]),
      deleteImageModel,
    } as unknown as AgentStore;
    const rc = await runImageModelCli(["remove", "fal/flux-dev"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(0);
    expect(deleteImageModel).toHaveBeenCalledWith(FAKE_TX, "m-1");
    expect(out.join("\n")).toMatch(/Removed image model "fal\/flux-dev"/);
  });

  it("reports not-found when removing an unknown model", async () => {
    const { io, err } = makeIo();
    const agentStore = {
      listImageModels: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
    const rc = await runImageModelCli(["remove", "ghost"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/No image model named "ghost"/);
  });

  it("rejects unknown commands with exit code 1 and the usage banner", async () => {
    const { io, err } = makeIo();
    const rc = await runImageModelCli(["foo"], { runInTx: tx, agentStore: {} as AgentStore }, io);
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/Unknown command: foo/);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-model/);
  });

  it("`image-model add` with no name returns 2 and prints usage", async () => {
    const { io, err } = makeIo();
    const rc = await runImageModelCli(["add"], { runInTx: tx, agentStore: {} as AgentStore }, io);
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-model add/);
  });

  it("rejects `add` without --description (matches usage hint)", async () => {
    const { io, err } = makeIo();
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider", "fal", "--model-string", "f"],
      { runInTx: tx, agentStore: {} as AgentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--description is required/);
  });

  it("reports unknown provider with exit code 1", async () => {
    const { io, err } = makeIo();
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentStore;
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider", "ghost", "--model-string", "f", "--description", "d"],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/No image provider named "ghost"/);
  });

  it("surfaces createImageModel failures as exit code 1", async () => {
    const { io, err } = makeIo();
    const agentStore = {
      findImageProviderByName: vi.fn().mockResolvedValue(fakeProvider()),
      createImageModel: vi.fn().mockRejectedValue(new Error("duplicate name")),
    } as unknown as AgentStore;
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider", "fal", "--model-string", "f", "--description", "d"],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(1);
    expect(err.join("\n")).toMatch(/Failed to add image model: duplicate name/);
  });

  it("`image-model list` with no rows prints (no image models)", async () => {
    const { io, out } = makeIo();
    const agentStore = {
      listImageModelsWithProvider: vi.fn().mockResolvedValue([]),
    } as unknown as AgentStore;
    const rc = await runImageModelCli(["list"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(0);
    expect(out.join("\n")).toMatch(/no image models/);
  });

  it("`image-model remove` with no name returns 2", async () => {
    const { io, err } = makeIo();
    const rc = await runImageModelCli(
      ["remove"],
      { runInTx: tx, agentStore: {} as AgentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Usage: cogmo image-model remove/);
  });

  it("rejects an unknown flag in `add`", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(["add", "fal/x", "--bogus"], { runInTx: tx, agentStore }, io);
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown flag "--bogus"/);
  });

  it("rejects --provider followed by another flag (takeValue: next-is-flag)", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider", "--model-string", "f"],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--provider requires a value \(got next flag/);
  });

  it("rejects --provider with no following value (takeValue: missing)", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      ["add", "fal/x", "--provider"],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--provider requires a value/);
  });

  it("rejects --ratios with an empty list (all whitespace)", async () => {
    const { io, err } = makeIo();
    const agentStore = {} as AgentStore;
    const rc = await runImageModelCli(
      [
        "add",
        "fal/x",
        "--provider",
        "fal",
        "--model-string",
        "f",
        "--description",
        "d",
        "--ratios",
        " , ,",
      ],
      { runInTx: tx, agentStore },
      io,
    );
    expect(rc).toBe(2);
    expect(err.join("\n")).toMatch(/--ratios got an empty list/);
  });
});
