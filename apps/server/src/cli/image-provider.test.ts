import { describe, expect, it, vi } from "vitest";
import { mock } from "vitest-mock-extended";
import { InvalidProviderConfigError } from "../agent/store/errors.js";
import type { AgentStore, ImageProviderRow } from "../agent/store/index.js";
import type { Transactor } from "../db/index.js";
import type { SecretsStore } from "../secrets/store/index.js";
import { type ImageProviderCliDeps, imageProviderCli } from "./image-provider.js";
import { type CliIo, runCli } from "./run.js";

function run(argv: readonly string[], deps: ImageProviderCliDeps, io: CliIo): Promise<number> {
  return runCli(
    imageProviderCli(io, async () => deps),
    argv,
    io,
  );
}

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function makeDeps() {
  const deps = {
    runInTx: fakeRunInTx,
    agentStore: mock<AgentStore>(),
    secretsStore: mock<SecretsStore>(),
  };
  deps.secretsStore.putSecret.mockResolvedValue({ id: "sec-1" });
  deps.agentStore.createImageProvider.mockResolvedValue({ id: "p-new" });
  return deps;
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

const VENICE = ["add", "venice", "venice", "sk-venice", "https://api.venice.ai/api/v1"];

describe("cogmo image-provider — command line", () => {
  it("prints help and exits 0 when given no command", async () => {
    const { io, out } = makeIo();

    const code = await run([], makeDeps(), io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/image-provider <subcommand>/);
  });

  it("answers --help on a subcommand without loading dependencies", async () => {
    const { io, out, err } = makeIo();
    const loadDeps = vi.fn(async () => makeDeps());

    const code = await runCli(imageProviderCli(io, loadDeps), ["add", "--help"], io);

    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/image-provider add/);
    expect(out.join("\n")).toMatch(/--cfg-scale <0-20>/);
    expect(err).toEqual([]);
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("rejects an unknown command with exit 2", async () => {
    const { io, err } = makeIo();

    const code = await run(["bogosity"], makeDeps(), io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/bogosity\n\s+\^ Not a valid subcommand name/);
  });

  it("lets an unexpected store failure propagate to the caller", async () => {
    const deps = makeDeps();
    deps.agentStore.listImageProviders.mockRejectedValue(new Error("db gone"));
    const { io } = makeIo();

    await expect(run(["list"], deps, io)).rejects.toThrow("db gone");
  });
});

describe("cogmo image-provider list", () => {
  it("lists providers", async () => {
    const deps = makeDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([
      makeProviderRow({ name: "fal" }),
      makeProviderRow({
        name: "venice",
        type: "openai_compatible",
        baseUrl: "https://api.venice.ai/api/v1",
      }),
    ]);
    const { io, out } = makeIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(out).toEqual([
      "name\ttype\tbase_url",
      "fal\tfal\t-",
      "venice\topenai_compatible\thttps://api.venice.ai/api/v1",
    ]);
  });

  it('reports "no providers" when the catalog is empty', async () => {
    const deps = makeDeps();
    deps.agentStore.listImageProviders.mockResolvedValue([]);
    const { io, out } = makeIo();

    const code = await run(["list"], deps, io);

    expect(code).toBe(0);
    expect(out).toEqual(["(no image providers registered)"]);
  });
});

describe("cogmo image-provider add", () => {
  it("creates a fal provider (writes secret + provider row)", async () => {
    const deps = makeDeps();
    deps.secretsStore.putSecret.mockResolvedValue({ id: "sec-fal" });
    deps.agentStore.createImageProvider.mockResolvedValue({ id: "p-fal" });
    const { io, out } = makeIo();

    const code = await run(["add", "fal", "fal", "sk-fal"], deps, io);

    expect(code).toBe(0);
    expect(deps.secretsStore.putSecret).toHaveBeenCalledWith(FAKE_TX, {
      name: "fal_api_key",
      plaintext: "sk-fal",
      description: "fal image provider key (fal)",
    });
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(FAKE_TX, {
      name: "fal",
      type: "fal",
      baseUrl: null,
      secretId: "sec-fal",
      attrs: {},
    });
    expect(out).toEqual([
      'Added image provider "fal" (id=p-fal, secret=fal_api_key).',
      "Next: cogmo image-model add <model-name> --provider fal --model-string <id>",
    ]);
  });

  it("creates a venice provider with safe_mode off", async () => {
    const deps = makeDeps();
    const { io, out } = makeIo();

    const code = await run([...VENICE, "--safe-mode", "false"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
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

  it("forwards all four venice extras into imageGenerationDefaults", async () => {
    // The wizard docs and image-generation.md point operators at these four
    // options; this pins that each one lands in the row.
    const deps = makeDeps();
    const { io } = makeIo();

    const code = await run(
      [
        ...VENICE,
        "--safe-mode",
        "false",
        "--cfg-scale",
        "7.5",
        "--hide-watermark",
        "true",
        "--style-preset",
        "Photographic",
      ],
      deps,
      io,
    );

    expect(code).toBe(0);
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
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
  });

  it("accepts the --option=value form", async () => {
    const deps = makeDeps();
    const { io } = makeIo();

    const code = await run([...VENICE, "--cfg-scale=0", "--hide-watermark=false"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.createImageProvider).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        attrs: { imageGenerationDefaults: { cfg_scale: 0, hide_watermark: false } },
      }),
    );
  });

  it.each([
    [
      ["add", "bogus", "foo", "sk-key"],
      /Invalid value 'bogus'. Expected one of: 'fal', 'openai_compatible', 'venice'/,
    ],
    [["add", "fal", "Bad Name", "sk-fal"], /Invalid name "Bad Name": must start with a lowercase/],
    [["add", "fal", "fal"], /No value provided for api-key/],
    [["add", "fal", "fal", "sk", "https://x", "extra"], /extra\n\s+\^ Unknown arguments/],
    [[...VENICE, "--cfg-scale", "25"], /expected a number from 0 to 20, got "25"/],
    [[...VENICE, "--cfg-scale", "7x"], /expected a number from 0 to 20, got "7x"/],
    [[...VENICE, "--cfg-scale", "", "--safe-mode", "true"], /argument 7 is empty/],
    [
      [...VENICE, "--safe-mode", "maybe"],
      /Invalid value 'maybe'. Expected one of: 'true', 'false'/,
    ],
    [
      [...VENICE, "--hide-watermark", "yes"],
      /Invalid value 'yes'. Expected one of: 'true', 'false'/,
    ],
    [[...VENICE, "--safe-mode"], /--safe-mode\n\s+\^ Expected to get a value, found a flag/],
    [[...VENICE, "--cfg-scale"], /--cfg-scale\n\s+\^ Expected to get a value, found a flag/],
    [[...VENICE, "--style-preset"], /--style-preset\n\s+\^ Expected to get a value, found a flag/],
    [[...VENICE, "--style-preset", "", "--safe-mode", "true"], /argument 7 is empty/],
    [[...VENICE, "--style-preset", "--safe-mode", "true"], /got the flag "--safe-mode"/],
    [[...VENICE, "--safe-mode", "true", "--safe-mode", "false"], /Too many times provided/],
  ])("rejects %j with exit 2 and writes nothing", async (argv, message) => {
    const deps = makeDeps();
    const { io, out, err } = makeIo();

    const code = await run(argv, deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(out).toEqual([]);
    expect(deps.secretsStore.putSecret).not.toHaveBeenCalled();
    expect(deps.agentStore.createImageProvider).not.toHaveBeenCalled();
  });

  it("rejects venice extras for a non-venice type before loading dependencies", async () => {
    const { io, err } = makeIo();
    const loadDeps = vi.fn(async () => makeDeps());

    const code = await runCli(
      imageProviderCli(io, loadDeps),
      ["add", "openai_compatible", "openai", "sk-openai", "https://x", "--safe-mode", "true"],
      io,
    );

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(
      /--safe-mode \/ --cfg-scale \/ --hide-watermark \/ --style-preset are venice-only \(got type=openai_compatible\)/,
    );
    expect(loadDeps).not.toHaveBeenCalled();
  });

  it("maps InvalidProviderConfigError to exit code 2", async () => {
    const deps = makeDeps();
    deps.agentStore.createImageProvider.mockRejectedValue(
      new InvalidProviderConfigError("not allowed here"),
    );
    const { io, err } = makeIo();

    const code = await run(["add", "fal", "fal", "sk"], deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/Invalid config: not allowed here/);
  });

  it("maps generic creation failures to exit code 1", async () => {
    const deps = makeDeps();
    deps.agentStore.createImageProvider.mockRejectedValue(new Error("upstream timeout"));
    const { io, err } = makeIo();

    const code = await run(["add", "fal", "fal", "sk"], deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Failed to add image provider: upstream timeout/);
  });
});

describe("cogmo image-provider remove", () => {
  it("removes a provider by name", async () => {
    const deps = makeDeps();
    deps.agentStore.findImageProviderByName.mockResolvedValue(makeProviderRow({ name: "fal" }));
    const { io, out } = makeIo();

    const code = await run(["remove", "fal"], deps, io);

    expect(code).toBe(0);
    expect(deps.agentStore.findImageProviderByName).toHaveBeenCalledWith(FAKE_TX, "fal");
    expect(deps.agentStore.deleteImageProvider).toHaveBeenCalledWith(FAKE_TX, "p-1");
    expect(out.join("\n")).toMatch(/Removed image provider "fal"/);
  });

  it("reports not-found when removing an unknown provider", async () => {
    const deps = makeDeps();
    deps.agentStore.findImageProviderByName.mockResolvedValue(undefined);
    const { io, err } = makeIo();

    const code = await run(["remove", "ghost"], deps, io);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No image provider named "ghost"/);
    expect(deps.agentStore.deleteImageProvider).not.toHaveBeenCalled();
  });

  it.each([
    [["remove"], /No value provided for name/],
    [["remove", "fal", "extra"], /extra\n\s+\^ Unknown arguments/],
  ])("rejects %j with exit 2 and deletes nothing", async (argv, message) => {
    const deps = makeDeps();
    const { io, err } = makeIo();

    const code = await run(argv, deps, io);

    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(message);
    expect(deps.agentStore.deleteImageProvider).not.toHaveBeenCalled();
  });
});
