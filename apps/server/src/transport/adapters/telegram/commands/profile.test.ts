import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../../../../agent/store/index.js";
import { mkCtx, transportWith } from "../../../../test/telegram/command-fixtures.js";
import { ProfileDialogs } from "../profile-dialog.js";
import { handleProfile } from "./profile.js";

function mkDialogs(): ProfileDialogs {
  return new ProfileDialogs();
}

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

  it("names what to clear when the profile is still in use", async () => {
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
        delete: vi.fn().mockResolvedValue(err({ code: "profile_in_use" as const })),
      },
    });
    const ctx = mkCtx("delete temp");
    await handleProfile(transport, ctx, mkDialogs());
    const reply = String(ctx.reply.mock.calls[0]?.[0]);
    expect(reply).toContain("/profile switch");
    expect(reply).toContain("/disable");
    expect(reply).toContain("/schedules");
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
      // `trust` has a strict enum (first-party | any). Compartments are
      // validated at runtime against the user's `custom_compartments`,
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
    // in `errorMessage("identity_rejected")` (commands/reply.ts). The
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
    expect(reply).toBe("Profile not found. Use /profile list to see what's available.");
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
