import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../agent/store/index.js";
import { mockTransport } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import type { TelegramCommandContext } from "./commands.js";
import { ProfileDialogs } from "./profile-dialog.js";

function mkCtx(
  match?: string,
  chatId = 42,
): TelegramCommandContext & { reply: ReturnType<typeof vi.fn> } {
  return {
    chat: { id: chatId },
    from: { id: 1 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function mkProfile(overrides: Partial<Profile> & { id: string; name: string }): Profile {
  return {
    userId: "u1",
    basePrompt: "old prompt",
    model: "claude-sonnet-4-6",
    summarizationModel: null,
    extractionModel: null,
    autoRecall: "heuristic",
    voiceMode: "auto",
    toolSet: [],
    memoryScope: null,
    ...overrides,
  };
}

function transportWith(overrides: Partial<Transport> = {}): Transport {
  return mockTransport(overrides);
}

describe("ProfileDialogs - /profile new happy path", () => {
  it("walks prompt → model → confirm → profiles.create", async () => {
    const create = vi.fn().mockResolvedValue(ok(mkProfile({ id: "new-1", name: "coder" })));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create,
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue(["claude-sonnet-4-6"]) },
    });
    const dialogs = new ProfileDialogs();
    const ctx = mkCtx();

    await dialogs.startNew(transport, ctx, "coder");
    expect(dialogs.has(42)).toBe(true);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Step 1/3");

    await dialogs.handleMessage(transport, mkCtx("You are a coding assistant."));
    expect(ctx.reply).toHaveBeenCalledTimes(1); // second call hits the new ctx

    await dialogs.handleMessage(transport, mkCtx("claude-sonnet-4-6"));
    const confirmCtx = mkCtx("save");
    await dialogs.handleMessage(transport, confirmCtx);

    expect(create).toHaveBeenCalledWith("1", {
      name: "coder",
      basePrompt: "You are a coding assistant.",
      model: "claude-sonnet-4-6",
      toolSet: expect.any(Array),
    });
    expect(dialogs.has(42)).toBe(false);
    expect(confirmCtx.reply).toHaveBeenLastCalledWith('Profile "coder" created.');
  });

  it("rejects empty prompt and stays in prompt step", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startNew(transport, mkCtx(), "coder");

    const ctx = mkCtx("   ");
    await dialogs.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("can't be empty"));
    expect(dialogs.has(42)).toBe(true);
  });

  it("rejects duplicate name on startNew", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([mkProfile({ id: "p1", name: "coder" })])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    const ctx = mkCtx();
    await dialogs.startNew(transport, ctx, "coder");
    expect(dialogs.has(42)).toBe(false);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("already exists"));
  });

  it("cancel() in confirm step drops state without calling create", async () => {
    const create = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create,
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue([]) },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startNew(transport, mkCtx(), "coder");
    await dialogs.handleMessage(transport, mkCtx("prompt"));
    await dialogs.handleMessage(transport, mkCtx("model-x"));
    await dialogs.handleMessage(transport, mkCtx("cancel"));
    expect(create).not.toHaveBeenCalled();
    expect(dialogs.has(42)).toBe(false);
  });

  it("cancel() method clears state mid-dialog", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startNew(transport, mkCtx(), "coder");
    expect(dialogs.cancel(42)).toBe(true);
    expect(dialogs.has(42)).toBe(false);
    expect(dialogs.cancel(42)).toBe(false);
  });

  it("surfaces create errors (e.g. model_unavailable)", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi
          .fn()
          .mockResolvedValue(err({ code: "model_unavailable", model: "experimental" })),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue([]) },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startNew(transport, mkCtx(), "coder");
    await dialogs.handleMessage(transport, mkCtx("prompt"));
    await dialogs.handleMessage(transport, mkCtx("experimental"));
    const ctx = mkCtx("save");
    await dialogs.handleMessage(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("isn't available"));
    expect(dialogs.has(42)).toBe(false);
  });
});

describe("ProfileDialogs - /profile edit", () => {
  const existing = mkProfile({
    id: "p-existing",
    name: "coder",
    basePrompt: "old prompt text",
    model: "old-model",
  });

  function editTransport(create?: Partial<Transport>) {
    return transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([existing])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok(existing)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue(["new-model"]) },
      ...create,
    });
  }

  it("pre-seeds from existing profile and allows 'skip' at prompt step", async () => {
    const update = vi.fn().mockResolvedValue(ok(existing));
    const transport = editTransport({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([existing])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update,
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    const ctx = mkCtx();
    await dialogs.startEdit(transport, ctx, "coder");
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Editing profile");
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("old prompt text");

    // skip at prompt step — reuse old
    await dialogs.handleMessage(transport, mkCtx("skip"));
    // change the model
    await dialogs.handleMessage(transport, mkCtx("new-model"));
    await dialogs.handleMessage(transport, mkCtx("save"));

    // Only model should be in the update payload (basePrompt matches current → omitted)
    expect(update).toHaveBeenCalledWith("1", "p-existing", { model: "new-model" });
  });

  it("edit-with-both-skips replies 'no changes' and does NOT call profiles.update", async () => {
    // Regression guard: without the empty-changes early return, Drizzle would throw
    // "No values to set" when handed {} and the user would see "something went wrong".
    const update = vi.fn();
    const transport = editTransport({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([existing])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update,
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startEdit(transport, mkCtx(), "coder");
    await dialogs.handleMessage(transport, mkCtx("skip")); // prompt step
    await dialogs.handleMessage(transport, mkCtx("skip")); // model step
    const saveCtx = mkCtx("save");
    await dialogs.handleMessage(transport, saveCtx);

    expect(update).not.toHaveBeenCalled();
    expect(saveCtx.reply).toHaveBeenLastCalledWith('No changes to apply to "coder".');
  });

  it("rejects editing an org profile (user_id=null)", async () => {
    const orgProfile = mkProfile({ id: "p-org", name: "assistant", userId: null });
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([orgProfile])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    const ctx = mkCtx();
    await dialogs.startEdit(transport, ctx, "assistant");
    expect(dialogs.has(42)).toBe(false);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("org profile"));
  });

  it("rejects unknown profile name", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    const ctx = mkCtx();
    await dialogs.startEdit(transport, ctx, "ghost");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No profile named "ghost"'));
    expect(dialogs.has(42)).toBe(false);
  });
});

describe("ProfileDialogs - isolation", () => {
  it("state is scoped per chatId", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = new ProfileDialogs();
    await dialogs.startNew(transport, mkCtx(undefined, 100), "alice-profile");
    expect(dialogs.has(100)).toBe(true);
    expect(dialogs.has(200)).toBe(false);
  });
});
