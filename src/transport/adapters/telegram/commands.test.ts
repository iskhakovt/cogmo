import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../agent/store/index.js";
import { assertKind } from "../../../test/assertions.js";
import { type DeepPartial, mockTransportDeep } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import {
  formatRelativeTime,
  formatScope,
  handleClasses,
  handleCompartments,
  handleDisable,
  handleEnable,
  handleEnd,
  handleLearned,
  handleMcp,
  handleModel,
  handleName,
  handleNew,
  handlePlanCallback,
  handleProfile,
  handleReflect,
  handleRepair,
  handleResume,
  handleResumeCallback,
  handleSchedules,
  handleSessions,
  handleSkills,
  handleSkillsApprovalCallback,
  handleStatus,
  handleVoice,
  parseScopeSpec,
  parseStreamSpec,
  splitScopeArgs,
  splitStreamArgs,
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

function transportWith(overrides: DeepPartial<Transport> = {}): Transport {
  return mockTransportDeep(overrides);
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

  it("resolves an open boundary hold to the requested alias instead of swapping sessions", async () => {
    // Alias lookup happens before the resolve so identity + ownership are
    // checked the same way as the post-hold `resumeConversation` path.
    const resumeConversation = vi.fn();
    const resolve = vi.fn().mockResolvedValue(
      ok({
        sessionId: "s-target",
        conversationId: "c-target",
        drainedInboundCount: 1,
        platformAddress: "42",
      }),
    );
    const transport = transportWith({
      resumeConversation,
      boundary: {
        findActive: vi.fn().mockResolvedValue({
          id: "boundary-1",
          channelId: "ch",
          platformAddress: "42",
          platformUserHandle: "1",
          priorConversationId: "c-prior",
          promptMessageId: "9001",
          bufferedInbounds: [{ content: "hey", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt: new Date(),
          createdAt: new Date(),
        }),
        resolve,
      },
      conversations: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "c-target",
              profileName: "assistant",
              alias: "work",
              lastMessagePreview: "",
              lastMessageAt: new Date(),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx("work");
    await handleResume(transport, ctx);
    expect(resolve).toHaveBeenCalledWith({
      boundaryId: "boundary-1",
      choice: { kind: "resume-target", conversationId: "c-target" },
      reason: "user_resume_target",
    });
    expect(resumeConversation).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith('Resumed conversation "work".');
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

describe("handleNew", () => {
  function profile(id: string, name: string, userId: string | null = "u"): Profile {
    return {
      id,
      userId,
      name,
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    };
  }

  function mockCreateConversation(profileName: string) {
    return vi.fn().mockResolvedValue(
      ok({
        id: "s1",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c1",
        status: "active",
        receive: "routed",
        profileName,
      }),
    );
  }

  it("creates a conversation with no profileId when none is passed", async () => {
    // No profile arg → handleNew must not pass `profileId`, letting the
    // Transport apply its fallback chain (per-chat default > global default).
    const createConversation = mockCreateConversation("assistant");
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(null),
      createConversation,
    });
    const ctx = mkCtx();
    await handleNew(transport, ctx);
    expect(createConversation).toHaveBeenCalledWith("42", "1", { isPrivate: true });
  });

  it("passes the resolved profileId through when the user names a profile", async () => {
    const createConversation = mockCreateConversation("coder");
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([profile("p1", "coder")])) },
      resolveSession: vi.fn().mockResolvedValue(null),
      createConversation,
    });
    const ctx = mkCtx("coder");
    await handleNew(transport, ctx);
    expect(createConversation).toHaveBeenCalledWith("42", "1", {
      isPrivate: true,
      profileId: "p1",
    });
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('with profile "coder"'));
  });

  it("surfaces the profile name returned by createConversation (race-free)", async () => {
    // The fallback (chat default or global default) is opaque to handleNew;
    // it relies on createConversation's return to name the profile it
    // actually used. This is atomic with the insert — getCurrent would be
    // racy against a concurrent /new swapping the active session.
    const createConversation = mockCreateConversation("doc-mode");
    // Spy on getCurrent to confirm we DO NOT call it on this path — the
    // race fix's whole point is removing that follow-up lookup.
    const getCurrent = vi.fn();
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(null),
      createConversation,
      conversations: { getCurrent },
    });
    const ctx = mkCtx();
    await handleNew(transport, ctx);
    expect(getCurrent).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('with profile "doc-mode"'));
  });

  it("closes the existing session before creating a new conversation", async () => {
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s-old",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c-old",
        status: "active",
        receive: "routed",
      }),
      closeSession,
    });
    const ctx = mkCtx();
    await handleNew(transport, ctx);
    expect(closeSession).toHaveBeenCalledWith("s-old");
  });

  it("rejects an unknown profile name without creating a conversation", async () => {
    const createConversation = vi.fn();
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([])) },
      createConversation,
    });
    const ctx = mkCtx("ghost");
    await handleNew(transport, ctx);
    expect(createConversation).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No profile named "ghost"'));
  });

  it("resolves an open boundary hold as fresh instead of creating a new conversation", async () => {
    // When a hold is open, `/new` should drain its buffer into the fresh
    // conversation via `boundary.resolve` — not call `createConversation`
    // directly (which would orphan the buffer).
    const createConversation = vi.fn();
    const closeSession = vi.fn();
    const resolve = vi.fn().mockResolvedValue(
      ok({
        sessionId: "s-fresh",
        conversationId: "c-fresh",
        drainedInboundCount: 1,
        platformAddress: "42",
      }),
    );
    const transport = transportWith({
      createConversation,
      closeSession,
      boundary: {
        findActive: vi.fn().mockResolvedValue({
          id: "boundary-1",
          channelId: "ch",
          platformAddress: "42",
          platformUserHandle: "1",
          priorConversationId: "c-prior",
          promptMessageId: "9001",
          bufferedInbounds: [{ content: "hi", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt: new Date(),
          createdAt: new Date(),
        }),
        resolve,
      },
      conversations: {
        getCurrent: vi.fn().mockResolvedValue(
          ok({
            conversationId: "c-fresh",
            profileId: "p1",
            profileName: "assistant",
            model: "m",
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleNew(transport, ctx);
    expect(resolve).toHaveBeenCalledWith({
      boundaryId: "boundary-1",
      choice: { kind: "fresh" },
      reason: "user_command",
    });
    expect(createConversation).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
    // Pin the full reply shape — the trailing "(assistant)." comes from
    // `transport.conversations.getCurrent` returning profileName, not from
    // the user's command arg. Regressions in either path would fall through
    // to the "(default)" fallback and this assertion would catch it.
    expect(ctx.reply).toHaveBeenCalledWith("Started a new conversation (assistant).");
  });

  it("forwards the explicit profile to boundary.resolve when /new <name> runs during a hold", async () => {
    const resolve = vi.fn().mockResolvedValue(
      ok({
        sessionId: "s-fresh",
        conversationId: "c-fresh",
        drainedInboundCount: 1,
        platformAddress: "42",
      }),
    );
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([profile("p9", "coder")])) },
      boundary: {
        findActive: vi.fn().mockResolvedValue({
          id: "boundary-1",
          channelId: "ch",
          platformAddress: "42",
          platformUserHandle: "1",
          priorConversationId: "c-prior",
          promptMessageId: "9001",
          bufferedInbounds: [{ content: "hi", platformTs: "2026-05-19T12:00:00.000Z" }],
          expiresAt: new Date(),
          createdAt: new Date(),
        }),
        resolve,
      },
    });
    const ctx = mkCtx("coder");
    await handleNew(transport, ctx);
    expect(resolve).toHaveBeenCalledWith({
      boundaryId: "boundary-1",
      choice: { kind: "fresh", profileId: "p9" },
      reason: "user_command",
    });
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

  it("/profile list loads compartments + profileClasses registries and annotates restricted profile classes", async () => {
    const compartmentsList = vi.fn().mockResolvedValue(ok([]));
    const profileClassesList = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "x",
          restricted: true,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
        {
          id: "c-2",
          userId: "u-1",
          name: "general",
          description: "y",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const profileBase: Omit<Profile, "id" | "name" | "profileClass"> = {
      userId: "u-1",
      basePrompt: "",
      model: "m",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    };
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            { id: "p1", name: "assistant", profileClass: "general", ...profileBase },
            { id: "p2", name: "private", profileClass: "intimate", ...profileBase },
          ]),
        ),
      },
      compartments: { list: compartmentsList },
      profileClasses: { list: profileClassesList },
    });
    const ctx = mkCtx("");
    await handleProfile(transport, ctx, mkDialogs());
    expect(compartmentsList).toHaveBeenCalled();
    expect(profileClassesList).toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]?.[0];
    // Restricted class gets the trailing `!` marker (matching the
    // `! = restricted` convention `formatScope` already uses); unrestricted
    // stays bare. `*` is reserved for custom compartments on the same line.
    expect(reply).toContain("[class=intimate!]");
    expect(reply).toContain("[class=general]");
    expect(reply).not.toContain("[class=general!]");
  });

  it("/profile list degrades gracefully when the profileClasses registry list errors", async () => {
    // Best-effort: a registry-list error must not abort the whole reply
    // — the profile list itself is what the user asked for, the
    // restricted markers are decoration. The handler renders without
    // markers rather than surfacing the registry error.
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "p1",
              userId: "u-1",
              name: "private",
              basePrompt: "",
              model: "m",
              summarizationModel: null,
              extractionModel: null,
              autoRecall: "heuristic",
              voiceMode: "auto",
              toolSet: [],
              memoryScope: null,
              profileClass: "intimate",
            },
          ]),
        ),
      },
      profileClasses: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
      },
    });
    const ctx = mkCtx("");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = ctx.reply.mock.calls[0]?.[0];
    // Class still rendered (the profile data has it), just without the
    // restricted marker since we couldn't load the registry.
    expect(reply).toContain("[class=intimate]");
    expect(reply).not.toContain("[class=intimate!]");
    // Crucially, no error message — the user gets their list back.
    expect(reply).not.toContain("not authorized");
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

  describe("default subcommand", () => {
    function profile(id: string, name: string, userId: string | null = "u"): Profile {
      return {
        id,
        userId,
        name,
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: null,
        profileClass: null,
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
      };
    }

    it("with no arg, shows the unset state when no default is pinned", async () => {
      const transport = transportWith({
        chats: { getDefaultProfile: vi.fn().mockResolvedValue(ok(null)) },
      });
      const ctx = mkCtx("default");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No default profile pinned"));
    });

    it("with no arg, shows the pinned profile name when one is set", async () => {
      const transport = transportWith({
        chats: {
          getDefaultProfile: vi
            .fn()
            .mockResolvedValue(ok({ profileId: "p1", profileName: "doc-mode" })),
        },
      });
      const ctx = mkCtx("default");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('"doc-mode"'));
    });

    it("with `clear`, calls chats.clearDefaultProfile", async () => {
      const clearDefaultProfile = vi.fn().mockResolvedValue(ok(undefined));
      const transport = transportWith({
        chats: { clearDefaultProfile },
      });
      const ctx = mkCtx("default clear");
      await handleProfile(transport, ctx, mkDialogs());
      expect(clearDefaultProfile).toHaveBeenCalledWith("1", "42");
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("cleared"));
    });

    it("with a profile name, resolves it and pins via chats.setDefaultProfile", async () => {
      const setDefaultProfile = vi.fn().mockResolvedValue(ok(undefined));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([profile("p1", "coder")])),
        },
        chats: { setDefaultProfile },
      });
      const ctx = mkCtx("default coder");
      await handleProfile(transport, ctx, mkDialogs());
      expect(setDefaultProfile).toHaveBeenCalledWith("1", "42", "p1");
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("pinned"));
    });

    it("with an unknown profile name, reports it and does not call setDefaultProfile", async () => {
      const setDefaultProfile = vi.fn();
      const transport = transportWith({
        profiles: { list: vi.fn().mockResolvedValue(ok([])) },
        chats: { setDefaultProfile },
      });
      const ctx = mkCtx("default ghost");
      await handleProfile(transport, ctx, mkDialogs());
      expect(setDefaultProfile).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No profile named "ghost"'));
    });

    it("surfaces an ambiguity message when two visible profiles share the name", async () => {
      // Both have a user owner — disambiguation in resolveProfileByName only
      // auto-resolves when exactly one is user-owned and the rest are org.
      const transport = transportWith({
        profiles: {
          list: vi
            .fn()
            .mockResolvedValue(ok([profile("p1", "shared", "u1"), profile("p2", "shared", "u2")])),
        },
      });
      const ctx = mkCtx("default shared");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("ambiguous"));
    });

    it("surfaces transport errors from setDefaultProfile", async () => {
      const setDefaultProfile = vi.fn().mockResolvedValue(err({ code: "profile_not_found" }));
      const transport = transportWith({
        profiles: { list: vi.fn().mockResolvedValue(ok([profile("p1", "coder")])) },
        chats: { setDefaultProfile },
      });
      const ctx = mkCtx("default coder");
      await handleProfile(transport, ctx, mkDialogs());
      // errorMessage() maps profile_not_found to a human-readable line; the
      // exact wording is owned elsewhere — just assert we didn't silently
      // claim success.
      const reply = ctx.reply.mock.calls.at(-1)?.[0];
      expect(reply).not.toContain("pinned");
    });
  });

  describe("scope subcommand", () => {
    function makeProfile(
      memoryScope: Profile["memoryScope"] = null,
      profileClass: Profile["profileClass"] = null,
    ): Profile {
      return {
        id: "p1",
        userId: "u",
        name: "personal",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope,
        profileClass,
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
      };
    }

    it("shows current scope when called with no spec — null renders as 'unrestricted'", async () => {
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("unrestricted"));
    });

    it("shows current scope when set", async () => {
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["work", "technical"],
                trust: ["first-party"],
              }),
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("compartments: work, technical / trust: first-party"),
      );
    });

    it("show: marks custom compartments with `*` and appends the legend", async () => {
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["work", "dnd"],
                trust: ["first-party"],
              }),
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: {
          list: vi.fn().mockResolvedValue(
            ok([
              {
                id: "cc-1",
                userId: "u-1",
                name: "dnd",
                description: "tabletop campaign notes",
                createdAt: new Date("2026-05-09T12:00:00Z"),
              },
            ]),
          ),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      const reply = ctx.reply.mock.calls[0]?.[0];
      expect(reply).toContain("compartments: work, dnd*");
      expect(reply).toContain("(* = custom)");
    });

    it("set: confirmation echoes the legend when the new scope contains a custom compartment", async () => {
      const set: Profile["memoryScope"] = {
        compartments: ["dnd"],
        trust: ["first-party"],
      };
      const update = vi.fn().mockResolvedValue(ok(makeProfile(set)));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: {
          list: vi.fn().mockResolvedValue(
            ok([
              {
                id: "cc-1",
                userId: "u-1",
                name: "dnd",
                description: "x",
                createdAt: new Date("2026-05-09T12:00:00Z"),
              },
            ]),
          ),
        },
      });
      const ctx = mkCtx("scope personal compartments=dnd trust=first-party");
      await handleProfile(transport, ctx, mkDialogs());
      const confirmation = ctx.reply.mock.calls[0]?.[0];
      expect(confirmation).toContain("dnd*");
      expect(confirmation).toContain("(* = custom)");
    });

    it("show: skips the customs-list fetch when the current scope is null (unrestricted)", async () => {
      const compartmentsList = vi.fn().mockResolvedValue(ok([]));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: { list: compartmentsList },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      // Optimisation: a null scope has no compartments to mark, so
      // skip the customs fetch entirely.
      expect(compartmentsList).not.toHaveBeenCalled();
    });

    it("show: skips the customs-list fetch when every compartment is core, renders without `*`", async () => {
      const compartmentsList = vi.fn().mockResolvedValue(ok([]));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["work", "technical"],
                trust: ["first-party"],
              }),
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: { list: compartmentsList },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      expect(compartmentsList).not.toHaveBeenCalled();
      // Belt-and-braces: a regression that drops the `*` on a custom
      // compartment can't sneak through here either — all-core scopes
      // never get marked, so the rendered string contains no `*`.
      const reply = ctx.reply.mock.calls[0]?.[0];
      expect(reply).not.toContain("*");
    });

    it("set: skips the customs-list fetch when the new scope is all-core", async () => {
      const compartmentsList = vi.fn().mockResolvedValue(ok([]));
      const update = vi.fn().mockResolvedValue(
        ok(
          makeProfile({
            compartments: ["work"],
            trust: ["first-party"],
          }),
        ),
      );
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: { list: compartmentsList },
      });
      const ctx = mkCtx("scope personal compartments=work trust=first-party");
      await handleProfile(transport, ctx, mkDialogs());
      expect(compartmentsList).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalled();
    });

    it("clear: skips the customs-list fetch (target is null)", async () => {
      const compartmentsList = vi.fn().mockResolvedValue(ok([]));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["work", "dnd"],
                trust: ["first-party"],
              }),
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok(makeProfile(null))),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: { list: compartmentsList },
      });
      const ctx = mkCtx("scope personal clear");
      await handleProfile(transport, ctx, mkDialogs());
      // Even though the profile has a custom in its current scope, we're
      // clearing it — the rendered confirmation is the new scope (null),
      // which has nothing to mark.
      expect(compartmentsList).not.toHaveBeenCalled();
    });

    it("show: surfaces a customs-list error when fetching is necessary", async () => {
      // Defensive path: the customs fetch is identity-checked and could
      // theoretically return identity_rejected mid-flow (between the
      // profile resolve and the list call). The handler should bail
      // with the typed error rather than silently dropping the legend.
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["dnd"],
                trust: ["first-party"],
              }),
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update: vi.fn().mockResolvedValue(ok({} as never)),
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
        compartments: {
          list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
    });

    it("show: skips the profileClasses-list fetch when the scope sets no classes", async () => {
      const profileClassesList = vi.fn().mockResolvedValue(ok([]));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["work"],
                trust: ["first-party"],
              }),
            ]),
          ),
        },
        profileClasses: { list: profileClassesList },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      // No `classes:` segment in the rendered scope → no point loading the
      // restricted-class registry; the `! = restricted` legend can't fire.
      expect(profileClassesList).not.toHaveBeenCalled();
    });

    it("show: fetches profileClasses when scope.profileClasses is set and marks restricted classes with `!`", async () => {
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["personal"],
                trust: ["first-party"],
                profileClasses: ["intimate", "general"],
              }),
            ]),
          ),
        },
        profileClasses: {
          list: vi.fn().mockResolvedValue(
            ok([
              {
                id: "c-1",
                userId: "u-1",
                name: "intimate",
                description: "x",
                restricted: true,
                createdAt: new Date("2026-04-16T12:00:00Z"),
              },
              {
                id: "c-2",
                userId: "u-1",
                name: "general",
                description: "y",
                restricted: false,
                createdAt: new Date("2026-04-16T12:00:00Z"),
              },
            ]),
          ),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      const reply = ctx.reply.mock.calls[0]?.[0];
      expect(reply).toContain("classes: intimate!, general");
      expect(reply).toContain("(! = restricted)");
    });

    it("set: confirmation echoes restricted markers when the new scope contains a restricted class", async () => {
      const set: Profile["memoryScope"] = {
        compartments: ["personal"],
        trust: ["first-party"],
        profileClasses: ["intimate"],
      };
      const update = vi.fn().mockResolvedValue(ok(makeProfile(set)));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          update,
        },
        profileClasses: {
          list: vi.fn().mockResolvedValue(
            ok([
              {
                id: "c-1",
                userId: "u-1",
                name: "intimate",
                description: "x",
                restricted: true,
                createdAt: new Date("2026-04-16T12:00:00Z"),
              },
            ]),
          ),
        },
      });
      const ctx = mkCtx("scope personal compartments=personal trust=first-party classes=intimate");
      await handleProfile(transport, ctx, mkDialogs());
      const confirmation = ctx.reply.mock.calls[0]?.[0];
      expect(confirmation).toContain("intimate!");
      expect(confirmation).toContain("(! = restricted)");
    });

    it("show: surfaces a profileClasses-list error when fetching is necessary", async () => {
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              makeProfile({
                compartments: ["personal"],
                trust: ["first-party"],
                profileClasses: ["intimate"],
              }),
            ]),
          ),
        },
        profileClasses: {
          list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        },
      });
      const ctx = mkCtx("scope personal");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
    });

    it("clear → calls update with memoryScope: null and confirms", async () => {
      const update = vi.fn().mockResolvedValue(ok(makeProfile(null)));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal clear");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).toHaveBeenCalledWith("1", "p1", { memoryScope: null });
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("unrestricted"));
    });

    it("set → calls update with parsed scope", async () => {
      const set: Profile["memoryScope"] = {
        compartments: ["work", "technical"],
        trust: ["first-party"],
      };
      const update = vi.fn().mockResolvedValue(ok(makeProfile(set)));
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal compartments=work,technical trust=first-party");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).toHaveBeenCalledWith("1", "p1", {
        memoryScope: { compartments: ["work", "technical"], trust: ["first-party"] },
      });
      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining("compartments: work, technical / trust: first-party"),
      );
    });

    it("surfaces ambiguity (org + user share a name) without calling update", async () => {
      // resolveProfileByName returns kind:"ambiguous" when an org profile
      // and a user profile share a name AND multiple user-owned matches
      // exist (the single-owned-match path picks the user one). Synthesise
      // that by listing two user-owned profiles with the same name.
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(
            ok([
              { ...makeProfile(null), id: "p1", userId: "u-a", name: "shared" },
              { ...makeProfile(null), id: "p2", userId: "u-b", name: "shared" },
            ]),
          ),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope shared compartments=work trust=any");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("ambiguous"));
    });

    it("rejects unknown profile — does not call update", async () => {
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope ghost compartments=work trust=any");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No profile named "ghost"'));
    });

    it("typo'd key (e.g. compartment=…) surfaces 'Unknown key' from parser, not 'No profile named'", async () => {
      // Regression: a narrow scope-shape regex would absorb the typo into
      // the name and emit "No profile named 'personal compartment=work'".
      // The broadened shape check routes it to parseScopeSpec instead.
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal compartment=work trust=first-party");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown key "compartment"'));
    });

    it("surfaces parse errors without calling update", async () => {
      // `trust` still has a strict enum (first-party | any). Compartments
      // moved to runtime validation against the user's `custom_compartments`,
      // so an unknown compartment value passes parse and surfaces as a
      // typed Transport error instead — see `compartment_unknown` below.
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal compartments=work trust=bogus");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Invalid scope"));
    });

    it("addresses a profile whose name contains spaces", async () => {
      const update = vi.fn().mockResolvedValue(
        ok({
          ...makeProfile({ compartments: ["work" as const], trust: ["first-party" as const] }),
          name: "my work profile",
        }),
      );
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([{ ...makeProfile(null), name: "my work profile" }])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope my work profile compartments=work trust=first-party");
      await handleProfile(transport, ctx, mkDialogs());
      expect(update).toHaveBeenCalledWith("1", "p1", {
        memoryScope: { compartments: ["work"], trust: ["first-party"] },
      });
    });

    it("`/profile scope` with no name → USAGE (no list / update calls)", async () => {
      const list = vi.fn();
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list,
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope");
      await handleProfile(transport, ctx, mkDialogs());
      expect(list).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /profile"));
    });

    it("surfaces transport access_denied (org profile) without leaking it as success", async () => {
      const update = vi.fn().mockResolvedValue(
        err({
          code: "access_denied" as const,
          reason: "org profiles are read-only via Transport",
        }),
      );
      const orgProfile: Profile = { ...makeProfile(null), userId: null };
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([orgProfile])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal clear");
      await handleProfile(transport, ctx, mkDialogs());
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Access denied"));
    });
  });
});

describe("parseScopeSpec", () => {
  it("empty tokens → show", () => {
    expect(parseScopeSpec([])).toEqual({ kind: "show" });
  });

  it("['clear'] (any case) → clear", () => {
    expect(parseScopeSpec(["clear"])).toEqual({ kind: "clear" });
    expect(parseScopeSpec(["CLEAR"])).toEqual({ kind: "clear" });
  });

  it("set with both keys, regardless of order", () => {
    const a = parseScopeSpec(["compartments=work,technical", "trust=first-party"]);
    const b = parseScopeSpec(["trust=first-party", "compartments=work,technical"]);
    expect(a).toEqual({
      kind: "set",
      scope: { compartments: ["work", "technical"], trust: ["first-party"] },
    });
    expect(b).toEqual(a);
  });

  it("rejects missing key (compartments only)", () => {
    const r = parseScopeSpec(["compartments=work"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Both compartments=… and trust=…");
  });

  it("rejects unknown key", () => {
    const r = parseScopeSpec(["compartments=work", "trust=any", "extra=foo"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Unknown key "extra"');
  });

  it("rejects token without '='", () => {
    const r = parseScopeSpec(["bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Bad token "bogus"');
  });

  it("rejects empty value list (trust=)", () => {
    // After splitting and filtering empties, trust ends up as []. Zod's .min(1)
    // catches it — message mentions the validation issue.
    const r = parseScopeSpec(["compartments=work", "trust="]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects unknown trust value (trust enum is still strict)", () => {
    const r = parseScopeSpec(["compartments=work", "trust=bogus"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("accepts an unknown compartment value at parse time (validation moved to Transport)", () => {
    // Compartments are now runtime-validated against the user's
    // `custom_compartments` registry, which the parser can't see. An
    // unknown value passes here and is rejected later by Transport with
    // a `compartment_unknown` error — keeping the parser pure of DB I/O
    // while still catching typos before they're persisted.
    const r = parseScopeSpec(["compartments=dnd-campaign", "trust=first-party"]);
    expect(r.kind).toBe("set");
    if (r.kind === "set") {
      expect(r.scope.compartments).toEqual(["dnd-campaign"]);
    }
  });

  it("accepts whitespace inside the comma-separated list (split-and-trim)", () => {
    // Telegram tokenises on whitespace before parseScopeSpec sees the input,
    // so a stray space *between* tokens splits them into separate tokens.
    // But a space *after a comma* inside a single token (e.g. when the
    // operator types "work, technical" and the shell preserves it) must be
    // tolerated — that's why we trim each value.
    const r = parseScopeSpec(["compartments=work,technical", "trust=first-party,any"]);
    expect(r).toEqual({
      kind: "set",
      scope: { compartments: ["work", "technical"], trust: ["first-party", "any"] },
    });
  });

  it("rejects case-mismatched trust values (typo guard at parser)", () => {
    // Compartments dropped this guard when the schema went runtime-dynamic
    // (the parser can't know "WORK" isn't a custom compartment); trust
    // keeps its strict enum so the case-mismatch check still fires here.
    const r = parseScopeSpec(["compartments=work", "trust=FIRST-PARTY"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects same key repeated — points operator at a single comma list", () => {
    const r = parseScopeSpec(["compartments=work", "compartments=technical", "trust=any"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toContain('Key "compartments" repeated');
      expect(r.message).toContain("comma-separated");
    }
  });

  it("accepts classes=… as a third optional dimension", () => {
    const r = parseScopeSpec(["compartments=personal", "trust=first-party", "classes=intimate"]);
    expect(r).toEqual({
      kind: "set",
      scope: {
        compartments: ["personal"],
        trust: ["first-party"],
        profileClasses: ["intimate"],
      },
    });
  });

  it("accepts multiple comma-separated values in classes=…", () => {
    const r = parseScopeSpec([
      "compartments=personal",
      "trust=first-party",
      "classes=intimate,general",
    ]);
    if (r.kind !== "set") throw new Error(`expected set, got ${r.kind}`);
    expect(r.scope.profileClasses).toEqual(["intimate", "general"]);
  });

  it("rejects empty classes=… (Zod min(1) on the array)", () => {
    const r = parseScopeSpec(["compartments=personal", "trust=first-party", "classes="]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
  });

  it("rejects classes= repeated", () => {
    const r = parseScopeSpec([
      "compartments=personal",
      "trust=first-party",
      "classes=intimate",
      "classes=general",
    ]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain('Key "classes" repeated');
  });
});

describe("splitScopeArgs", () => {
  it("single-word name with no spec → name only", () => {
    expect(splitScopeArgs(["personal"])).toEqual({ name: "personal", scopeTokens: [] });
  });

  it("multi-word name with no spec → joined name, empty spec (show case)", () => {
    expect(splitScopeArgs(["my", "work", "profile"])).toEqual({
      name: "my work profile",
      scopeTokens: [],
    });
  });

  it("multi-word name + clear → joined name, ['clear']", () => {
    expect(splitScopeArgs(["my", "work", "clear"])).toEqual({
      name: "my work",
      scopeTokens: ["clear"],
    });
  });

  it("multi-word name + key=value tokens → joined name, full spec preserved", () => {
    expect(
      splitScopeArgs(["my", "profile", "compartments=work,technical", "trust=first-party"]),
    ).toEqual({
      name: "my profile",
      scopeTokens: ["compartments=work,technical", "trust=first-party"],
    });
  });

  it("case-insensitive scope-shape detection (CLEAR, Compartments=…)", () => {
    expect(splitScopeArgs(["my", "profile", "CLEAR"])).toEqual({
      name: "my profile",
      scopeTokens: ["CLEAR"],
    });
    expect(splitScopeArgs(["my", "profile", "Compartments=work", "Trust=any"])).toEqual({
      name: "my profile",
      scopeTokens: ["Compartments=work", "Trust=any"],
    });
  });

  it("treats any key=value-shape token as scope, not name (catches typos)", () => {
    // `compartment=` (singular) is a typo — it must route to the parser so
    // the operator sees "Unknown key 'compartment'" rather than having
    // the typo silently absorbed into the profile name.
    expect(splitScopeArgs(["work", "compartment=work", "trust=any"])).toEqual({
      name: "work",
      scopeTokens: ["compartment=work", "trust=any"],
    });
    // Same principle for any random key=value token.
    expect(splitScopeArgs(["work", "foo=bar"])).toEqual({
      name: "work",
      scopeTokens: ["foo=bar"],
    });
  });

  it("empty rest → empty name, empty spec", () => {
    expect(splitScopeArgs([])).toEqual({ name: "", scopeTokens: [] });
  });
});

describe("splitStreamArgs", () => {
  it("multi-word name + key=value tokens → joined name, full spec preserved", () => {
    expect(splitStreamArgs(["my", "profile", "chunk=500", "edits=off"])).toEqual({
      name: "my profile",
      streamTokens: ["chunk=500", "edits=off"],
    });
  });

  it("stream has no bare-keyword form — a profile named 'clear' is addressable", () => {
    expect(splitStreamArgs(["clear"])).toEqual({ name: "clear", streamTokens: [] });
    expect(splitStreamArgs(["clear", "chunk=500"])).toEqual({
      name: "clear",
      streamTokens: ["chunk=500"],
    });
  });

  it("empty rest → empty name, empty tokens", () => {
    expect(splitStreamArgs([])).toEqual({ name: "", streamTokens: [] });
  });
});

describe("parseStreamSpec", () => {
  it("empty → show", () => {
    expect(parseStreamSpec([])).toEqual({ kind: "show" });
  });

  it("chunk= sets only streamChunkChars", () => {
    expect(parseStreamSpec(["chunk=500"])).toEqual({
      kind: "set",
      changes: { streamChunkChars: 500 },
    });
  });

  it("edits=on/off/true/false maps to streamEdits boolean", () => {
    expect(parseStreamSpec(["edits=on"])).toEqual({
      kind: "set",
      changes: { streamEdits: true },
    });
    expect(parseStreamSpec(["edits=off"])).toEqual({
      kind: "set",
      changes: { streamEdits: false },
    });
    expect(parseStreamSpec(["edits=true"])).toEqual({
      kind: "set",
      changes: { streamEdits: true },
    });
    expect(parseStreamSpec(["edits=false"])).toEqual({
      kind: "set",
      changes: { streamEdits: false },
    });
  });

  it("both keys at once", () => {
    expect(parseStreamSpec(["chunk=500", "edits=off"])).toEqual({
      kind: "set",
      changes: { streamChunkChars: 500, streamEdits: false },
    });
  });

  it("rejects chunk outside [100, 4000] — defense in depth alongside DB CHECK", () => {
    // Pin the user-facing range copy — drifting silently from the DB
    // CHECK bounds would make the friendly error misleading.
    const low = parseStreamSpec(["chunk=50"]);
    assertKind(low, "error");
    expect(low.message).toContain("100 and 4000");
    const high = parseStreamSpec(["chunk=5000"]);
    assertKind(high, "error");
    expect(high.message).toContain("100 and 4000");
  });

  it("rejects non-integer chunk and surfaces the offending value", () => {
    const r = parseStreamSpec(["chunk=abc"]);
    assertKind(r, "error");
    expect(r.message).toContain("abc");
  });

  it("rejects unknown edits value", () => {
    const r = parseStreamSpec(["edits=maybe"]);
    assertKind(r, "error");
    expect(r.message).toContain("on|off");
  });

  it("rejects unknown key", () => {
    const r = parseStreamSpec(["foo=bar"]);
    assertKind(r, "error");
    expect(r.message).toContain("chunk");
    expect(r.message).toContain("edits");
  });

  it("rejects repeated keys", () => {
    expect(parseStreamSpec(["chunk=500", "chunk=1000"]).kind).toBe("error");
    expect(parseStreamSpec(["edits=on", "edits=off"]).kind).toBe("error");
  });

  it("rejects bare tokens (no '=')", () => {
    const r = parseStreamSpec(["foo"]);
    assertKind(r, "error");
    expect(r.message).toContain("chunk=<n>");
    expect(r.message).toContain("edits=on|off");
  });
});

describe("handleClasses", () => {
  it("rejects /classes add with reserved name 'clear' before calling Transport", async () => {
    const create = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add clear something descriptive");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"clear" is reserved');
  });

  it("rejects /classes add CLEAR (case-insensitive)", async () => {
    const create = vi.fn().mockResolvedValue(ok({} as never));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add CLEAR description");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
  });

  it("/classes add <name> <desc> with a normal name calls profileClasses.create", async () => {
    const create = vi.fn().mockResolvedValue(
      ok({
        id: "c-1",
        userId: "u-1",
        name: "intimate",
        description: "for emotional / relationship topics",
        createdAt: new Date("2026-04-16T12:00:00Z"),
      }),
    );
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate for emotional / relationship topics");
    await handleClasses(transport, ctx);
    expect(create).toHaveBeenCalledWith("1", {
      name: "intimate",
      description: "for emotional / relationship topics",
    });
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('Registered class "intimate"');
  });

  it("/classes add with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("add");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes add with name but missing description replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate");
    await handleClasses(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes add surfaces profile_class_name_taken from Transport", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_name_taken", name: "intimate" }));
    const transport = transportWith({ profileClasses: { create } });
    const ctx = mkCtx("add intimate desc");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"intimate" already exists');
  });

  it("bare /classes lists registered classes", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "for emotional / relationship topics",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
        {
          id: "c-2",
          userId: "u-1",
          name: "general",
          description: "default for assistant-style profiles",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(list).toHaveBeenCalledWith("1");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("intimate");
    expect(reply).toContain("for emotional / relationship topics");
    expect(reply).toContain("general");
    // No restricted classes → no `(restricted)` marker, no legend.
    expect(reply).not.toContain("(restricted)");
  });

  it("/classes list annotates restricted classes and appends a legend", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "for emotional / relationship topics",
          restricted: true,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
        {
          id: "c-2",
          userId: "u-1",
          name: "general",
          description: "default for assistant-style profiles",
          restricted: false,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0] as string;
    expect(reply).toMatch(/intimate \(restricted\)/);
    expect(reply).not.toMatch(/general \(restricted\)/);
    expect(reply).toContain("readers must opt in");
  });

  it("explicit /classes list uses the same path", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx("list");
    await handleClasses(transport, ctx);
    expect(list).toHaveBeenCalled();
  });

  it("bare /classes with empty registry replies with the bootstrap hint", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/classes add");
  });

  it("bare /classes surfaces identity_rejected via errorMessage", async () => {
    const list = vi.fn().mockResolvedValue(err({ code: "identity_rejected" }));
    const transport = transportWith({ profileClasses: { list } });
    const ctx = mkCtx();
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("/classes rm <name> calls profileClasses.delete", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm intimate");
    await handleClasses(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", "intimate");
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"intimate" removed');
  });

  it("/classes remove and /classes delete both alias to rm", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { delete: del } });
    await handleClasses(transport, mkCtx("remove intimate"));
    await handleClasses(transport, mkCtx("delete intimate"));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("/classes rm with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("rm");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes rm surfaces profile_class_in_use", async () => {
    const del = vi.fn().mockResolvedValue(err({ code: "profile_class_in_use", profileRefs: 2 }));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm intimate");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("2 profile(s)");
  });

  it("/classes rm surfaces profile_class_not_found", async () => {
    const del = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_not_found", name: "no-such" }));
    const transport = transportWith({ profileClasses: { delete: del } });
    const ctx = mkCtx("rm no-such");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile class named "no-such"');
  });

  it("unknown subcommand replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes restrict <name> calls profileClasses.setRestricted with true", async () => {
    const setRestricted = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("restrict intimate");
    await handleClasses(transport, ctx);
    expect(setRestricted).toHaveBeenCalledWith("1", "intimate", true);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("marked restricted");
  });

  it("/classes unrestrict <name> calls profileClasses.setRestricted with false", async () => {
    const setRestricted = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("unrestrict intimate");
    await handleClasses(transport, ctx);
    expect(setRestricted).toHaveBeenCalledWith("1", "intimate", false);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("no longer restricted");
  });

  it("/classes restrict with no name replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("restrict");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /classes");
  });

  it("/classes restrict surfaces profile_class_not_found", async () => {
    const setRestricted = vi
      .fn()
      .mockResolvedValue(err({ code: "profile_class_not_found", name: "no-such" }));
    const transport = transportWith({ profileClasses: { setRestricted } });
    const ctx = mkCtx("restrict no-such");
    await handleClasses(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile class named "no-such"');
  });
});

describe("handleCompartments", () => {
  it("bare /compartments lists registered customs", async () => {
    const list = vi.fn().mockResolvedValue(
      ok([
        {
          id: "cc-1",
          userId: "u-1",
          name: "dnd",
          description: "tabletop campaign notes",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        },
        {
          id: "cc-2",
          userId: "u-1",
          name: "music",
          description: "music production sessions",
          createdAt: new Date("2026-05-09T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    expect(list).toHaveBeenCalledWith("1");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("dnd");
    expect(reply).toContain("tabletop campaign notes");
    expect(reply).toContain("music");
    // Always remind the operator the core six exist alongside customs.
    expect(reply).toContain("personal");
    expect(reply).toContain("misc");
  });

  it("explicit /compartments list uses the same path", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ compartments: { list } });
    await handleCompartments(transport, mkCtx("list"));
    expect(list).toHaveBeenCalled();
  });

  it("bare /compartments with empty registry surfaces the bootstrap hint and the core list", async () => {
    const list = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("/compartments add");
    expect(reply).toContain("personal");
  });

  it("/compartments add <name> <desc> calls compartments.create", async () => {
    const create = vi.fn().mockResolvedValue(
      ok({
        id: "cc-1",
        userId: "u-1",
        name: "dnd",
        description: "tabletop campaign notes",
        createdAt: new Date("2026-05-09T12:00:00Z"),
      }),
    );
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd tabletop campaign notes");
    await handleCompartments(transport, ctx);
    expect(create).toHaveBeenCalledWith("1", {
      name: "dnd",
      description: "tabletop campaign notes",
    });
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain('Registered compartment "dnd"');
    expect(reply).toContain("compartment:dnd");
  });

  it("/compartments add with no args replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add");
    await handleCompartments(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments add with name but no description replies with usage", async () => {
    const create = vi.fn();
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd");
    await handleCompartments(transport, ctx);
    expect(create).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments add surfaces compartment_name_reserved with the core-list nudge", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "compartment_name_reserved", name: "personal" }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add personal redefined");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"personal" is a core compartment');
  });

  it("/compartments add surfaces compartment_cap_exceeded with the cap numbers", async () => {
    const create = vi
      .fn()
      .mockResolvedValue(err({ code: "compartment_cap_exceeded", limit: 10, current: 10 }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add overflow desc");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("(10/10)");
  });

  it("/compartments add surfaces compartment_name_taken", async () => {
    const create = vi.fn().mockResolvedValue(err({ code: "compartment_name_taken", name: "dnd" }));
    const transport = transportWith({ compartments: { create } });
    const ctx = mkCtx("add dnd desc");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('"dnd" already exists');
  });

  it("/compartments rm <name> calls compartments.delete and notes the forward-only guarantee", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ compartments: { delete: del } });
    const ctx = mkCtx("rm dnd");
    await handleCompartments(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", "dnd");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain('"dnd" removed');
    // Forward-only is the surprising part for the operator — surface it.
    expect(reply).toContain("Forward-only");
  });

  it("/compartments remove and /compartments delete both alias to rm", async () => {
    const del = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({ compartments: { delete: del } });
    await handleCompartments(transport, mkCtx("remove dnd"));
    await handleCompartments(transport, mkCtx("delete dnd"));
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("/compartments rm with no args replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("rm");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("/compartments rm surfaces compartment_not_found", async () => {
    const del = vi.fn().mockResolvedValue(err({ code: "compartment_not_found", name: "no-such" }));
    const transport = transportWith({ compartments: { delete: del } });
    const ctx = mkCtx("rm no-such");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No custom compartment named "no-such"');
  });

  it("bare /compartments surfaces identity_rejected via errorMessage", async () => {
    const list = vi.fn().mockResolvedValue(err({ code: "identity_rejected" }));
    const transport = transportWith({ compartments: { list } });
    const ctx = mkCtx();
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("unknown subcommand replies with usage", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate");
    await handleCompartments(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /compartments");
  });

  it("compartment_unknown error from /profile scope is mapped to an actionable message", async () => {
    // Indirect — `/profile scope` calls Transport.profiles.update which can
    // return `compartment_unknown`. Verify the error mapper here so the
    // message doesn't drift from the underlying error code.
    const update = vi.fn().mockResolvedValue(err({ code: "compartment_unknown", name: "music" }));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "p1",
              userId: "u",
              name: "personal",
              basePrompt: "",
              model: "claude-sonnet-4-6",
              summarizationModel: null,
              extractionModel: null,
              autoRecall: "heuristic" as const,
              voiceMode: "auto" as const,
              toolSet: [],
              memoryScope: null,
              profileClass: null,
              streamChunkChars: 4000,
              streamEdits: true,
              codingAutoapproveMode: "off",
            },
          ]),
        ),
        create: vi.fn().mockResolvedValue(ok({} as never)),
        update,
        delete: vi.fn().mockResolvedValue(ok(undefined)),
      },
    });
    const ctx = mkCtx("scope personal compartments=music trust=first-party");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain('Unknown compartment "music"');
    expect(reply).toContain("/compartments add music");
  });
});

describe("/profile class subcommand", () => {
  function makeProfile(profileClass: string | null = null): Profile {
    return {
      id: "p1",
      userId: "u",
      name: "personal",
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
    };
  }

  it("happy path: /profile class <name> <classname> calls profiles.setClass", async () => {
    const setClass = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        setClass,
      },
    });
    const ctx = mkCtx("class personal intimate");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).toHaveBeenCalledWith("1", "p1", "intimate");
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('Class for "personal" set to "intimate"');
  });

  it("/profile class <name> clear forwards null to setClass", async () => {
    const setClass = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile("intimate")])),
        setClass,
      },
    });
    const ctx = mkCtx("class personal clear");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).toHaveBeenCalledWith("1", "p1", null);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('Class for "personal" cleared');
  });

  it("/profile class CLEAR is case-insensitive on the sentinel", async () => {
    const setClass = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile("intimate")])),
        setClass,
      },
    });
    const ctx = mkCtx("class personal CLEAR");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).toHaveBeenCalledWith("1", "p1", null);
  });

  it("/profile class with too few args replies with usage", async () => {
    const setClass = vi.fn();
    const transport = transportWith({ profiles: { setClass } });
    const ctx = mkCtx("class");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /profile");
  });

  it("/profile class with one arg replies with usage (need profile + class/clear)", async () => {
    const setClass = vi.fn();
    const transport = transportWith({ profiles: { setClass } });
    const ctx = mkCtx("class onlyname");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /profile");
  });

  it("/profile class on unknown profile name replies friendly", async () => {
    const setClass = vi.fn();
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([])),
        setClass,
      },
    });
    const ctx = mkCtx("class ghost intimate");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile named "ghost"');
  });

  it("/profile class supports multi-word profile names (split takes last token as class)", async () => {
    const setClass = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([{ ...makeProfile(), name: "my work" }])),
        setClass,
      },
    });
    const ctx = mkCtx("class my work intimate");
    await handleProfile(transport, ctx, mkDialogs());
    expect(setClass).toHaveBeenCalledWith("1", "p1", "intimate");
  });

  it("/profile class surfaces unknown_profile_class via errorMessage", async () => {
    const setClass = vi
      .fn()
      .mockResolvedValue(err({ code: "unknown_profile_class", name: "nope" }));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        setClass,
      },
    });
    const ctx = mkCtx("class personal nope");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('Unknown profile class "nope"');
  });

  it("/profile class on an ambiguous name replies with the ambiguity hint", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            { ...makeProfile(), id: "p1", name: "shared", userId: "u1" },
            { ...makeProfile(), id: "p2", name: "shared", userId: "u2" },
          ]),
        ),
        setClass: vi.fn(),
      },
    });
    const ctx = mkCtx("class shared intimate");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("ambiguous");
  });

  it("/profile class surfaces an error from profiles.list via errorMessage", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        setClass: vi.fn(),
      },
    });
    const ctx = mkCtx("class personal intimate");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = ctx.reply.mock.calls[0]?.[0];
    // Positive assertion catches the exact friendly-error wording wired
    // in `commands.ts:errorMessage("identity_rejected")`. The
    // accompanying `not.toContain("set to")` rules out a misleading
    // success message — both halves are necessary because a silent
    // return would pass the negative alone.
    expect(reply).toBe("You're not authorized on this bot.");
    expect(reply).not.toContain("set to");
  });
});

describe("/profile stream subcommand", () => {
  function makeProfile(overrides: Partial<Profile> = {}, userId: string | null = "u"): Profile {
    return {
      id: "p1",
      userId,
      name: "personal",
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
      ...overrides,
    };
  }

  it("with no name argument replies with usage", async () => {
    const transport = transportWith({ profiles: { update: vi.fn() } });
    const ctx = mkCtx("stream");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /profile");
  });

  it("`show` form: no tokens → renders current prefs without writing", async () => {
    const update = vi.fn();
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        update,
      },
    });
    const ctx = mkCtx("stream personal");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    expect(reply).toContain('Stream prefs for "personal"');
    expect(reply).toContain("chunk: 4000");
    expect(reply).toContain("edits on");
  });

  it("`set` form: chunk=… edits=off applies changes and renders updated prefs", async () => {
    const update = vi
      .fn()
      .mockResolvedValue(ok(makeProfile({ streamChunkChars: 500, streamEdits: false })));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        update,
      },
    });
    const ctx = mkCtx("stream personal chunk=500 edits=off");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).toHaveBeenCalledWith("1", "p1", {
      streamChunkChars: 500,
      streamEdits: false,
    });
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    expect(reply).toContain("chunk: 500");
    expect(reply).toContain("edits off");
  });

  it("bad token surfaces the parser error instead of writing", async () => {
    const update = vi.fn();
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        update,
      },
    });
    const ctx = mkCtx("stream personal chunk=99999");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("chunk must be an integer");
  });

  it("unknown profile name replies friendly without writing", async () => {
    const update = vi.fn();
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([])), update },
    });
    const ctx = mkCtx("stream ghost edits=on");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile named "ghost"');
  });

  it("ambiguous name replies with the ambiguity hint", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(
          ok([
            { ...makeProfile(), id: "p1", name: "shared", userId: "u1" },
            { ...makeProfile(), id: "p2", name: "shared", userId: "u2" },
          ]),
        ),
        update: vi.fn(),
      },
    });
    const ctx = mkCtx("stream shared chunk=200");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("ambiguous");
  });

  it("surfaces an error from profiles.list via errorMessage", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
        update: vi.fn(),
      },
    });
    const ctx = mkCtx("stream personal chunk=200");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toBe("You're not authorized on this bot.");
    expect(reply).not.toContain("Stream prefs");
  });

  it("surfaces an error from profiles.update via errorMessage", async () => {
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile()])),
        update: vi.fn().mockResolvedValue(err({ code: "profile_not_found" })),
      },
    });
    const ctx = mkCtx("stream personal chunk=200");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toBe("Profile not found.");
    expect(reply).not.toContain("Stream prefs");
  });
});

describe("/profile autoapprove subcommand", () => {
  function makeProfile(overrides: Partial<Profile> = {}): Profile {
    return {
      id: "p1",
      userId: "u",
      name: "personal",
      basePrompt: "",
      model: "claude-sonnet-4-6",
      summarizationModel: null,
      extractionModel: null,
      autoRecall: "heuristic",
      voiceMode: "auto",
      toolSet: [],
      memoryScope: null,
      profileClass: null,
      streamChunkChars: 4000,
      streamEdits: true,
      codingAutoapproveMode: "off",
      ...overrides,
    };
  }

  it("with no name argument replies with usage", async () => {
    const transport = transportWith({ profiles: { update: vi.fn() } });
    const ctx = mkCtx("autoapprove");
    await handleProfile(transport, ctx, mkDialogs());
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /profile");
  });

  it("show form: name only → renders current mode without writing", async () => {
    const update = vi.fn();
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([makeProfile()])), update },
    });
    const ctx = mkCtx("autoapprove personal");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    expect(reply).toContain('Autoapprove for "personal"');
    expect(reply).toContain("off");
  });

  it("set form: `on` calls update with codingAutoapproveMode and renders the new state", async () => {
    const update = vi.fn().mockResolvedValue(ok(makeProfile({ codingAutoapproveMode: "on" })));
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([makeProfile()])), update },
    });
    const ctx = mkCtx("autoapprove personal on");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).toHaveBeenCalledWith("1", "p1", { codingAutoapproveMode: "on" });
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    expect(reply).toContain("on");
    expect(reply).toContain("auto-approve");
  });

  it("set form: `off` calls update with codingAutoapproveMode=off", async () => {
    const update = vi.fn().mockResolvedValue(ok(makeProfile()));
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile({ codingAutoapproveMode: "on" })])),
        update,
      },
    });
    const ctx = mkCtx("autoapprove personal off");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).toHaveBeenCalledWith("1", "p1", { codingAutoapproveMode: "off" });
  });

  it("unknown profile name replies friendly without writing", async () => {
    const update = vi.fn();
    const transport = transportWith({
      profiles: { list: vi.fn().mockResolvedValue(ok([])), update },
    });
    const ctx = mkCtx("autoapprove ghost on");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No profile named "ghost"');
  });

  it("trailing token that isn't on/off becomes part of the profile name (show form)", async () => {
    // The `case "autoapprove":` parser treats the last token as the
    // action only when it's literally `on` or `off`; anything else
    // becomes part of the profile name, and the command falls into the
    // show form (no `update` write). Pins the parse rule so a profile
    // named "two words" doesn't get corrupted by a stray token.
    const update = vi.fn();
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile({ name: "two words" })])),
        update,
      },
    });
    const ctx = mkCtx("autoapprove two words");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    expect(reply).toContain('Autoapprove for "two words"');
  });

  it("transport.profiles.update error surfaces to the user without crashing", async () => {
    // Most natural trigger: trying to flip autoapprove on an org profile
    // returns `access_denied` per Transport's org-profile-read-only
    // invariant. Mock the error surface directly to keep the test
    // focused on the command's reply path.
    const update = vi.fn().mockResolvedValue(
      err({
        code: "access_denied",
        reason: "org profiles are read-only via Transport",
      }),
    );
    const transport = transportWith({
      profiles: {
        list: vi.fn().mockResolvedValue(ok([makeProfile({ userId: null, name: "shared" })])),
        update,
      },
    });
    const ctx = mkCtx("autoapprove shared on");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).toHaveBeenCalledTimes(1);
    const reply = ctx.reply.mock.calls[0]?.[0] ?? "";
    // Doesn't render the success-shape "Autoapprove for ..." line.
    expect(reply).not.toContain('Autoapprove for "shared"');
    // Surfaces something — the actual error text comes from `errorMessage`
    // and is identical across all subcommands; the contract here is
    // "any non-empty failure surface, not a crash."
    expect(reply.length).toBeGreaterThan(0);
  });

  it("ambiguous profile name replies with disambiguation hint without writing", async () => {
    // Two org profiles sharing a name is the practical trigger — both
    // user_id IS NULL, so `resolveProfileByName`'s "pick the owned one"
    // tiebreaker can't help and the resolver surfaces ambiguous.
    const update = vi.fn();
    const transport = transportWith({
      profiles: {
        list: vi
          .fn()
          .mockResolvedValue(
            ok([
              makeProfile({ id: "p1", userId: null, name: "shared" }),
              makeProfile({ id: "p2", userId: null, name: "shared" }),
            ]),
          ),
        update,
      },
    });
    const ctx = mkCtx("autoapprove shared on");
    await handleProfile(transport, ctx, mkDialogs());
    expect(update).not.toHaveBeenCalled();
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("shared");
  });
});

describe("formatScope", () => {
  it("null → 'unrestricted (recalls all memories)'", () => {
    expect(formatScope(null)).toBe("unrestricted (recalls all memories)");
  });

  it("set scope renders compartments + trust", () => {
    expect(formatScope({ compartments: ["work", "technical"], trust: ["first-party"] })).toBe(
      "compartments: work, technical / trust: first-party",
    );
  });

  it("marks custom compartments with `*` and appends a legend when any custom appears", () => {
    expect(
      formatScope(
        { compartments: ["work", "dnd", "technical", "music"], trust: ["first-party"] },
        new Set(["dnd", "music"]),
      ),
    ).toBe("compartments: work, dnd*, technical, music* / trust: first-party (* = custom)");
  });

  it("omits the legend when no compartment is custom (all-core scopes stay clean)", () => {
    expect(
      formatScope(
        { compartments: ["work", "technical"], trust: ["first-party"] },
        new Set(["dnd"]),
      ),
    ).toBe("compartments: work, technical / trust: first-party");
  });

  it("an empty / missing customs set leaves output unmarked (default for callers that don't load customs)", () => {
    // Same input, no second arg → no asterisks, no legend. Lets call
    // sites that don't have the customs loaded (currently /profile list
    // and /status) keep emitting bare scope strings without leaking
    // misleading "no customs exist" through a stale empty Set.
    const out = formatScope({ compartments: ["work", "dnd"], trust: ["first-party"] });
    expect(out).not.toContain("*");
  });

  it("marks restricted classes with `!` and appends a legend when any restricted appears", () => {
    expect(
      formatScope(
        {
          compartments: ["personal"],
          trust: ["first-party"],
          profileClasses: ["intimate", "general"],
        },
        undefined,
        new Set(["intimate"]),
      ),
    ).toBe(
      "compartments: personal / trust: first-party / classes: intimate!, general (! = restricted)",
    );
  });

  it("combines * (custom) and ! (restricted) legends when both apply", () => {
    expect(
      formatScope(
        { compartments: ["work", "dnd"], trust: ["first-party"], profileClasses: ["intimate"] },
        new Set(["dnd"]),
        new Set(["intimate"]),
      ),
    ).toBe(
      "compartments: work, dnd* / trust: first-party / classes: intimate! (* = custom; ! = restricted)",
    );
  });

  it("a missing restrictedClasses set leaves classes unmarked", () => {
    const out = formatScope({
      compartments: ["personal"],
      trust: ["first-party"],
      profileClasses: ["intimate"],
    });
    expect(out).not.toContain("!");
  });

  it("appends speaker class with `(speaker)` annotation when not in the explicit list", () => {
    // Operator wrote `classes=general` but the profile speaks as `intimate`.
    // The Service auto-includes intimate in the recall filter; the rendered
    // scope must reflect that effective set so the operator isn't surprised.
    expect(
      formatScope(
        { compartments: ["personal"], trust: ["first-party"], profileClasses: ["general"] },
        undefined,
        undefined,
        "intimate",
      ),
    ).toBe("compartments: personal / trust: first-party / classes: general, intimate (speaker)");
  });

  it("does not duplicate the speaker class when already in the explicit list", () => {
    expect(
      formatScope(
        {
          compartments: ["personal"],
          trust: ["first-party"],
          profileClasses: ["general", "intimate"],
        },
        undefined,
        undefined,
        "intimate",
      ),
    ).toBe("compartments: personal / trust: first-party / classes: general, intimate");
  });

  it("composes speaker `(speaker)` annotation with `!` restricted marker on the same class", () => {
    expect(
      formatScope(
        { compartments: ["personal"], trust: ["first-party"], profileClasses: ["general"] },
        undefined,
        new Set(["intimate"]),
        "intimate",
      ),
    ).toBe(
      "compartments: personal / trust: first-party / classes: general, intimate! (speaker) (! = restricted)",
    );
  });

  it("speakerClass null leaves classes unannotated", () => {
    expect(
      formatScope(
        { compartments: ["personal"], trust: ["first-party"], profileClasses: ["general"] },
        undefined,
        undefined,
        null,
      ),
    ).toBe("compartments: personal / trust: first-party / classes: general");
  });

  it("speakerClass set but scope has no profileClasses leaves rendering unchanged", () => {
    // No `classes:` segment in the rendered output → no auto-include
    // surface to annotate. Speaker has no effect on the compartment-only
    // scope; the rendering stays the same as before.
    expect(
      formatScope(
        { compartments: ["work"], trust: ["first-party"] },
        undefined,
        undefined,
        "intimate",
      ),
    ).toBe("compartments: work / trust: first-party");
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
      models: { list: vi.fn().mockResolvedValue(["gpt-4o", "claude-sonnet-4-6"]) },
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
    // The handler passes `clearCooldownForConversation` so the model
    // update + cooldown clear land in one tx. See
    // design/agent-resilience.md → Clear triggers.
    expect(update).toHaveBeenCalledWith(
      "1",
      "p1",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c1" },
    );
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

describe("handleSkillsApprovalCallback", () => {
  const pendingId = "019d0000-0000-7000-8000-000000000099";

  it("Approve dispatches to skills.approveDeploy and reports the live skill name + sha", async () => {
    const approve = vi
      .fn()
      .mockResolvedValue(ok({ pendingId, skillName: "echo", gitSha: "abcdef0123" }));
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
    );

    expect(approve).toHaveBeenCalledWith(pendingId, "user-tg-1");
    expect(outcome.editText).toMatch(/Approved/);
    expect(outcome.editText).toMatch(/echo/);
    expect(outcome.editText).toMatch(/abcdef0/);
    expect(outcome.toast).toBe("Approved");
  });

  it("Deny dispatches to skills.denyDeploy without a reason and clears the keyboard", async () => {
    const deny = vi.fn().mockResolvedValue(ok({ pendingId }));
    const transport = transportWith({
      skills: {
        approveDeploy: vi.fn(),
        denyDeploy: deny,
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "deny" },
      "user-tg-1",
    );

    expect(deny).toHaveBeenCalledWith(pendingId, "user-tg-1");
    expect(outcome.editText).toMatch(/denied/);
    expect(outcome.editText).toMatch(/no main advance/);
    expect(outcome.toast).toBe("Denied");
  });

  it("identity_rejected from Transport surfaces an unauthorized message", async () => {
    const approve = vi.fn().mockResolvedValue(err({ code: "identity_rejected" as const }));
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "wrong-user",
    );

    expect(outcome.editText).toMatch(/not authorized/);
    expect(outcome.toast).toMatch(/not authorized/);
  });

  it("double-tap on already-resolved deploy gets skill_deploy_not_pending", async () => {
    const approve = vi.fn().mockResolvedValue(
      err({
        code: "skill_deploy_not_pending" as const,
        pendingId,
        status: "denied",
      }),
    );
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
    );

    expect(outcome.editText).toMatch(/can't be acted on/);
    expect(outcome.editText).toMatch(/denied/);
  });

  it("approve runner failure (skill_deploy_register_failed) surfaces the runner reason", async () => {
    const approve = vi.fn().mockResolvedValue(
      err({
        code: "skill_deploy_register_failed" as const,
        pendingId,
        reason: "non_fast_forward_at_approve_time",
      }),
    );
    const transport = transportWith({
      skills: {
        approveDeploy: approve,
        denyDeploy: vi.fn(),
      },
    });

    const outcome = await handleSkillsApprovalCallback(
      transport,
      { pendingId, action: "approve" },
      "user-tg-1",
    );

    expect(outcome.editText).toMatch(/non_fast_forward_at_approve_time/);
  });
});

describe("handleMcp", () => {
  function mcpServerStatus(overrides: {
    name: string;
    approvalStatus?: "pending" | "approved" | "needs_reapproval";
    toolCount?: number;
    approvedToolCount?: number;
    enabled?: boolean;
    lastError?: string | null;
  }) {
    return {
      id: `id-${overrides.name}`,
      name: overrides.name,
      config: {
        transport: "stdio" as const,
        command: "npx",
        args: [],
        env: {},
      },
      enabled: overrides.enabled ?? true,
      approvalStatus: overrides.approvalStatus ?? "pending",
      lastConnectedAt: null,
      lastError: overrides.lastError ?? null,
      createdAt: new Date(),
      toolCount: overrides.toolCount ?? 0,
      approvedToolCount: overrides.approvedToolCount ?? 0,
    };
  }

  it("replies with usage when called with no args", async () => {
    const ctx = mkCtx();
    await handleMcp(transportWith(), ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Usage: \/mcp/));
  });

  it("list with no servers prompts to add one", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([])),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/No MCP servers configured/));
  });

  it("list renders status, transport, and approved/total counts", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(
          ok([
            mcpServerStatus({
              name: "github",
              approvalStatus: "approved",
              toolCount: 5,
              approvedToolCount: 3,
            }),
            mcpServerStatus({
              name: "linear",
              approvalStatus: "pending",
              toolCount: 0,
              approvedToolCount: 0,
              enabled: false,
            }),
          ]),
        ),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/github \[stdio\] — approved, 3\/5 tools approved/);
    expect(reply).toMatch(/linear \[stdio\] — pending, 0\/0 tools approved \(disabled\)/);
  });

  it("add parses trailing JSON config", async () => {
    const addServer = vi.fn().mockResolvedValue(
      ok({
        id: "id-1",
        name: "github",
        approvalStatus: "pending",
      }),
    );
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer,
        removeServer: vi.fn(),
        listServers: vi.fn(),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx(
      'add github {"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{}}',
    );
    await handleMcp(transport, ctx);
    expect(addServer).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ name: "github", enabled: true }),
    );
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/added \(status: pending\)/));
  });

  it("add rejects malformed JSON with a precise error", async () => {
    const transport = transportWith();
    const ctx = mkCtx("add github {not json}");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Invalid JSON/));
  });

  it("approve <name> calls approveServer with the resolved id", async () => {
    const approveServer = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer,
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github");
    await handleMcp(transport, ctx);
    expect(approveServer).toHaveBeenCalledWith("1", "id-github");
  });

  it("approve <name> <tool> flips a single tool", async () => {
    const approveTool = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool,
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github create_pr");
    await handleMcp(transport, ctx);
    expect(approveTool).toHaveBeenCalledWith("1", "id-github", "create_pr");
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/Tool "github\.create_pr" approved/),
    );
  });

  it("approve <name> <typo> surfaces mcp_tool_not_found instead of false-positive success", async () => {
    const approveTool = vi
      .fn()
      .mockResolvedValue(
        err({ code: "mcp_tool_not_found" as const, serverId: "id-github", toolName: "typo" }),
      );
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool,
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("approve github typo");
    await handleMcp(transport, ctx);
    expect(approveTool).toHaveBeenCalledWith("1", "id-github", "typo");
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/Tool "typo" not found on server/),
    );
  });

  it("reject requires both name and tool", async () => {
    const ctx = mkCtx("reject github");
    await handleMcp(transportWith(), ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Usage: \/mcp/));
  });

  it("remove resolves the name to the server id and calls removeServer", async () => {
    const removeServer = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer,
        listServers: vi.fn().mockResolvedValue(ok([mcpServerStatus({ name: "github" })])),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("remove github");
    await handleMcp(transport, ctx);
    expect(removeServer).toHaveBeenCalledWith("1", "id-github");
  });

  it("pending lists only servers with unapproved state", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(
          ok([
            mcpServerStatus({
              name: "approved-fully",
              approvalStatus: "approved",
              toolCount: 2,
              approvedToolCount: 2,
            }),
            mcpServerStatus({
              name: "needs-tools",
              approvalStatus: "approved",
              toolCount: 3,
              approvedToolCount: 1,
            }),
            mcpServerStatus({ name: "pending-server", approvalStatus: "pending" }),
          ]),
        ),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("pending");
    await handleMcp(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/needs-tools.*\(2 tools pending\)/);
    expect(reply).toMatch(/pending-server.*server status: pending/);
    expect(reply).not.toMatch(/approved-fully/);
  });

  it("maps mcp_disabled to a friendly message", async () => {
    const transport = transportWith({
      mcp: {
        toolBudget: vi.fn().mockReturnValue(25),
        addServer: vi.fn(),
        removeServer: vi.fn(),
        listServers: vi.fn().mockResolvedValue(err({ code: "mcp_disabled" as const })),
        approveServer: vi.fn(),
        approveTool: vi.fn(),
        rejectTool: vi.fn(),
      },
    });
    const ctx = mkCtx("list");
    await handleMcp(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringMatching(/MCP integrations are unavailable/),
    );
  });
});

describe("handleRepair", () => {
  // Bare `/repair` (no arg) acts on the current session. Mirrors `/name`'s
  // pattern of calling resolveSession to find the active conversation id.
  it("uses the active session when called with no arg", async () => {
    const repair = vi.fn().mockResolvedValue(ok({ wasCoolingDown: true }));
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s1",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c1",
        status: "active",
        receive: "routed",
      }),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair,
      },
    });
    const ctx = mkCtx();
    await handleRepair(transport, ctx);
    expect(repair).toHaveBeenCalledWith("1", "c1");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/Repaired/));
  });

  it("replies 'isn't cooling down' when wasCoolingDown: false", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s1",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c1",
        status: "active",
        receive: "routed",
      }),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair: vi.fn().mockResolvedValue(ok({ wasCoolingDown: false })),
      },
    });
    const ctx = mkCtx();
    await handleRepair(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/isn't cooling down/));
  });

  it("tells the user when there's no active session and no arg", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue(undefined),
    });
    const ctx = mkCtx();
    await handleRepair(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/No active conversation/));
  });

  // UUID arg path — bypasses the alias lookup.
  it("uses the UUID directly when given a UUID arg", async () => {
    const repair = vi.fn().mockResolvedValue(ok({ wasCoolingDown: true }));
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair,
      },
    });
    const ctx = mkCtx("019d0000-0000-7000-8000-000000000001");
    await handleRepair(transport, ctx);
    expect(repair).toHaveBeenCalledWith("1", "019d0000-0000-7000-8000-000000000001");
  });

  // Alias arg path — looks up the conversation in `list`, then calls repair
  // with the resolved id.
  it("resolves alias args via conversations.list", async () => {
    const repair = vi.fn().mockResolvedValue(ok({ wasCoolingDown: true }));
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "c-resolved",
              profileName: "p",
              alias: "stuck",
              lastMessagePreview: "hi",
              lastMessageAt: new Date(),
            },
          ]),
        ),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair,
      },
    });
    const ctx = mkCtx("stuck");
    await handleRepair(transport, ctx);
    expect(repair).toHaveBeenCalledWith("1", "c-resolved");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("stuck"));
  });

  it("reports a friendly error when alias has no match", async () => {
    const transport = transportWith({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair: vi.fn().mockResolvedValue(ok({ wasCoolingDown: false })),
      },
    });
    const ctx = mkCtx("ghost");
    await handleRepair(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/No conversation with alias/));
  });

  // Transport errors pass through to the user-facing error formatter.
  it("surfaces transport errors via errorMessage", async () => {
    const transport = transportWith({
      resolveSession: vi.fn().mockResolvedValue({
        id: "s1",
        channelId: "ch",
        platformAddress: "42",
        conversationId: "c1",
        status: "active",
        receive: "routed",
      }),
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
      },
    });
    const ctx = mkCtx();
    await handleRepair(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
  });
});

describe("handleVoice", () => {
  function transportForVoice(
    overrides: {
      setVoiceMode?: Transport["conversations"]["setVoiceMode"];
      voiceMode?: "auto" | "always" | "never" | null;
      profileVoiceMode?: "auto" | "always" | "never";
      noSession?: boolean;
    } = {},
  ) {
    return transportWith({
      resolveSession: overrides.noSession
        ? vi.fn().mockResolvedValue(null)
        : vi.fn().mockResolvedValue({
            id: "s1",
            channelId: "ch",
            platformAddress: "42",
            conversationId: "c1",
            status: "active",
            receive: "routed",
          }),
      conversations: {
        getCurrent: vi.fn().mockResolvedValue(
          ok({
            conversationId: "c1",
            profileId: "p1",
            profileName: "main",
            model: "claude",
            voiceMode: overrides.voiceMode ?? null,
            profileVoiceMode: overrides.profileVoiceMode ?? "auto",
          }),
        ),
        ...(overrides.setVoiceMode !== undefined && { setVoiceMode: overrides.setVoiceMode }),
      },
    });
  }

  it("rejects when there's no active session", async () => {
    const transport = transportForVoice({ noSession: true });
    const ctx = mkCtx("");
    await handleVoice(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No active conversation"));
  });

  it("bare /voice shows current effective mode (override is null → follow profile)", async () => {
    const transport = transportForVoice({ voiceMode: null });
    const ctx = mkCtx("");
    await handleVoice(transport, ctx);
    const replyText = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(replyText).toMatch(/Voice mode:/);
    expect(replyText).toContain("follow profile default");
  });

  it("bare /voice shows the explicit override when set", async () => {
    const transport = transportForVoice({ voiceMode: "always" });
    const ctx = mkCtx("");
    await handleVoice(transport, ctx);
    const replyText = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(replyText).toContain("Voice mode: always");
  });

  it.each([
    ["auto", "auto"],
    ["always", "always"],
    ["off", "never"],
    ["never", "never"],
  ])("/voice %s persists %s as the override", async (arg, mode) => {
    const setVoiceMode = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportForVoice({ setVoiceMode });
    const ctx = mkCtx(arg);
    await handleVoice(transport, ctx);
    expect(setVoiceMode).toHaveBeenCalledWith("1", "c1", mode);
    expect(ctx.reply).toHaveBeenCalledWith(`Voice mode: ${mode}`);
  });

  it("/voice clear passes null to setVoiceMode", async () => {
    const setVoiceMode = vi.fn().mockResolvedValue(ok(undefined));
    const transport = transportForVoice({ setVoiceMode });
    const ctx = mkCtx("clear");
    await handleVoice(transport, ctx);
    expect(setVoiceMode).toHaveBeenCalledWith("1", "c1", null);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("cleared (following profile default)"),
    );
  });

  it("/voice <bogus> shows usage", async () => {
    const transport = transportForVoice();
    const ctx = mkCtx("loud");
    await handleVoice(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Usage: /voice"));
  });

  it("propagates Transport errors to the user", async () => {
    const setVoiceMode = vi.fn().mockResolvedValue(err({ code: "identity_rejected" }));
    const transport = transportForVoice({ setVoiceMode });
    const ctx = mkCtx("always");
    await handleVoice(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
  });
});

describe("handleStatus", () => {
  function transportWithSummary(value: unknown) {
    return transportWith({
      conversations: {
        summary: vi.fn().mockResolvedValue(value),
      },
    });
  }

  it("nudges the user to send a message when no active session", async () => {
    const transport = transportWithSummary(ok(null));
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("No active conversation"));
  });

  it("renders the summary on success", async () => {
    const transport = transportWithSummary(
      ok({
        conversationId: "11111111-2222-3333-4444-555555556666",
        alias: "work",
        cooldownState: null,
        createdAt: new Date(),
        lastMessageAt: new Date(),
        messageCount: 4,
        profile: {
          id: "p1",
          name: "main",
          model: "claude-sonnet-4-6",
          toolCount: 3,
          autoRecall: "heuristic",
          memoryScope: null,
          profileClass: null,
          streamChunkChars: 4000,
          streamEdits: true,
          voiceMode: "auto",
        },
        voiceMode: null,
        lastTurn: { inputTokens: 1234, outputTokens: 56 },
        contextBudget: 180_000,
        steeringRulesCount: 1,
        mcp: null,
      }),
    );
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("work · status: active");
    expect(reply).toContain("main · claude-sonnet-4-6");
    expect(reply).toContain("steering: 1 rules");
  });

  it("propagates Transport errors with the same mapping as other commands", async () => {
    const transport = transportWithSummary(err({ code: "identity_rejected" }));
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("not authorized"));
  });

  it("fetches the restricted-classes registry and renders `!` markers when the scope sets profileClasses", async () => {
    const profileClassesList = vi.fn().mockResolvedValue(
      ok([
        {
          id: "c-1",
          userId: "u-1",
          name: "intimate",
          description: "x",
          restricted: true,
          createdAt: new Date("2026-04-16T12:00:00Z"),
        },
      ]),
    );
    const transport = transportWith({
      conversations: {
        summary: vi.fn().mockResolvedValue(
          ok({
            conversationId: "11111111-2222-3333-4444-555555556666",
            alias: "private",
            cooldownState: null,
            createdAt: new Date(),
            lastMessageAt: new Date(),
            messageCount: 4,
            profile: {
              id: "p1",
              name: "private",
              model: "claude-sonnet-4-6",
              toolCount: 3,
              autoRecall: "heuristic",
              memoryScope: {
                compartments: ["personal"],
                trust: ["first-party"],
                profileClasses: ["intimate"],
              },
              profileClass: "intimate",
              voiceMode: "auto",
            },
            voiceMode: null,
            lastTurn: { inputTokens: 1234, outputTokens: 56 },
            contextBudget: 180_000,
            steeringRulesCount: 1,
            mcp: null,
          }),
        ),
      },
      profileClasses: { list: profileClassesList },
    });
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    expect(profileClassesList).toHaveBeenCalledWith("1");
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("classes: intimate!");
    expect(reply).toContain("(! = restricted)");
  });

  it("renders the speaker auto-include `(speaker)` annotation alongside the `!` marker", async () => {
    // The combined case: speaker=intimate (restricted), explicit
    // scope.profileClasses=["general"]. Service auto-includes intimate;
    // /status must surface that.
    const transport = transportWith({
      conversations: {
        summary: vi.fn().mockResolvedValue(
          ok({
            conversationId: "11111111-2222-3333-4444-555555556666",
            alias: "private",
            cooldownState: null,
            createdAt: new Date(),
            lastMessageAt: new Date(),
            messageCount: 4,
            profile: {
              id: "p1",
              name: "private",
              model: "claude-sonnet-4-6",
              toolCount: 3,
              autoRecall: "heuristic",
              memoryScope: {
                compartments: ["personal"],
                trust: ["first-party"],
                profileClasses: ["general"],
              },
              profileClass: "intimate",
              voiceMode: "auto",
            },
            voiceMode: null,
            lastTurn: { inputTokens: 1234, outputTokens: 56 },
            contextBudget: 180_000,
            steeringRulesCount: 1,
            mcp: null,
          }),
        ),
      },
      profileClasses: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: "c-1",
              userId: "u-1",
              name: "intimate",
              description: "x",
              restricted: true,
              createdAt: new Date("2026-04-16T12:00:00Z"),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0];
    expect(reply).toContain("classes: general, intimate! (speaker)");
    expect(reply).toContain("(! = restricted)");
  });

  it("skips the registry fetches when the scope is null and the profile is unclassed", async () => {
    const profileClassesList = vi.fn().mockResolvedValue(ok([]));
    const compartmentsList = vi.fn().mockResolvedValue(ok([]));
    const transport = transportWith({
      conversations: {
        summary: vi.fn().mockResolvedValue(
          ok({
            conversationId: "11111111-2222-3333-4444-555555556666",
            alias: "work",
            cooldownState: null,
            createdAt: new Date(),
            lastMessageAt: new Date(),
            messageCount: 4,
            profile: {
              id: "p1",
              name: "main",
              model: "claude-sonnet-4-6",
              toolCount: 3,
              autoRecall: "heuristic",
              memoryScope: null,
              profileClass: null,
              streamChunkChars: 4000,
              streamEdits: true,
              codingAutoapproveMode: "off",
              voiceMode: "auto",
            },
            voiceMode: null,
            lastTurn: { inputTokens: 1234, outputTokens: 56 },
            contextBudget: 180_000,
            steeringRulesCount: 1,
            mcp: null,
          }),
        ),
      },
      profileClasses: { list: profileClassesList },
      compartments: { list: compartmentsList },
    });
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    // No `classes:` in rendered scope → no marker possible → skip
    // both registry fetches.
    expect(profileClassesList).not.toHaveBeenCalled();
    expect(compartmentsList).not.toHaveBeenCalled();
  });

  it("degrades gracefully when the profileClasses registry list errors (status still rendered)", async () => {
    const transport = transportWith({
      conversations: {
        summary: vi.fn().mockResolvedValue(
          ok({
            conversationId: "11111111-2222-3333-4444-555555556666",
            alias: "private",
            cooldownState: null,
            createdAt: new Date(),
            lastMessageAt: new Date(),
            messageCount: 4,
            profile: {
              id: "p1",
              name: "private",
              model: "claude-sonnet-4-6",
              toolCount: 3,
              autoRecall: "heuristic",
              memoryScope: {
                compartments: ["personal"],
                trust: ["first-party"],
                profileClasses: ["intimate"],
              },
              profileClass: "intimate",
              voiceMode: "auto",
            },
            voiceMode: null,
            lastTurn: { inputTokens: 1234, outputTokens: 56 },
            contextBudget: 180_000,
            steeringRulesCount: 1,
            mcp: null,
          }),
        ),
      },
      profileClasses: {
        list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })),
      },
    });
    const ctx = mkCtx();
    await handleStatus(transport, ctx);
    const reply = ctx.reply.mock.calls[0]?.[0];
    // /status should still render; just without restricted markers.
    expect(reply).toContain("private · status: active");
    expect(reply).toContain("classes: intimate");
    expect(reply).not.toContain("intimate!");
    expect(reply).not.toContain("not authorized");
  });
});

describe("handleSkills", () => {
  it("renders one line per skill, with disabled marker", async () => {
    const transport = transportWith({
      skills: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              name: "alpha",
              tier: "wasm",
              riskTier: "auto",
              disabled: false,
              gitSha: "1234567abcdef",
            },
            {
              name: "beta",
              tier: "container",
              riskTier: "approve",
              disabled: true,
              gitSha: "fedcba9012345",
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("alpha [wasm/auto] @ 1234567");
    expect(reply).toContain("beta [container/approve] @ fedcba9 (disabled)");
  });

  it("nudges the user when there are no skills", async () => {
    const transport = transportWith({
      skills: { list: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("No skills registered");
  });

  it("maps skills_disabled to a friendly message", async () => {
    const transport = transportWith({
      skills: { list: vi.fn().mockResolvedValue(err({ code: "skills_disabled" })) },
    });
    const ctx = mkCtx();
    await handleSkills(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Skills runtime is unavailable");
  });
});

describe("handleDisable", () => {
  it("requires a name argument", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleDisable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /disable <name>");
  });

  it("calls transport.skills.disable and confirms success", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ name: "echo" }));
    const transport = transportWith({ skills: { disable } });
    const ctx = mkCtx("echo");
    await handleDisable(transport, ctx);
    expect(disable).toHaveBeenCalledWith("1", "echo");
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" disabled.');
  });

  it("renders skill_not_found with a friendly message that hints at /skills", async () => {
    const transport = transportWith({
      skills: {
        disable: vi.fn().mockResolvedValue(err({ code: "skill_not_found", name: "ghost" })),
      },
    });
    const ctx = mkCtx("ghost");
    await handleDisable(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain('No skill named "ghost"');
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/skills");
  });
});

describe("handleEnable", () => {
  it("requires a name argument", async () => {
    const transport = transportWith();
    const ctx = mkCtx();
    await handleEnable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith("Usage: /enable <name>");
  });

  it("calls transport.skills.enable and confirms success", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ name: "echo", alreadyEnabled: false }));
    const transport = transportWith({ skills: { enable } });
    const ctx = mkCtx("echo");
    await handleEnable(transport, ctx);
    expect(enable).toHaveBeenCalledWith("1", "echo");
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" enabled.');
  });

  it("reports idempotent already-enabled state without re-enabling", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ name: "echo", alreadyEnabled: true }));
    const transport = transportWith({ skills: { enable } });
    const ctx = mkCtx("echo");
    await handleEnable(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith('Skill "echo" is already enabled.');
  });

  it("renders skill_no_live_deploy with a re-register hint", async () => {
    const transport = transportWith({
      skills: {
        enable: vi
          .fn()
          .mockResolvedValue(err({ code: "skill_no_live_deploy", name: "denied-skill" })),
      },
    });
    const ctx = mkCtx("denied-skill");
    await handleEnable(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain('"denied-skill"');
    expect(reply).toContain("no live deploy");
    expect(reply).toContain("re-register");
  });
});

describe("handleSchedules", () => {
  const TASK_ID_A = "019e2900-0000-7000-8000-000000000001";
  const TASK_ID_B = "019e2900-0000-7000-8000-000000000002";

  // --- /schedules (list) ---

  it("renders a numbered list with full ids and a per-task block", async () => {
    const transport = transportWith({
      scheduling: {
        list: vi.fn().mockResolvedValue(
          ok([
            {
              id: TASK_ID_A,
              kind: "recurring",
              cron: "0 9 * * *",
              prompt: "morning briefing",
              timezone: "Europe/London",
              nextRunAt: new Date("2026-06-01T08:00:00Z"),
              lastRunAt: null,
              enabled: true,
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Scheduled tasks (1):");
    expect(reply).toContain(TASK_ID_A);
    expect(reply).toContain("cron '0 9 * * *' (Europe/London)");
    expect(reply).toContain("morning briefing");
    expect(reply).toContain("next: 2026-06-01T08:00:00.000Z");
    // Enabled rows have no marker (only disabled ones do).
    expect(reply).not.toContain("[disabled]");
  });

  it("nudges the user when there are no tasks", async () => {
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("No scheduled tasks");
  });

  it("marks disabled rows and sinks them to the end", async () => {
    const transport = transportWith({
      scheduling: {
        list: vi.fn().mockResolvedValue(
          ok([
            // Earlier nextRunAt but DISABLED — should sink to the end.
            {
              id: TASK_ID_A,
              kind: "recurring",
              cron: "0 1 * * *",
              prompt: "disabled-first-by-time",
              timezone: "UTC",
              nextRunAt: new Date("2026-06-01T01:00:00Z"),
              lastRunAt: null,
              enabled: false,
            },
            // Later nextRunAt but ENABLED — should win the top slot.
            {
              id: TASK_ID_B,
              kind: "one_off",
              cron: null,
              prompt: "enabled-but-later",
              timezone: "UTC",
              nextRunAt: new Date("2026-06-01T09:00:00Z"),
              lastRunAt: null,
              enabled: true,
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    const enabledIdx = reply.indexOf(TASK_ID_B);
    const disabledIdx = reply.indexOf(TASK_ID_A);
    expect(enabledIdx).toBeGreaterThan(-1);
    expect(disabledIdx).toBeGreaterThan(enabledIdx);
    expect(reply).toContain("[disabled]");
  });

  it("maps identity_rejected to a friendly error", async () => {
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(err({ code: "identity_rejected" })) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("not authorized");
  });

  it("truncates the list at 15 entries and surfaces the hidden count + agent nudge", async () => {
    // Telegram's 4096-char per-message cap would 400 with MESSAGE_TOO_LONG
    // if we rendered all 200 cap'd tasks (each ~210 chars worst case).
    // Cap the rendered list at 15 and tell the user the rest is reachable
    // via the agent's `list_tasks` (no display cap).
    const total = 50;
    const tasks = Array.from({ length: total }, (_, i) => ({
      id: `019e2900-0000-7000-8000-${String(i).padStart(12, "0")}`,
      kind: "recurring" as const,
      cron: "0 9 * * *",
      prompt: "x",
      timezone: "UTC",
      // Earlier index → earlier fire so sort is deterministic.
      nextRunAt: new Date(2026, 5, 1 + i),
      lastRunAt: null,
      enabled: true,
    }));
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok(tasks)) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;

    // Header carries the FULL count, not the displayed count.
    expect(reply).toContain(`Scheduled tasks (${total}):`);
    // First 15 rendered (numbered 1..15). The 16th-onwards IDs are not in the body.
    expect(reply).toContain(tasks[14]!.id);
    expect(reply).not.toContain(tasks[15]!.id);
    // Footer surfaces the hidden count + steers to the agent tool.
    expect(reply).toContain(`... and ${total - 15} more`);
    expect(reply).toContain("list_tasks");
    // Stays comfortably under Telegram's 4096-char cap.
    expect(reply.length).toBeLessThan(4096);
  });

  it("doesn't print the truncation footer when all tasks fit", async () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `019e2900-0000-7000-8000-${String(i).padStart(12, "0")}`,
      kind: "recurring" as const,
      cron: "0 9 * * *",
      prompt: "x",
      timezone: "UTC",
      nextRunAt: new Date(2026, 5, 1 + i),
      lastRunAt: null,
      enabled: true,
    }));
    const transport = transportWith({
      scheduling: { list: vi.fn().mockResolvedValue(ok(tasks)) },
    });
    const ctx = mkCtx();
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    // Match the truncation-footer pattern specifically, not the
    // bare word "and " (which could appear in future copy).
    expect(reply).not.toMatch(/and \d+ more/);
  });

  // --- /schedules disable <id> ---

  it("disable: dispatches to transport.scheduling.disable and confirms success", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: false }));
    const transport = transportWith({ scheduling: { disable } });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(disable).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/disabled\.?$/);
  });

  it("disable: reports idempotent 'already disabled' when alreadyAtState=true", async () => {
    const disable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: true }));
    const transport = transportWith({ scheduling: { disable } });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("already disabled");
  });

  it("disable: maps schedule_not_found to a friendly error that hints at /schedules", async () => {
    const transport = transportWith({
      scheduling: {
        disable: vi.fn().mockResolvedValue(err({ code: "schedule_not_found", id: TASK_ID_A })),
      },
    });
    const ctx = mkCtx(`disable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("No scheduled task");
    expect(reply).toContain("/schedules");
  });

  it("disable: maps schedule_id_malformed to a friendly error", async () => {
    const transport = transportWith({
      scheduling: {
        disable: vi.fn().mockResolvedValue(err({ code: "schedule_id_malformed", id: "garbage" })),
      },
    });
    const ctx = mkCtx("disable garbage");
    await handleSchedules(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("doesn't look like a valid task id");
  });

  // --- /schedules enable <id> ---

  it("enable: dispatches and confirms 'enabled'", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: false }));
    const transport = transportWith({ scheduling: { enable } });
    const ctx = mkCtx(`enable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(enable).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/enabled\.?$/);
  });

  it("enable: reports 'already enabled' when alreadyAtState=true", async () => {
    const enable = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A, alreadyAtState: true }));
    const transport = transportWith({ scheduling: { enable } });
    const ctx = mkCtx(`enable ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("already enabled");
  });

  // --- /schedules delete <id> ---

  it("delete: dispatches and confirms removal", async () => {
    const del = vi.fn().mockResolvedValue(ok({ id: TASK_ID_A }));
    const transport = transportWith({ scheduling: { delete: del } });
    const ctx = mkCtx(`delete ${TASK_ID_A}`);
    await handleSchedules(transport, ctx);
    expect(del).toHaveBeenCalledWith("1", TASK_ID_A);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/removed\.?$/);
  });

  // --- usage / argument parsing ---

  it("prints USAGE on unknown subcommand", async () => {
    const transport = transportWith();
    const ctx = mkCtx("frobnicate xyz");
    await handleSchedules(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /schedules");
  });

  it("prints USAGE on missing id for disable/enable/delete", async () => {
    const transport = transportWith();
    for (const sub of ["disable", "enable", "delete"]) {
      const ctx = mkCtx(sub);
      await handleSchedules(transport, ctx);
      expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /schedules");
    }
  });
});

describe("handleLearned", () => {
  const EVT_A = "019e2900-0000-7000-8000-0000000000aa";
  const EVT_B = "019e2900-0000-7000-8000-0000000000bb";

  function makePayload(overrides?: {
    extracted?: number;
    reinforced?: number;
    promoted?: number;
    memories?: number;
  }) {
    return {
      corrections: {
        extracted: overrides?.extracted ?? 1,
        reinforced: overrides?.reinforced ?? 0,
        contradictions: 0,
        promoted: overrides?.promoted ?? 0,
        outOfScopeReinforcementsSkipped: 0,
        unknownRuleReinforcementsSkipped: 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: { extracted: overrides?.memories ?? 0, byNetwork: {} },
      drained: { drained: 0, byNetwork: {} },
      messageCount: 8,
      profileId: "11111111-1111-7111-8111-111111111111",
    };
  }

  it("renders a digest with id, timestamp, and rule/memory counts", async () => {
    const transport = transportWith({
      evolution: {
        listEvents: vi.fn().mockResolvedValue(
          ok([
            {
              id: EVT_B,
              conversationId: "c1",
              triggeredBy: "manual",
              payload: makePayload({ extracted: 2, memories: 3 }),
              createdAt: new Date("2026-06-01T10:00:00Z"),
            },
            {
              id: EVT_A,
              conversationId: "c1",
              triggeredBy: "idle",
              payload: makePayload({ extracted: 1, memories: 1 }),
              createdAt: new Date("2026-05-30T08:00:00Z"),
            },
          ]),
        ),
      },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("Evolution events (2):");
    expect(reply).toContain(EVT_B);
    expect(reply).toContain("[manual]");
    expect(reply).toContain("2 rule change(s)");
    expect(reply).toContain("3 memory write(s)");
  });

  it("nudges the user to /reflect when there are no events", async () => {
    const transport = transportWith({
      evolution: { listEvents: vi.fn().mockResolvedValue(ok([])) },
    });
    const ctx = mkCtx();
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("/reflect");
  });

  it("renders detail when given a valid uuid arg", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT_A,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ extracted: 2, reinforced: 1, memories: 4 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT_A);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain(`Event ${EVT_A}`);
    expect(reply).toContain("Triggered by: idle");
    expect(reply).toContain("extracted:    2");
    expect(reply).toContain("reinforced:   1");
    expect(reply).toContain("Memories: 4 extracted");
  });

  it("reports a clear miss when the event id is unknown", async () => {
    const transport = transportWith({
      evolution: { getEvent: vi.fn().mockResolvedValue(ok(null)) },
    });
    const ctx = mkCtx(EVT_A);
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/No evolution event/);
  });

  it("rejects non-uuid arguments with USAGE", async () => {
    const transport = transportWith();
    const ctx = mkCtx("not-a-uuid");
    await handleLearned(transport, ctx);
    expect(ctx.reply.mock.calls[0]?.[0]).toContain("Usage: /learned");
  });
});

describe("handleReflect", () => {
  it("renders processed digest with rule, memory, and event-id breadcrumb", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000cc",
            ruleChanges: { extracted: 2, reinforced: 1, promoted: 1 },
            memoryCount: 3,
            drained: 0,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    // First reply is the "Reflecting…" pre-message; second is the digest.
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toMatch(/Reflected/);
    expect(digest).toContain("2 new");
    expect(digest).toContain("1 reinforced");
    expect(digest).toContain("3 extracted");
    expect(digest).toContain("/learned 019e2900");
  });

  it("reports too-short conversations clearly", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi
          .fn()
          .mockResolvedValue(ok({ status: "skipped", reason: "too_short" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/too short/i);
  });

  it("reports no-session when there's no active conversation", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(ok({ status: "no_session" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/No active conversation/);
  });

  it("renders a 'no changes' digest when nothing was extracted", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(
          ok({
            status: "processed",
            eventId: "019e2900-0000-7000-8000-0000000000dd",
            ruleChanges: { extracted: 0, reinforced: 0, promoted: 0 },
            memoryCount: 0,
            drained: 0,
          }),
        ),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    const digest = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(digest).toContain("no rule changes");
    expect(digest).toContain("no memories");
  });

  it("surfaces TransportError messages", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi.fn().mockResolvedValue(err({ code: "evolution_unavailable" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/Evolution isn't wired/i);
  });

  // Coverage for the "row vanished mid-call" branches — exercised when
  // the Observer returns skipped with reason `conversation_not_found` or
  // `profile_not_found`. Both should fall through to the same soft-error
  // copy without throwing.
  for (const reason of ["conversation_not_found", "profile_not_found"] as const) {
    it(`reports Couldn't-load on skipped/${reason}`, async () => {
      const transport = transportWith({
        evolution: {
          triggerReflection: vi.fn().mockResolvedValue(ok({ status: "skipped", reason })),
        },
      });
      const ctx = mkCtx();
      await handleReflect(transport, ctx);
      expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/Couldn't load the conversation/);
    });
  }

  it("interpolates the live MIN_MESSAGES_FOR_EXTRACTION threshold into the too-short copy", async () => {
    const transport = transportWith({
      evolution: {
        triggerReflection: vi
          .fn()
          .mockResolvedValue(ok({ status: "skipped", reason: "too_short" })),
      },
    });
    const ctx = mkCtx();
    await handleReflect(transport, ctx);
    // The renderer imports MIN_MESSAGES_FOR_EXTRACTION from the
    // Observer; this regression test catches a future drift where the
    // copy hardcodes a number again.
    const { MIN_MESSAGES_FOR_EXTRACTION } = await import("../../../agent/evolution/index.js");
    expect(ctx.reply.mock.calls[1]?.[0]).toContain(`${MIN_MESSAGES_FOR_EXTRACTION} messages`);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-06-01T12:00:00Z");

  it("renders sub-45s deltas as 'now'", () => {
    expect(formatRelativeTime(new Date("2026-06-01T11:59:30Z"), now)).toBe("now");
  });

  it("renders minute deltas", () => {
    expect(formatRelativeTime(new Date("2026-06-01T11:55:00Z"), now)).toBe("5 minutes ago");
  });

  it("renders hour deltas", () => {
    expect(formatRelativeTime(new Date("2026-06-01T09:00:00Z"), now)).toBe("3 hours ago");
  });

  it("renders 'yesterday' for ~24h ago", () => {
    expect(formatRelativeTime(new Date("2026-05-31T12:00:00Z"), now)).toBe("yesterday");
  });

  it("renders day deltas within a week", () => {
    expect(formatRelativeTime(new Date("2026-05-29T12:00:00Z"), now)).toBe("3 days ago");
  });

  it("falls back to ISO date for older-than-a-week", () => {
    expect(formatRelativeTime(new Date("2026-04-15T12:00:00Z"), now)).toBe("2026-04-15");
  });

  it("handles future timestamps without crashing", () => {
    // A future createdAt would be a stamping bug; the renderer should
    // still produce something rather than blow up.
    expect(formatRelativeTime(new Date("2026-06-01T13:00:00Z"), now)).toBe("in 1 hour");
  });
});

describe("handleLearned detail rendering", () => {
  const EVT = "019e2900-0000-7000-8000-0000000000aa";

  function makePayload(overrides: {
    outOfScope?: number;
    unknownRule?: number;
    durationMs?: number;
  }) {
    return {
      corrections: {
        extracted: 1,
        reinforced: 1,
        contradictions: 0,
        promoted: 0,
        outOfScopeReinforcementsSkipped: overrides.outOfScope ?? 0,
        unknownRuleReinforcementsSkipped: overrides.unknownRule ?? 0,
        consolidationNeeded: false,
      },
      consolidation: null,
      memories: { extracted: 0, byNetwork: {} },
      drained: { drained: 0, byNetwork: {} },
      messageCount: 8,
      profileId: "11111111-1111-7111-8111-111111111111",
      ...(overrides.durationMs !== undefined && { durationMs: overrides.durationMs }),
    };
  }

  it("surfaces skipped counters when non-zero", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ outOfScope: 3, unknownRule: 1 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toContain("skipped:      4");
    expect(reply).toContain("3 out-of-scope");
    expect(reply).toContain("1 unknown-rule");
  });

  it("omits the skipped line when both counters are zero", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({}),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).not.toContain("skipped:");
  });

  it("renders durationMs as a compact 'Took:' line when stamped", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({ durationMs: 32500 }),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).toMatch(/Took: 33s/);
  });

  it("omits the Took line when durationMs is absent", async () => {
    const transport = transportWith({
      evolution: {
        getEvent: vi.fn().mockResolvedValue(
          ok({
            id: EVT,
            conversationId: "c1",
            triggeredBy: "idle",
            payload: makePayload({}),
            createdAt: new Date("2026-05-30T08:00:00Z"),
          }),
        ),
      },
    });
    const ctx = mkCtx(EVT);
    await handleLearned(transport, ctx);
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
    expect(reply).not.toContain("Took:");
  });
});
