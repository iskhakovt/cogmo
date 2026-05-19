import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockTransport } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import type { TelegramCommandContext } from "./commands.js";
import { RepoDialogs } from "./repo-dialog.js";

function mkCtx(text?: string): TelegramCommandContext & { reply: ReturnType<typeof vi.fn> } {
  return {
    chat: { id: 100 },
    from: { id: 1 },
    match: text,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function transportWith(overrides: Partial<Transport> = {}): Transport {
  return mockTransport(overrides);
}

describe("RepoDialogs", () => {
  it("start() initialises state and prompts for the name", async () => {
    const dlg = new RepoDialogs();
    const ctx = mkCtx();
    await dlg.start(ctx);
    expect(dlg.has(100)).toBe(true);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/Step 1\/3 — name/);
  });

  it("rejects empty names without consuming the slot", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith();
    await dlg.start(mkCtx());
    const ctx = mkCtx("");
    const consumed = await dlg.handleMessage(transport, ctx);
    expect(consumed).toBe(true);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("can't be empty"));
    expect(dlg.has(100)).toBe(true);
  });

  it("rejects names with disallowed characters", async () => {
    const dlg = new RepoDialogs();
    await dlg.start(mkCtx());
    const ctx = mkCtx("bad name!");
    await dlg.handleMessage(transportWith(), ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("[a-zA-Z0-9._-]"));
    expect(dlg.has(100)).toBe(true);
  });

  it("rejects a name that collides with an existing repo", async () => {
    const dlg = new RepoDialogs();
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "r1",
          name: "cogmo",
          localPath: "/repos/cogmo",
          defaultBranch: "main",
          remoteUrl: "git@github.com:user/cogmo.git",
          verifyCommand: "true",
        },
      ]),
    );
    const transport = transportWith({
      repos: {
        list,
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    const ctx = mkCtx("cogmo");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(dlg.has(100)).toBe(true);
  });

  it("walks name → remote → confirm → save and calls cloneAndAdd", async () => {
    const dlg = new RepoDialogs();
    const cloneAndAdd = vi.fn().mockResolvedValue(
      ok({
        id: "r1",
        name: "notes",
        localPath: "/repos/notes",
        defaultBranch: "main",
        remoteUrl: "https://github.com/u/notes.git",
        verifyCommand: "true",
      }),
    );
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd,
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());

    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const finalCtx = mkCtx("save");
    await dlg.handleMessage(transport, finalCtx);

    expect(cloneAndAdd).toHaveBeenCalledWith({
      name: "notes",
      remoteUrl: "https://github.com/u/notes.git",
    });
    expect(finalCtx.reply.mock.calls.at(-1)?.[0]).toMatch(/Repo "notes" added/);
    expect(dlg.has(100)).toBe(false);
  });

  it("/cancel at the confirm step clears state", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("cancel");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Cancelled.");
    expect(dlg.has(100)).toBe(false);
  });

  it("at confirm, neither save nor cancel keeps the dialog alive with a hint", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("yes");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Reply 'save'"));
    expect(dlg.has(100)).toBe(true);
  });

  it("surfaces clone failures and clears the dialog", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(
          err({
            code: "repo_clone_failed" as const,
            reason: "fatal: Authentication failed",
          }),
        ),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/Authentication failed/);
    expect(dlg.has(100)).toBe(false);
  });

  it("surfaces repo_local_path_exists and clears the dialog", async () => {
    // The transport rejects when the host directory is already populated
    // (the operator manually placed something there, or a prior aborted
    // clone left files). The dialog must surface the path and clear
    // state — the user can't retry from the same dialog without first
    // moving the directory aside.
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(
          err({
            code: "repo_local_path_exists" as const,
            path: "/var/lib/cogmo/repos/notes",
          }),
        ),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/\/var\/lib\/cogmo\/repos\/notes/);
    expect(dlg.has(100)).toBe(false);
  });

  it("surfaces transport-side repo_invalid_input with field+reason and clears the dialog", async () => {
    // The dialog has client-side regex validation for the name; this
    // covers the *transport* rejecting input it considers invalid (e.g.
    // a remote URL the parser cannot interpret, even if it passed the
    // dialog's permissive textual check). Distinct error path from the
    // earlier "rejects names with disallowed characters" client-side
    // tests.
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(
          err({
            code: "repo_invalid_input" as const,
            field: "remoteUrl",
            reason: "could not parse owner/repo from URL",
          }),
        ),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    // URL passes the dialog's permissive client-side regex; the
    // transport-side validator is mocked to reject it. The dialog
    // surfaces whatever the transport returned.
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    const reply = ctx.reply.mock.calls.at(-1)?.[0] as string;
    expect(reply).toMatch(/remoteUrl/);
    expect(reply).toMatch(/could not parse/);
    expect(dlg.has(100)).toBe(false);
  });

  it("surfaces github_identity_unavailable verbatim", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(
          err({
            code: "github_identity_unavailable" as const,
            reason: "GitHub identity 'default' is not configured.",
          }),
        ),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("git@github.com:u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/not configured/);
  });

  it("cancel() returns false when no dialog is active", () => {
    const dlg = new RepoDialogs();
    expect(dlg.cancel(100)).toBe(false);
  });

  it("handleMessage returns false when no dialog is active", async () => {
    const dlg = new RepoDialogs();
    const consumed = await dlg.handleMessage(transportWith(), mkCtx("hello"));
    expect(consumed).toBe(false);
  });

  it("rejects empty URL at the remote step (and keeps the dialog alive)", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    const ctx = mkCtx("");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("URL can't be empty"));
    expect(dlg.has(100)).toBe(true);
  });

  it("rejects URL that fails parseRemoteUrl (typo / missing host)", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    const ctx = mkCtx("not-a-url");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("doesn't look like a git remote URL"),
    );
    expect(dlg.has(100)).toBe(true);
  });

  it("surfaces a transport error from list() and clears the dialog", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const })),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    const ctx = mkCtx("notes");
    await dlg.handleMessage(transport, ctx);
    expect(dlg.has(100)).toBe(false);
  });

  it("'cancel' at the confirm step clears state (lowercase variant)", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn(),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("cancel");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Cancelled.");
    expect(dlg.has(100)).toBe(false);
  });

  it("surfaces sandbox_disabled friendly error", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(err({ code: "sandbox_disabled" as const })),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/SANDBOX_RUNTIME/);
  });

  it("surfaces repo_name_taken friendly error", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi
          .fn()
          .mockResolvedValue(err({ code: "repo_name_taken" as const, name: "notes" })),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/"notes" already exists/);
  });

  it("falls back to generic message for an unknown error code (default branch)", async () => {
    const dlg = new RepoDialogs();
    const transport = transportWith({
      repos: {
        list: vi.fn().mockResolvedValue(ok([])),
        add: vi.fn(),
        cloneAndAdd: vi.fn().mockResolvedValue(err({ code: "operation_not_permitted" as const })),
        remove: vi.fn(),
      },
    });
    await dlg.start(mkCtx());
    await dlg.handleMessage(transport, mkCtx("notes"));
    await dlg.handleMessage(transport, mkCtx("https://github.com/u/notes.git"));
    const ctx = mkCtx("save");
    await dlg.handleMessage(transport, ctx);
    expect(ctx.reply.mock.calls.at(-1)?.[0]).toMatch(/Something went wrong/);
  });
});
