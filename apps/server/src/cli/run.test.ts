import { command, positional, subcommands } from "cmd-ts";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, EXIT_USAGE, runCli } from "./run.js";

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
