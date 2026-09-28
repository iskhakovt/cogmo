import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import type {
  AgentStore,
  ImageModelRow,
  ImageModelWithProvider,
  ImageProviderRow,
} from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import { captureIo } from "../test/factories.js";
import { type ImageModelCliDeps, imageModelCli } from "./image-model.js";
import { type CliIo, runCli } from "./run.js";

function run(argv: readonly string[], deps: ImageModelCliDeps, io: CliIo): Promise<number> {
  return runCli(
    imageModelCli(io, async () => deps),
    argv,
    io,
  );
}

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function makeDeps() {
  const deps = { runInTx: fakeRunInTx, agentStore: mock<AgentStore>() };
  deps.agentStore.findImageProviderByName.mockResolvedValue(fakeProvider());
  deps.agentStore.createImageModel.mockResolvedValue({ id: "m-new" });
  return deps;
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

/** `add` with every required argument, for tests about the optional ones. */
const ADD = ["add", "fal/x", "--provider", "fal", "--model-string", "f", "--description", "d"];

describe("cogmo image-model — command line", () => {
  it("prints help and exits 0 when given no command", async () => {
    const { io, out } = captureIo();

    const code = await run([], makeDeps(), io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/image-model <subcommand>/);
  });

  it.each([["add"], ["list"], ["remove"]])(
    "answers `%s --help` without loading dependencies",
    async (subcommand) => {
      const { io, out, err } = captureIo();
      const loadDeps = vi.fn(async () => makeDeps());

      const code = await runCli(imageModelCli(io, loadDeps), [subcommand, "--help"], io);

      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(new RegExp(`image-model ${subcommand}`));
      expect(err).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown command with exit 2", async () => {
    const { io, err } = captureIo();

    const code = await run(["foo"], makeDeps(), io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/foo\n\s+\^ Not a valid subcommand name/);
  });
});

describe("cogmo image-model add", () => {
  it("creates a model with parsed capabilities", async () => {
    const deps = makeDeps();
    const { io, out } = captureIo();

    const code = await run(
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
        "1:1, 16:9",
        "--seed",
      ],
      deps,
      io,
    );

    expect(code).toBe(0);
    expect(deps.agentStore.findImageProviderByName).toHaveBeenCalledWith(FAKE_TX, "fal");
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(FAKE_TX, {
      providerId: "p-1",
      name: "fal/custom",
      modelString: "fal-ai/custom",
      description: "test row",
      capabilities: { aspectRatios: ["1:1", "16:9"], seed: true },
      userSelectable: true,
    });
    expect(out).toEqual(['Added image model "fal/custom" (id=m-new, provider=fal).']);
  });

  it("stores no capabilities when none are given", async () => {
    const deps = makeDeps();
    const { io } = captureIo();

    const code = await run(ADD, deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ capabilities: {}, userSelectable: true }),
    );
  });

  it("honours --no-selectable", async () => {
    const deps = makeDeps();
    const { io } = captureIo();

    const code = await run([...ADD, "--no-selectable"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ userSelectable: false }),
    );
  });

  it("accepts --image-input required and writes it into capabilities", async () => {
    const deps = makeDeps();
    const { io } = captureIo();

    const code = await run([...ADD, "--image-input", "required"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ capabilities: { imageInput: "required" } }),
    );
  });

  it("writes capabilities.negativePrompt=true when --negative-prompt is passed", async () => {
    const deps = makeDeps();
    deps.agentStore.findImageProviderByName.mockResolvedValue(
      fakeProvider({ name: "venice", type: "venice" }),
    );
    const { io } = captureIo();

    const code = await run(
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
      deps,
      io,
    );

    expect(code).toBe(0);
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ capabilities: { negativePrompt: true } }),
    );
  });

  it("takes a description that starts with a dash as text", async () => {
    const deps = makeDeps();
    const { io } = captureIo();

    const code = await run(
      ["add", "fal/x", "--provider", "fal", "--model-string", "f", "--description", "-fast-"],
      deps,
      io,
    );

    expect(code).toBe(0);
    expect(deps.agentStore.createImageModel).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({ description: "-fast-" }),
    );
  });

  it.each([
    [["add"], /No value provided for name/],
    [["add", "fal/x"], /No value provided for --provider/],
    [["add", "fal/x", "--provider", "fal"], /No value provided for --model-string/],
    [
      ["add", "fal/x", "--provider", "fal", "--model-string", "f"],
      /No value provided for --description/,
    ],
    [["add", "fal/x", "--provider"], /No value provided for --provider/],
    [
      ["add", "fal/x", "--provider", "--model-string", "f", "--description", "d"],
      /got the flag "--model-string"/,
    ],
    [[...ADD.slice(0, -1), "", "--seed"], /argument 8 is empty/],
    [[...ADD.slice(0, -1), "  ", "--seed"], /expected text, got " {2}"/],
    [[...ADD, "--bogus"], /--bogus\n\s+\^ Unknown arguments/],
    [[...ADD, "--ratios", "horizontal"], /unknown aspect ratio "horizontal"; expected one of 1:1/],
    [[...ADD, "--ratios", " , ,"], /expected at least one aspect ratio, got " , ,"/],
    [[...ADD, "--ratios"], /--ratios\n\s+\^ Expected to get a value, found a flag/],
    [[...ADD, "--ratios", "--seed"], /unknown aspect ratio "--seed"/],
    [
      [...ADD, "--image-input", "kinda"],
      /Invalid value 'kinda'. Expected one of: 'required', 'optional'/,
    ],
    [[...ADD, "--image-input"], /--image-input\n\s+\^ Expected to get a value, found a flag/],
    [[...ADD, "--seed", "--seed"], /Expected 1 occurence, got 2/],
  ])("rejects %j with exit 2 and writes nothing", async (argv, message) => {
    const deps = makeDeps();
    const { io, out, err } = captureIo();

    const code = await run(argv, deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(out).toEqual([]);
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("reports an unknown provider with exit code 1", async () => {
    const deps = makeDeps();
    deps.agentStore.findImageProviderByName.mockResolvedValue(undefined);
    const { io, err } = captureIo();

    const code = await run(
      ["add", "fal/x", "--provider", "ghost", "--model-string", "f", "--description", "d"],
      deps,
      io,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No image provider named "ghost"/);
    expect(deps.agentStore.createImageModel).not.toHaveBeenCalled();
  });

  it("surfaces createImageModel failures as exit code 1", async () => {
    const deps = makeDeps();
    deps.agentStore.createImageModel.mockRejectedValue(new Error("duplicate name"));
    const { io, err } = captureIo();

    const code = await run(ADD, deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Failed to add image model: duplicate name/);
  });
});

describe("cogmo image-model list", () => {
  function depsWithCatalog() {
    const deps = makeDeps();
    deps.agentStore.listImageModelsWithProvider.mockImplementation(async (_tx, opts) => {
      // The hidden row only comes back when userSelectableOnly is false (--all).
      const visible = [
        fakeModel({ name: "fal/visible" }),
        fakeModel(
          {
            name: "venice/visible",
            capabilities: { imageInput: "optional", negativePrompt: true },
          },
          { name: "venice", type: "venice" },
        ),
      ];
      return opts?.userSelectableOnly
        ? visible
        : [...visible, fakeModel({ name: "fal/hidden", userSelectable: false })];
    });
    return deps;
  }

  it("lists the selectable models by default", async () => {
    const deps = depsWithCatalog();
    const { io, out } = captureIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.listImageModelsWithProvider).toHaveBeenCalledWith(FAKE_TX, {
      userSelectableOnly: true,
    });
    expect(out).toEqual([
      "name\tprovider\tmodel_string\tratios\tseed\timage_input\tneg_prompt\tselectable",
      "fal/visible\tfal\tfal-ai/flux/dev\t1:1\tyes\t-\tno\tyes",
      "venice/visible\tvenice\tfal-ai/flux/dev\t-\tno\toptional\tyes\tyes",
    ]);
  });

  it("includes hidden models with --all", async () => {
    const deps = depsWithCatalog();
    const { io, out } = captureIo();

    const code = await run(["list", "--all"], deps, io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/fal\/visible/);
    expect(out.join("\n")).toMatch(/fal\/hidden\t.*\tno$/m);
  });

  it("filters by --provider", async () => {
    const deps = depsWithCatalog();
    const { io, out } = captureIo();

    const code = await run(["list", "--provider", "venice", "--all"], deps, io);

    expect(code).toBe(0);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(/^venice\/visible\tvenice\t/);
  });

  it("prints (no image models) when nothing matches", async () => {
    const deps = makeDeps();
    deps.agentStore.listImageModelsWithProvider.mockResolvedValue([]);
    const { io, out } = captureIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(out).toEqual(["(no image models)"]);
  });

  it.each([
    [["list", "--provider"], /--provider\n\s+\^ Expected to get a value, found a flag/],
    [["list", "--provider", "--all"], /got the flag "--all"/],
    [["list", "--verbose"], /--verbose\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2 and lists nothing", async (argv, message) => {
    const { io, out, err } = captureIo();
    const loadDeps = vi.fn(async () => depsWithCatalog());

    const code = await runCli(imageModelCli(io, loadDeps), argv, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(out).toEqual([]);
    expect(loadDeps).not.toHaveBeenCalled();
  });
});

describe("cogmo image-model remove", () => {
  it("removes a model by name", async () => {
    const deps = makeDeps();
    deps.agentStore.listImageModels.mockResolvedValue([fakeModel({ name: "fal/flux-dev" })]);
    const { io, out } = captureIo();

    const code = await run(["remove", "fal/flux-dev"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.deleteImageModel).toHaveBeenCalledWith(FAKE_TX, "m-1");
    expect(out).toEqual(['Removed image model "fal/flux-dev".']);
  });

  it("reports not-found when removing an unknown model", async () => {
    const deps = makeDeps();
    deps.agentStore.listImageModels.mockResolvedValue([]);
    const { io, err } = captureIo();

    const code = await run(["remove", "ghost"], deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No image model named "ghost"/);
    expect(deps.agentStore.deleteImageModel).not.toHaveBeenCalled();
  });

  it("rejects a missing name with exit 2", async () => {
    const deps = makeDeps();
    const { io, err } = captureIo();

    const code = await run(["remove"], deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/No value provided for name/);
    expect(deps.agentStore.deleteImageModel).not.toHaveBeenCalled();
  });
});
