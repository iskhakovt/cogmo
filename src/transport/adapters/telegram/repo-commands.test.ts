import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { type DeepPartial, mockTransportDeep } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import { handleRepo, type TelegramCommandContext } from "./commands.js";
import { RepoDialogs } from "./repo-dialog.js";

function mkCtx(match?: string): TelegramCommandContext & { reply: ReturnType<typeof vi.fn> } {
  return {
    chat: { id: 42 },
    from: { id: 1 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function transportWith(overrides: DeepPartial<Transport> = {}): Transport {
  return mockTransportDeep(overrides);
}

describe("handleRepo", () => {
  describe("list", () => {
    it("default subcommand is `list`", async () => {
      const list = vi.fn().mockResolvedValue(ok([]));
      const transport = transportWith({
        repos: {
          list,
          add: vi.fn(),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx();
      await handleRepo(transport, ctx);
      expect(list).toHaveBeenCalledTimes(1);
    });

    it("renders empty-list hint when no repos", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn().mockResolvedValue(ok([])),
          add: vi.fn(),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx("list");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No repos registered"));
    });

    it("renders one line per repo with name + path + branch", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn().mockResolvedValue(
            ok([
              {
                id: "r1",
                name: "cogmo",
                localPath: "/repos/cogmo",
                defaultBranch: "main",
                remoteUrl: "git@github.com:user/cogmo.git",
                verifyCommand: "true",
              },
              {
                id: "r2",
                name: "notes",
                localPath: "/repos/notes",
                defaultBranch: "trunk",
                remoteUrl: "git@github.com:user/notes.git",
                verifyCommand: "pnpm test",
              },
            ]),
          ),
          add: vi.fn(),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx("list");
      await handleRepo(transport, ctx);
      const reply = ctx.reply.mock.calls[0]?.[0] as string;
      expect(reply).toContain("cogmo — /repos/cogmo (branch: main)");
      expect(reply).toContain("notes — /repos/notes (branch: trunk)");
    });

    it("propagates sandbox_disabled error", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn().mockResolvedValue(err({ code: "sandbox_disabled" as const })),
          add: vi.fn(),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx("list");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("SANDBOX_RUNTIME"));
    });
  });

  describe("add", () => {
    it("requires name + local_path + remote_url", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn(),
          add: vi.fn(),
          cloneAndAdd: vi.fn(),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx("add cogmo");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /repo"));
    });

    it("bare `/repo add` without args starts the FSM dialog when one is supplied", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn().mockResolvedValue(ok([])),
          add: vi.fn(),
          cloneAndAdd: vi.fn(),
          remove: vi.fn(),
        },
      });
      const dialogs = new RepoDialogs();
      const ctx = mkCtx("add");
      await handleRepo(transport, ctx, dialogs);
      expect(dialogs.has(ctx.chat.id)).toBe(true);
      expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/Step 1\/3/);
    });

    it("bare `/repo add` falls back to the usage hint when no dialog is supplied", async () => {
      const transport = transportWith({
        repos: { list: vi.fn(), add: vi.fn(), cloneAndAdd: vi.fn(), remove: vi.fn() },
      });
      const ctx = mkCtx("add");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /repo"));
    });

    it("calls repos.add with parsed args and confirms on success", async () => {
      const add = vi.fn().mockResolvedValue(
        ok({
          id: "r1",
          name: "cogmo",
          localPath: "/repos/cogmo",
          defaultBranch: "main",
          remoteUrl: "git@github.com:user/cogmo.git",
          verifyCommand: "true",
        }),
      );
      const transport = transportWith({
        repos: { list: vi.fn(), add, remove: vi.fn() },
      });
      const ctx = mkCtx("add cogmo /repos/cogmo git@github.com:user/cogmo.git");
      await handleRepo(transport, ctx);
      expect(add).toHaveBeenCalledWith({
        name: "cogmo",
        localPath: "/repos/cogmo",
        remoteUrl: "git@github.com:user/cogmo.git",
      });
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Repo "cogmo" added.'));
    });

    it("reports name collision via repo_name_taken", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn(),
          add: vi.fn().mockResolvedValue(err({ code: "repo_name_taken" as const, name: "cogmo" })),
          remove: vi.fn(),
        },
      });
      const ctx = mkCtx("add cogmo /p git@x:y/z.git");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    });
  });

  describe("remove", () => {
    it("requires a name", async () => {
      const transport = transportWith({
        repos: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
      });
      const ctx = mkCtx("remove");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /repo"));
    });

    it("removes by name and confirms", async () => {
      const remove = vi.fn().mockResolvedValue(ok(undefined));
      const transport = transportWith({
        repos: { list: vi.fn(), add: vi.fn(), remove },
      });
      const ctx = mkCtx("remove cogmo");
      await handleRepo(transport, ctx);
      expect(remove).toHaveBeenCalledWith("cogmo");
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('"cogmo" removed'));
    });

    it("rm is an alias for remove", async () => {
      const remove = vi.fn().mockResolvedValue(ok(undefined));
      const transport = transportWith({
        repos: { list: vi.fn(), add: vi.fn(), remove },
      });
      const ctx = mkCtx("rm cogmo");
      await handleRepo(transport, ctx);
      expect(remove).toHaveBeenCalledWith("cogmo");
    });

    it("reports repo_not_found", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn(),
          add: vi.fn(),
          remove: vi.fn().mockResolvedValue(err({ code: "repo_not_found" as const, name: "nope" })),
        },
      });
      const ctx = mkCtx("remove nope");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No repo named "nope"'));
    });

    it("reports repo_in_use with active task count", async () => {
      const transport = transportWith({
        repos: {
          list: vi.fn(),
          add: vi.fn(),
          remove: vi
            .fn()
            .mockResolvedValue(
              err({ code: "repo_in_use" as const, name: "cogmo", activeTasks: 3 }),
            ),
        },
      });
      const ctx = mkCtx("remove cogmo");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("3 active task"));
    });
  });

  describe("unknown subcommand", () => {
    it("shows usage", async () => {
      const transport = transportWith({
        repos: { list: vi.fn(), add: vi.fn(), remove: vi.fn() },
      });
      const ctx = mkCtx("frobnicate");
      await handleRepo(transport, ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /repo"));
    });
  });
});
