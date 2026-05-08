import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../agent/store/index.js";
import { mockTransport } from "../../../test/factories.js";
import type { Transport } from "../../transport.js";
import {
  formatScope,
  handleEnd,
  handleMcp,
  handleModel,
  handleName,
  handlePlanCallback,
  handleProfile,
  handleRepair,
  handleResume,
  handleResumeCallback,
  handleSessions,
  handleSkillsApprovalCallback,
  handleStatus,
  handleVoice,
  parseScopeSpec,
  splitScopeArgs,
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

  describe("scope subcommand", () => {
    function makeProfile(memoryScope: Profile["memoryScope"] = null): Profile {
      return {
        id: "p1",
        userId: "u",
        name: "personal",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        toolSet: [],
        memoryScope,
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
      const set = { compartments: ["work", "technical"] as const, trust: ["first-party"] as const };
      const update = vi.fn().mockResolvedValue(ok(makeProfile({ ...set })));
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
      const update = vi.fn();
      const transport = transportWith({
        profiles: {
          list: vi.fn().mockResolvedValue(ok([makeProfile(null)])),
          create: vi.fn().mockResolvedValue(ok({} as never)),
          update,
          delete: vi.fn().mockResolvedValue(ok(undefined)),
        },
      });
      const ctx = mkCtx("scope personal compartments=bogus trust=first-party");
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

  it("rejects unknown enum value", () => {
    const r = parseScopeSpec(["compartments=bogus", "trust=first-party"]);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("Invalid scope");
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

  it("rejects case-mismatched enum values (operators most likely typo)", () => {
    const r = parseScopeSpec(["compartments=WORK", "trust=first-party"]);
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

describe("formatScope", () => {
  it("null → 'unrestricted (recalls all memories)'", () => {
    expect(formatScope(null)).toBe("unrestricted (recalls all memories)");
  });

  it("set scope renders compartments + trust", () => {
    expect(formatScope({ compartments: ["work", "technical"], trust: ["first-party"] })).toBe(
      "compartments: work, technical / trust: first-party",
    );
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
    const repair = vi.fn().mockResolvedValue(ok({ wasErrored: true }));
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

  it("replies 'already active' when wasErrored: false", async () => {
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
        repair: vi.fn().mockResolvedValue(ok({ wasErrored: false })),
      },
    });
    const ctx = mkCtx();
    await handleRepair(transport, ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringMatching(/already active/));
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
    const repair = vi.fn().mockResolvedValue(ok({ wasErrored: true }));
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
    const repair = vi.fn().mockResolvedValue(ok({ wasErrored: true }));
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
        repair: vi.fn().mockResolvedValue(ok({ wasErrored: false })),
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
      setVoiceMode?: ReturnType<typeof vi.fn>;
      voiceMode?: "auto" | "always" | "never" | null;
      profileVoiceMode?: "auto" | "always" | "never";
      noSession?: boolean;
    } = {},
  ) {
    return mockTransport({
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
        list: vi.fn().mockResolvedValue(ok([])),
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
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair: vi.fn().mockResolvedValue(ok({ wasErrored: false })),
        setVoiceMode: overrides.setVoiceMode ?? vi.fn().mockResolvedValue(ok(undefined)),
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
    return mockTransport({
      conversations: {
        list: vi.fn().mockResolvedValue(ok([])),
        getCurrent: vi.fn().mockResolvedValue(ok(null)),
        summary: vi.fn().mockResolvedValue(value),
        setAlias: vi.fn().mockResolvedValue(ok(undefined)),
        setProfile: vi.fn().mockResolvedValue(ok(undefined)),
        repair: vi.fn().mockResolvedValue(ok({ wasErrored: false })),
        setVoiceMode: vi.fn().mockResolvedValue(ok(undefined)),
      },
    } as Partial<Transport>);
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
        status: "active",
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
    const reply = (ctx.reply.mock.calls[0]?.[0] ?? "") as string;
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
});
