import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { expectDefined } from "../../../../test/assertions.js";
import type { Transport } from "../../../transport.js";
import { handleCompact, handleRepair, handleStatus, handleVoice } from "./conversation.js";
import { mkCtx, transportWith } from "./test-fixtures.js";

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

describe("handleCompact", () => {
  function compactWith(value: unknown) {
    return transportWith({ conversations: { compact: vi.fn().mockResolvedValue(value) } });
  }

  it("acknowledges before the summarization round trip, then reports the result", async () => {
    const transport = compactWith(
      ok({
        status: "compacted",
        messagesSummarized: 24,
        messagesKept: 6,
        model: "claude-haiku-4-5",
      }),
    );
    const ctx = mkCtx();
    await handleCompact(transport, ctx);

    expect(ctx.reply.mock.calls[0]?.[0]).toMatch(/Compacting/);
    const result = (ctx.reply.mock.calls[1]?.[0] ?? "") as string;
    expect(result).toContain("24 message(s)");
    expect(result).toContain("6 kept verbatim");
    expect(result).toContain("claude-haiku-4-5");
  });

  it("reports too little outside the retained window without claiming token safety", async () => {
    // `too_short` counts messages, not tokens — it says nothing about whether
    // the conversation fits in the context window, so the reply must not either.
    const ctx = mkCtx();
    await handleCompact(compactWith(ok({ status: "skipped", reason: "too_short" })), ctx);
    const reply = expectDefined(ctx.reply.mock.calls[1], "second reply")[0];
    expect(reply).toMatch(/outside the retained window/i);
    expect(reply).not.toMatch(/fits/i);
  });

  it("reports that a turn already stored a summary for the span", async () => {
    const ctx = mkCtx();
    await handleCompact(compactWith(ok({ status: "skipped", reason: "nothing_new" })), ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/already compacted/i);
  });

  it("says nothing was stored when the model returned no text", async () => {
    const ctx = mkCtx();
    await handleCompact(compactWith(ok({ status: "skipped", reason: "empty_summary" })), ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/nothing stored/i);
  });

  it("says a capped summary was not stored and that re-running won't help", async () => {
    // The one skip reason that is a dead end rather than a retry: the prefix is
    // unchanged and the output cap is fixed, so the reply must not imply
    // otherwise. Both claims it makes are behavioural.
    const ctx = mkCtx();
    await handleCompact(compactWith(ok({ status: "skipped", reason: "truncated" })), ctx);
    const reply = expectDefined(ctx.reply.mock.calls[1], "second reply")[0];
    expect(reply).toMatch(/nothing was stored/i);
    expect(reply).toMatch(/won't help/i);
    expect(reply).not.toMatch(/try again/i);
  });

  it("reports no-session when there's no active conversation", async () => {
    const ctx = mkCtx();
    await handleCompact(compactWith(ok({ status: "no_session" })), ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/No active conversation/i);
  });

  it("renders a transport error rather than throwing", async () => {
    const ctx = mkCtx();
    await handleCompact(compactWith(err({ code: "compaction_unavailable" })), ctx);
    expect(ctx.reply.mock.calls[1]?.[0]).toMatch(/isn't wired/i);
  });

  it("surfaces the reason when compaction failed", async () => {
    const ctx = mkCtx();
    await handleCompact(
      compactWith(err({ code: "compaction_failed", reason: "429 rate limited" })),
      ctx,
    );
    expect(ctx.reply.mock.calls[1]?.[0]).toContain("429 rate limited");
  });

  it("points at the log when the reason is withheld", async () => {
    // `null` is what the transport substitutes for any error whose message
    // isn't on the allowlist — the user gets a pointer, not a redaction marker.
    const ctx = mkCtx();
    await handleCompact(compactWith(err({ code: "compaction_failed", reason: null })), ctx);
    const reply = expectDefined(ctx.reply.mock.calls[1], "second reply")[0];
    expect(reply).toMatch(/server log/i);
    expect(reply).not.toMatch(/null/i);
  });
});
