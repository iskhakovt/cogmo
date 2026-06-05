import { describe, expect, it, vi } from "vitest";
import { UniqueViolationError } from "../agent/store/errors.js";
import type { SubAgent } from "../agent/store/index.js";
import { fakeRunInTx, mockAgentStore } from "../test/factories.js";
import { runSubAgentCli } from "./subagent.js";

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
  };
}

function deps(overrides?: Parameters<typeof mockAgentStore>[0]) {
  return { runInTx: fakeRunInTx, agentStore: mockAgentStore(overrides) };
}

const routable = { listProvidersForModel: vi.fn().mockResolvedValue([{ providerId: "p1" }]) };

describe("runSubAgentCli", () => {
  it("prints usage on help and exits 0", async () => {
    const { io, out } = makeIo();
    expect(await runSubAgentCli(["help"], deps(), io)).toBe(0);
    expect(out.join("\n")).toContain("cogmo subagent <command>");
  });

  it("errors on an unknown command", async () => {
    const { io, err } = makeIo();
    expect(await runSubAgentCli(["frobnicate"], deps(), io)).toBe(1);
    expect(err.join("\n")).toContain("Unknown command");
  });

  describe("add", () => {
    it("registers a sub-agent against a routable model", async () => {
      const { io, out } = makeIo();
      const d = deps(routable);
      const code = await runSubAgentCli(
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
      const { io } = makeIo();
      const d = deps(routable);
      await runSubAgentCli(
        ["add", "writer", "--model", "m", "--description", "d", "--system-prompt", "Be terse."],
        d,
        io,
      );
      expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ systemPrompt: "Be terse." }),
      );
    });

    it("requires --model (exit 2)", async () => {
      const { io, err } = makeIo();
      expect(await runSubAgentCli(["add", "writer", "--description", "d"], deps(), io)).toBe(2);
      expect(err.join("\n")).toContain("--model is required");
    });

    it("requires --description (exit 2)", async () => {
      const { io, err } = makeIo();
      expect(await runSubAgentCli(["add", "writer", "--model", "m"], deps(), io)).toBe(2);
      expect(err.join("\n")).toContain("--description is required");
    });

    it("reports an unknown model with a pointer to `cogmo model`", async () => {
      // Default mockAgentStore → listProvidersForModel returns [] (not routable).
      const { io, err } = makeIo();
      const code = await runSubAgentCli(
        ["add", "writer", "--model", "ghost", "--description", "d"],
        deps(),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("ghost");
      expect(err.join("\n")).toContain("cogmo model");
    });

    it("reports a duplicate name", async () => {
      const { io, err } = makeIo();
      const code = await runSubAgentCli(
        ["add", "writer", "--model", "claude-test", "--description", "d"],
        deps({
          ...routable,
          createSubAgent: vi
            .fn()
            .mockRejectedValue(new UniqueViolationError("uq_sub_agents_user_name")),
        }),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain("already exists");
    });

    it("accepts the --flag=value form", async () => {
      const { io } = makeIo();
      const d = deps(routable);
      const code = await runSubAgentCli(
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

    it("passes a value that starts with dashes via the = form", async () => {
      const d = deps(routable);
      await runSubAgentCli(
        ["add", "writer", "--model=m", "--description=d", "--system-prompt=--- always JSON"],
        d,
        makeIo().io,
      );
      expect(d.agentStore.createSubAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ systemPrompt: "--- always JSON" }),
      );
    });

    it("errors (exit 2) when a flag has no value", async () => {
      const { io, err } = makeIo();
      expect(await runSubAgentCli(["add", "writer", "--model"], deps(), io)).toBe(2);
      expect(err.join("\n")).toContain("requires a value");
    });

    it("errors (exit 2) when a flag value is itself a flag", async () => {
      const { io, err } = makeIo();
      expect(
        await runSubAgentCli(["add", "writer", "--model", "--description", "d"], deps(), io),
      ).toBe(2);
      expect(err.join("\n")).toContain("requires a value");
    });
  });

  describe("list", () => {
    it("prints an empty marker when there are none", async () => {
      const { io, out } = makeIo();
      expect(await runSubAgentCli(["list"], deps(), io)).toBe(0);
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
      const { io, out } = makeIo();
      await runSubAgentCli(["list"], deps({ listSubAgents: vi.fn().mockResolvedValue(rows) }), io);
      const text = out.join("\n");
      expect(text).toContain("subagent__writer");
      expect(text).toContain("claude-test");
    });
  });

  describe("remove", () => {
    it("removes an existing sub-agent", async () => {
      const { io, out } = makeIo();
      expect(await runSubAgentCli(["remove", "writer"], deps(), io)).toBe(0);
      expect(out.join("\n")).toContain("Removed sub-agent");
    });

    it("reports a missing sub-agent (exit 1)", async () => {
      const { io, err } = makeIo();
      const code = await runSubAgentCli(
        ["remove", "ghost"],
        deps({ deleteSubAgent: vi.fn().mockResolvedValue({ deleted: false }) }),
        io,
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain('No sub-agent named "ghost"');
    });
  });
});
