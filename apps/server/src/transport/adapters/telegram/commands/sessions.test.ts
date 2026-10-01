import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../../agent/store/index.js";
import {
  handleEnd,
  handleName,
  handleNew,
  handleResume,
  handleResumeCallback,
  handleSessions,
} from "./sessions.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

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
