import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockTransport } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import {
  handleEnd,
  handleModel,
  handleName,
  handlePlanCallback,
  handleProfile,
  handleResume,
  handleResumeCallback,
  handleSessions,
  type TelegramCommandContext,
} from "./commands.js";
import { ProfileDialogs } from "./profile-dialog.js";

function mkCtx(match?: string): TelegramCommandContext & { reply: ReturnType<typeof vi.fn> } {
  return {
    chat: { id: 42 },
    from: { id: 1 },
    match,
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function transportWith(overrides: Partial<Transport> = {}): Transport {
  return mockTransport(overrides);
}

function mkDialogs(): ProfileDialogs {
  return new ProfileDialogs();
}

describe("handleSessions", () => {
  it("renders keyboard and includes current marker", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "c1",
              profileName: "assistant",
              alias: "work",
              lastMessagePreview: "hi",
              lastMessageAt: new Date(),
            },
          ]),
        ),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p1", profileName: "assistant", model: "m" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx();
    await handleSessions(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [text, options] = ctx.reply.mock.calls[0]!;
    expect(text).toBe("Select a conversation:");
    expect(options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("resume:work");
  });

  it("maps identity_rejected to a user-friendly message", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx();
    await handleSessions(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });
});

describe("handleResume", () => {
  it("replies with usage when alias missing", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleResume(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /resume"));
  });

  it("delegates to resumeConversation with alias", async () => {
    const transport = transportWith();
    const ctx = mkCtx("work");
    await handleResume(transport, ctx);
    expect(transport.resumeConversation).toHaveBeenCalledWith("42", "1", { alias: "work" });
    expect(ctx.reply).toHaveBeenCalledWith('Resumed conversation "work".');
  });

  it("maps conversation_not_found to friendly error", async () => {
    const transport = transportWith({
      resumeConversation: vi.fn().mockResolvedValue(err({ code: "conversation_not_found" })),
    });
    const ctx = mkCtx("ghost");
    await handleResume(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Conversation not found.");
  });
});

describe("handleName", () => {
  const activeSession = {
    id: "s1",
    channelId: "ch",
    platformAddress: "42",
    conversationId: "c1",
    status: "active" as const,
    receive: "routed" as const,
  };

  it("sets alias on current conversation", async () => {
    const setAlias = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias,
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("work");
    await handleName(transport, ctx);
    expect(setAlias).toHaveBeenCalledWith("1", "c1", "work");
    expect(ctx.reply).toHaveBeenCalledWith('Alias set: "work".');
  });

  it("treats '-' as null (clear alias)", async () => {
    const setAlias = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias,
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("-");
    await handleName(transport, ctx);
    expect(setAlias).toHaveBeenCalledWith("1", "c1", null);
    expect(ctx.reply).toHaveBeenCalledWith("Alias cleared.");
  });

  it("rejects when no active conversation", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(null),
    });
    const ctx = mkCtx("work");
    await handleName(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No active conversation"));
  });

  it("maps alias_taken to friendly error", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(activeSession),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(err({ code: "alias_taken" })),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("taken");
    await handleName(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("already used"));
  });
});

describe("handleEnd", () => {
  it("closes the active session", async () => {
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s1",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c1",
        status: "active",
        receive: "routed",
      }),
      closeSession,
    });
    const ctx = mkCtx();
    await handleEnd(transport, ctx);
    expect(closeSession).toHaveBeenCalledWith("s1");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("ended"));
  });

  it("handles no active session gracefully", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(null),
    });
    const ctx = mkCtx();
    await handleEnd(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("No active conversation.");
  });
});

describe("handleProfile", () => {
  it("lists profiles when no subcommand", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "p1",
              userId: null,
              name: "assistant",
              basePrompt: "",
              model: "m",
              summarizationModel: null,
              extractionModel: null,
              autoRecall: "heuristic",
              toolSet: [],
            },
          ]),
        ),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("assistant"));
  });

  it("switches profile by name", async () => {
    const setProfile = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "p1",
              userId: "u",
              name: "coder",
              basePrompt: "",
              model: "m",
              summarizationModel: null,
              extractionModel: null,
              autoRecall: "heuristic",
              toolSet: [],
            },
          ]),
        ),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p-old", profileName: "x", model: "m" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile,
      },
    });
    const ctx = mkCtx("switch coder");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setProfile).toHaveBeenCalledWith("1", "c1", "p1");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("switched"));
  });

  it("complains when switching to unknown profile", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("switch ghost");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No profile named "ghost"'));
  });

  it("deletes profile by name", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "p1",
              userId: "u",
              name: "temp",
              basePrompt: "",
              model: "m",
              summarizationModel: null,
              extractionModel: null,
              autoRecall: "heuristic",
              toolSet: [],
            },
          ]),
        ),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: del,
      },
    });
    const ctx = mkCtx("delete temp");
    await handleProfile(transport, ctx, mkDialogs());
    expect(del).toHaveBeenCalledWith("1", "p1");
    expect(ctx.reply).toHaveBeenCalledWith('Profile "temp" deleted.');
  });

  it("delegates /profile new to dialogs.startNew", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = mkDialogs();
    const startNew = vi.spyOn(dialogs, "startNew");
    const ctx = mkCtx("new mine");
    await handleProfile(transport, ctx, dialogs);
    expect(startNew).toHaveBeenCalledWith(transport, ctx, "mine");
  });

  it("delegates /profile edit to dialogs.startEdit", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(ok({} as never)),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const dialogs = mkDialogs();
    const startEdit = vi.spyOn(dialogs, "startEdit");
    const ctx = mkCtx("edit coder");
    await handleProfile(transport, ctx, dialogs);
    expect(startEdit).toHaveBeenCalledWith(transport, ctx, "coder");
  });
});

describe("handleModel", () => {
  it("lists models when called without arg", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(
          ok({
            conversationId: "c1",
            profileId: "p1",
            profileName: "assistant",
            model: "gpt-4o",
          }),
        ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      models: { list: vi.fn().mockResolvedValue(["gpt-4o", "claude-sonnet-4-20250514"]) },
    });
    const ctx = mkCtx();
    await handleModel(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("← current"));
  });

  it("updates active profile's model when arg supplied", async () => {
    const update = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p1", profileName: "assistant", model: "old" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update,
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("gpt-4o");
    await handleModel(transport, ctx);
    expect(update).toHaveBeenCalledWith("1", "p1", { model: "gpt-4o" });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("set to gpt-4o"));
  });

  it("maps model_unavailable to friendly message", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi
          .fn()
          .mockResolvedValue(
            ok({ conversationId: "c1", profileId: "p1", profileName: "a", model: "old" }),
          ),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
      },
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update: vi.fn().mockResolvedValue(err({ code: "model_unavailable", model: "bad" })),
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("bad");
    await handleModel(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('"bad" isn\'t available'));
  });
});

describe("handleResumeCallback", () => {
  it("uses alias form for non-UUID target", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleResumeCallback(transport, ctx, "work");
    expect(transport.resumeConversation).toHaveBeenCalledWith("42", "1", { alias: "work" });
  });

  it("uses conversationId form for UUID target", async () => {
    const transport = transportWith();
    const uuid = "019d9691-c7c1-7709-bb01-55f5371babe1";
    const ctx = mkCtx();
    await handleResumeCallback(transport, ctx, uuid);
    expect(transport.resumeConversation).toHaveBeenCalledWith("42", "1", { conversationId: uuid });
  });
});

describe("handlePlanCallback", () => {
  const taskId = "019d0000-0000-7000-8000-000000000001";

  it("Approve dispatches to coding.approvePlan and returns approval text + toast", async () => {
    const approve = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "approve" }, "user-tg-1");

    expect(approve).toHaveBeenCalledWith(taskId, "user-tg-1");
    expect(outcome.editText).toMatch(/Plan approved/);
    expect(outcome.toast).toBe("Approved");
    expect(outcome.followUp).toBeUndefined();
  });

  it("Cancel dispatches to coding.cancelTask with a reason and clears the keyboard", async () => {
    const cancel = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "cancel" }, "user-tg-1");

    expect(cancel).toHaveBeenCalledWith(taskId, "user-tg-1", "user cancelled the plan");
    expect(outcome.editText).toMatch(/Plan cancelled/);
    expect(outcome.toast).toBe("Cancelled");
  });

  it("Revise cancels the task AND posts a follow-up prompt for the user's revisions", async () => {
    const cancel = vi.fn().mockResolvedValue(ok({ taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "revise" }, "user-tg-1");

    expect(cancel).toHaveBeenCalledWith(taskId, "user-tg-1", "user requested revisions");
    expect(outcome.editText).toMatch(/Plan revised/);
    expect(outcome.followUp).toMatch(/what you'd like changed/);
    expect(outcome.toast).toBe("Revising");
  });

  it("identity_rejected from Transport surfaces an unauthorized message — no state change attempted twice", async () => {
    const approve = vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(
      transport,
      { taskId, action: "approve" },
      "wrong-user",
    );

    expect(approve).toHaveBeenCalledTimes(1);
    expect(outcome.editText).toMatch(/not authorized/);
    expect(outcome.toast).toMatch(/not authorized/);
  });

  it("double-tap Approve gets task_already_approved (idempotent at the Transport boundary)", async () => {
    const approve = vi
      .fn()
      .mockResolvedValue(err({ code: "task_already_approved" as const, taskId }));
    const transport = transportWith({
      coding: {
        approvePlan: approve,
        cancelTask: vi.fn(),
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "approve" }, "user-tg-1");

    expect(outcome.editText).toMatch(/already approved/);
    // Toast and editText match — both come from errorMessage(error.code).
    expect(outcome.toast).toBe(outcome.editText);
  });

  it("Cancel after task is already terminal surfaces task_already_terminal", async () => {
    const cancel = vi
      .fn()
      .mockResolvedValue(err({ code: "task_already_terminal" as const, taskId, status: "failed" }));
    const transport = transportWith({
      coding: {
        approvePlan: vi.fn(),
        cancelTask: cancel,
      },
    });

    const outcome = await handlePlanCallback(transport, { taskId, action: "cancel" }, "user-tg-1");

    expect(outcome.editText).toMatch(/already finished/);
    expect(outcome.editText).toMatch(/failed/);
  });
});
