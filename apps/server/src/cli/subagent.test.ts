import { err as failed } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { SubAgent } from "../agent/store/index.js";
import { captureIo, fakeRunInTx, mockAgentStore } from "../test/factories.js";
import { type CliIo, type LoadDeps, runCli } from "./run.js";
import { type SubAgentCliDeps, subAgentCli } from "./subagent.js";

function run(argv: readonly string[], deps: SubAgentCliDeps, io: CliIo): Promise<number> {
  return runCli(
    subAgentCli(io, async () => deps),
    argv,
    io,
  );
}

function deps(overrides?: Parameters<typeof mockAgentStore>[0]) {
  return { runInTx: fakeRunInTx, agentStore: mockAgentStore(overrides) };
}

const routable = { listProvidersForModel: vi.fn().mockResolvedValue([{ providerId: "p1" }]) };

describe("subAgentCli", () => {
  it.each([[[]], [["--help"]], [["add", "--help"]], [["list", "--help"]], [["remove", "--help"]]])(
    "prints help for %j on stdout, exits 0, and loads nothing",
    async (argv) => {
      const loadDeps = vi.fn<LoadDeps<SubAgentCliDeps>>(async () => deps());
      const { io, out, err } = captureIo();

      const code = await runCli(subAgentCli(io, loadDeps), argv, io);

      expect(code).toBe(0);
      expect(out.join("\n")).toMatch(/^subagent/);
      expect(err).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    },
  );

  it.each([["frobnicate"], ["help"]])("rejects %s as a subcommand (exit 2)", async (word) => {
    const { io, err } = captureIo();
    expect(await run([word], deps(), io)).toBe(2);
    expect(err.join("\n")).toMatch(new RegExp(`${word}\\n\\s+\\^ Not a valid subcommand name`));
  });

  describe("add", () => {
    it("registers a sub-agent against a routable model", async () => {
      const { io, out } = captureIo();
      const d = deps(routable);
      const code = await run(
        ["add", "writer", "--model", "claude-test", "--description", "long-form prose"],
        d,
        io,
      );
      expect(code).toBe(0);
      expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(expect.anything(), {
        userId: "user-1",
        name: "writer",
        description: "long-form prose",
        systemPrompt: null,
        model: "claude-test",
      });
      expect(out.join("\n")).toContain("Added sub-agent");
      expect(out.join("\n")).toContain("subagent__writer");
    });

    it("passes through an optional --system-prompt", async () => {
      const { io } = captureIo();
      const d = deps(routable);
      await run(
        ["add", "writer", "--model", "m", "--description", "d", "--system-prompt", "Be terse."],
        d,
        io,
      );
      expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ systemPrompt: "Be terse." }),
      );
    });

    it("reports an unknown model with a pointer to `cogmo model`", async () => {
      // Default mockAgentStore → listProvidersForModel returns [] (not routable).
      const { io, err } = captureIo();
      const code = await run(
        ["add", "writer", "--model", "ghost", "--description", "d"],
        deps(),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("ghost");
      expect(err.join("\n")).toContain("cogmo model");
    });

    it("reports a duplicate name", async () => {
      const { io, err } = captureIo();
      const code = await run(
        ["add", "writer", "--model", "claude-test", "--description", "d"],
        deps({
          ...routable,
          createSubAgent: vi
            .fn()
            .mockResolvedValue(failed({ kind: "sub_agent_name_taken", name: "writer" })),
        }),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("already exists");
    });

    it("accepts the --flag=value form", async () => {
      const { io } = captureIo();
      const d = deps(routable);
      const code = await run(
        ["add", "writer", "--model=claude-test", "--description=long-form prose"],
        d,
        io,
      );
      expect(code).toBe(0);
      expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ model: "claude-test", description: "long-form prose" }),
      );
    });

    it.each([[["--system-prompt=--- always JSON"]], [["--system-prompt", "--- always JSON"]]])(
      "passes a free-text value that starts with dashes (%j)",
      async (flag) => {
        const d = deps(routable);
        const code = await run(
          ["add", "writer", "--model=m", "--description=d", ...flag],
          d,
          captureIo().io,
        );
        expect(code).toBe(0);
        expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ systemPrompt: "--- always JSON" }),
        );
      },
    );

    it.each([
      [["writer", "--description", "d"], /No value provided for --model/],
      [["writer", "--model", "m"], /No value provided for --description/],
      [["writer", "--model"], /No value provided for --model/],
      [["writer", "--model", "m", "--description", "  "], /expected text, got " {2}"/],
      [
        ["Writer", "--model", "m", "--description", "d"],
        /Invalid sub-agent name "Writer": it must be lowercase/,
      ],
      [
        ["writer", "--modle", "x", "--description", "d"],
        /--modle x --description d\n\s+\^ Unknown arguments/,
      ],
      [["writer", "extra", "--model", "m", "--description", "d"], /Unknown arguments/],
      // A flag after --model is read as its value, then refused.
      [
        ["writer", "--model", "--description", "d"],
        /expected a value, got the flag "--description"/,
      ],
      [
        ["writer", "--description", "d", "--model", "--system-prompt"],
        /expected a value, got the flag "--system-prompt"/,
      ],
      // An optional option given no value is refused, not read as omitted.
      [
        ["writer", "--model", "m", "--description", "d", "--system-prompt"],
        /--system-prompt\n\s+\^ Expected to get a value, found a flag/,
      ],
    ])("rejects add %j with exit 2 before loading anything", async (args, message) => {
      const loadDeps = vi.fn<LoadDeps<SubAgentCliDeps>>(async () => deps(routable));
      const { io, out, err } = captureIo();

      const code = await runCli(subAgentCli(io, loadDeps), ["add", ...args], io);

      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(message);
      expect(out).toEqual([]);
      expect(loadDeps).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("prints an empty marker when there are none", async () => {
      const { io, out } = captureIo();
      expect(await run(["list"], deps(), io)).toBe(0);
      expect(out.join("\n")).toContain("(no sub-agents)");
    });

    it("prints a row per sub-agent", async () => {
      const rows: SubAgent[] = [
        {
          id: "sa-1",
          name: "writer",
          description: "prose",
          systemPrompt: "x",
          model: "claude-test",
        },
      ];
      const { io, out } = captureIo();
      await run(["list"], deps({ listSubAgents: vi.fn().mockResolvedValue(rows) }), io);
      const text = out.join("\n");
      expect(text).toContain("subagent__writer");
      expect(text).toContain("claude-test");
    });
  });

  describe("remove", () => {
    it("removes an existing sub-agent", async () => {
      const { io, out } = captureIo();
      expect(await run(["remove", "writer"], deps(), io)).toBe(0);
      expect(out.join("\n")).toContain("Removed sub-agent");
    });

    it("reports a missing sub-agent (exit 1)", async () => {
      const { io, err } = captureIo();
      const code = await run(
        ["remove", "ghost"],
        deps({ deleteSubAgent: vi.fn().mockResolvedValue({ deleted: false }) }),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain('No sub-agent named "ghost"');
    });

    it.each([
      [[], /No value provided for name/],
      [["--all"], /--all\n\s+\^ Unknown arguments/],
    ])("rejects remove %j with exit 2 before loading anything", async (args, message) => {
      const loadDeps = vi.fn<LoadDeps<SubAgentCliDeps>>(async () => deps());
      const { io, err } = captureIo();

      const code = await runCli(subAgentCli(io, loadDeps), ["remove", ...args], io);

      expect(code).toBe(2);
      expect(err.join("\n")).toMatch(message);
      expect(loadDeps).not.toHaveBeenCalled();
    });
  });
});
