import { command, optional, positional, string, subcommands } from "cmd-ts";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, EXIT_USAGE, loadCommandGroups, runCli } from "./run.js";

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
}

function exitWith(code: number) {
  return command({
    name: "exit",
    args: {},
    handler: async () => code,
  });
}

describe("runCli", () => {
  it("resolves to a command's exit code", async () => {
    const { io } = makeIo();

    expect(await runCli(exitWith(3), [], io)).toBe(3);
  });

  it("unwraps the exit code through nested subcommands", async () => {
    const cli = subcommands({
      name: "cogmo",
      cmds: {
        outer: subcommands({ name: "outer", cmds: { inner: exitWith(1) } }),
        ok: exitWith(0),
      },
    });
    const { io } = makeIo();

    expect(await runCli(cli, ["outer", "inner"], io)).toBe(1);
    expect(await runCli(cli, ["ok"], io)).toBe(0);
  });

  it("prints help to out and exits 0 without running the handler", async () => {
    const handler = vi.fn(async () => 0);
    const cli = subcommands({
      name: "cogmo",
      cmds: { go: command({ name: "go", description: "Go somewhere.", args: {}, handler }) },
    });
    const { io, out, err } = makeIo();

    expect(await runCli(cli, ["--help"], io)).toBe(0);
    expect(await runCli(cli, [], io)).toBe(0);
    expect(await runCli(cli, ["go", "-h"], io)).toBe(0);

    expect(out.join("\n")).toContain("Go somewhere.");
    expect(err).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a malformed command line on err with the usage exit code", async () => {
    const handler = vi.fn(async () => 0);
    const cli = command({
      name: "greet",
      args: { name: positional({ displayName: "name" }) },
      handler,
    });
    const { io, out, err } = makeIo();

    expect(await runCli(cli, [], io)).toBe(EXIT_USAGE);
    expect(await runCli(cli, ["ada", "--loud"], io)).toBe(EXIT_USAGE);

    expect(err.join("\n")).toContain("No value provided for name");
    expect(err.join("\n")).toMatch(/--loud\n\s+\^ Unknown arguments/);
    expect(out).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects an unknown subcommand with the usage exit code and a suggestion", async () => {
    const cli = subcommands({ name: "cogmo", cmds: { provider: exitWith(0) } });
    const { io, err } = makeIo();

    expect(await runCli(cli, ["provder"], io)).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("Not a valid subcommand name");
    expect(err.join("\n")).toContain("Did you mean provider?");
  });

  it.each([[["", "https://x/v1"]], [["key", "", "https://x/v1"]], [["key", "--", ""]]])(
    "rejects the empty argument in %j before cmd-ts drops it",
    async (argv) => {
      const handler = vi.fn(async () => 0);
      const cli = command({
        name: "add",
        args: {
          apiKey: positional({ displayName: "api-key" }),
          baseUrl: positional({ type: optional(string), displayName: "base-url" }),
        },
        handler,
      });
      const { io, err } = makeIo();

      expect(await runCli(cli, argv, io)).toBe(EXIT_USAGE);
      expect(err.join("\n")).toMatch(/argument \d is empty/);
      expect(handler).not.toHaveBeenCalled();
    },
  );

  describe("a value starting with a single dash", () => {
    const handler = vi.fn(async (_args: { apiKey: string }) => 0);
    const cli = command({
      name: "add",
      args: { apiKey: positional({ displayName: "api-key" }) },
      handler,
    });

    it("is refused when cmd-ts would read it as flags including -h", async () => {
      const { io, out, err } = makeIo();

      expect(await runCli(cli, ["-q8hZ"], io)).toBe(EXIT_USAGE);
      expect(err.join("\n")).toContain('"-q8hZ" reads as short flags, -h among them');
      expect(out).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
    });

    it("reaches the handler after --", async () => {
      const { io } = makeIo();

      expect(await runCli(cli, ["--", "-q8hZ"], io)).toBe(0);
      expect(handler).toHaveBeenCalledWith({ apiKey: "-q8hZ" });
    });
  });

  it("lets a handler's exception propagate", async () => {
    const cli = command({
      name: "boom",
      args: {},
      handler: async () => {
        throw new Error("store unreachable");
      },
    });
    const { io } = makeIo();

    await expect(runCli(cli, [], io)).rejects.toThrow("store unreachable");
  });

  it("throws when a handler resolves to something other than an exit code", async () => {
    const cli = command({ name: "void", args: {}, handler: async () => undefined });
    const { io } = makeIo();

    await expect(runCli(cli, [], io)).rejects.toThrow(
      "CLI handler resolved to undefined instead of an exit code",
    );
  });
});

describe("loadCommandGroups", () => {
  function groups() {
    const provider = subcommands({
      name: "provider",
      description: "Manage providers.",
      cmds: { list: exitWith(0) },
    });
    const model = subcommands({
      name: "model",
      description: "Manage models.",
      cmds: { list: exitWith(1) },
    });
    return { provider: vi.fn(async () => provider), model: vi.fn(async () => model) };
  }
  const builtIns = { "gen-key": exitWith(0) };

  it("loads only the group the command line names", async () => {
    const load = groups();

    const cmds = await loadCommandGroups(["provider", "list"], builtIns, load);

    expect(load.provider).toHaveBeenCalledOnce();
    expect(load.model).not.toHaveBeenCalled();
    expect(Object.keys(cmds)).toEqual(["gen-key", "provider", "model"]);
    const { io } = makeIo();
    expect(await runCli(subcommands({ name: "cogmo", cmds }), ["provider", "list"], io)).toBe(0);
  });

  it("loads no group for a built-in command", async () => {
    const load = groups();

    await loadCommandGroups(["gen-key"], builtIns, load);

    expect(load.provider).not.toHaveBeenCalled();
    expect(load.model).not.toHaveBeenCalled();
  });

  it.each([[[]], [["--help"]], [["provder", "list"]]])(
    "loads every group when %j names no known command",
    async (argv) => {
      const load = groups();

      const cmds = await loadCommandGroups(argv, builtIns, load);

      expect(load.provider).toHaveBeenCalledOnce();
      expect(load.model).toHaveBeenCalledOnce();
      const { io, out, err } = makeIo();
      await runCli(subcommands({ name: "cogmo", cmds }), argv, io);
      expect([...out, ...err].join("\n")).toMatch(/Manage models\.|Did you mean provider\?/);
    },
  );

  it.each([[["toString"]], [["-x", "model", "provider"]]])(
    "loads every group when %j does not lead with a command",
    async (argv) => {
      const load = groups();

      await loadCommandGroups(argv, builtIns, load);

      expect(load.provider).toHaveBeenCalledOnce();
      expect(load.model).toHaveBeenCalledOnce();
    },
  );

  it("registers every group's name, a placeholder standing in for each unloaded one", async () => {
    const cmds = await loadCommandGroups(["provider"], builtIns, groups());
    const { io, err } = makeIo();

    await expect(runCli(subcommands({ name: "cogmo", cmds }), ["model"], io)).rejects.toThrow(
      "`model` ran without its command group loaded",
    );
    expect(err).toEqual([]);
  });
});
