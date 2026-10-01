import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createProfiles } from "./profiles.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

// Every `inngest.send` call whose payload carries `eventName`. Returning all
// matches lets a test assert the event fired exactly once.
function inngestSendCallsForEvent(calls: unknown[][], eventName: string): unknown[][] {
  return calls.filter((c) => {
    const payload = c[0];
    return (
      typeof payload === "object" &&
      payload !== null &&
      "name" in payload &&
      payload.name === eventName
    );
  });
}

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const inngestSend = vi.fn().mockResolvedValue(undefined);
  const inngest = { send: inngestSend } as any;
  const profiles = createProfiles({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
    inngest,
  });
  return { profiles, transportStore, agentStore, inngestSend };
}

describe("profiles.update", () => {
  it("rejects org-profile mutation with access_denied", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p-org", { name: "mine" });
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("org profiles"),
    });
  });

  it("rejects another user's profile with access_denied", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p-theirs", { name: "new" });
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
  });

  it("validates model against user_selectable and returns model_unavailable", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      isModelUserSelectable: vi.fn().mockResolvedValue(false),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p-mine", { model: "experimental-1" });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "model_unavailable",
      model: "experimental-1",
    });
  });

  it("maps profile_name_taken through", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      updateProfile: vi.fn().mockResolvedValue(err({ kind: "profile_name_taken" })),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p-mine", { name: "taken" });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
  });

  it("forwards memoryScope=null (clear) to agentStore.updateProfile verbatim", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      updateProfile,
    });
    const { profiles } = setup({ agentStore });
    await profiles.update("handle", "p-mine", { memoryScope: null });
    expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p-mine", {
      memoryScope: null,
    });
  });

  it("forwards a non-null memoryScope to agentStore.updateProfile verbatim", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      updateProfile,
    });
    const { profiles } = setup({ agentStore });
    const memoryScope = {
      compartments: ["work" as const, "technical" as const],
      trust: ["first-party" as const],
    };
    await profiles.update("handle", "p-mine", { memoryScope });
    expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p-mine", { memoryScope });
  });

  // Auto-repair clear trigger — `/model` passes
  // `clearCooldownForConversation: currentConversationId` so the model
  // update and the cooldown clear land in the same tx. Verifies the
  // clear fires and ownership is checked against the conversation
  // before the profile update commits.
  it("clearCooldownForConversation: calls clearCooldown in the same tx as the model update", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-mine",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
      updateProfile,
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c1" },
    );
    expect(res.isOk()).toBe(true);
    expect(updateProfile).toHaveBeenCalled();
    expect(clearCooldown).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  // Without the opt, no cooldown clear — verifies the option is
  // opt-in (other update callers like `/profile edit` shouldn't
  // touch cooldown).
  it("clearCooldownForConversation absent: does NOT call clearCooldown", async () => {
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    await profiles.update("handle", "p-mine", { model: "gpt-4o" });
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  // Ownership check on the conversation runs BEFORE the profile
  // update commits — so a wrong conversationId aborts the whole
  // update rather than silently dropping the cooldown-clear side
  // effect.
  it("clearCooldownForConversation: returns access_denied when conversation isn't owned by caller", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c-other",
        userId: "user-2",
        profileId: "p-other",
        isPrivate: true,
        cooldownState: null,
      }),
      updateProfile,
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c-other" },
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("conversation"),
    });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  it("clearCooldownForConversation: returns conversation_not_found when conv row is missing", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue(undefined),
      updateProfile,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c-gone" },
    );
    expect(res._unsafeUnwrapErr()).toEqual({ code: "conversation_not_found" });
    expect(updateProfile).not.toHaveBeenCalled();
  });

  // The clear's rationale is "the model the failing turn used
  // changed." If the conversation doesn't actually use this profile,
  // the new model isn't its model and the clear would be spurious.
  // Reject so the caller surfaces a bug rather than silently
  // clearing cooldown on an unrelated conversation.
  it("clearCooldownForConversation: returns access_denied when conversation uses a different profile", async () => {
    const updateProfile = vi.fn().mockResolvedValue(ok({}));
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c-elsewhere",
        userId: "user-1",
        profileId: "p-other",
        isPrivate: true,
        cooldownState: null,
      }),
      updateProfile,
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c-elsewhere" },
    );
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("does not use this profile"),
    });
    expect(updateProfile).not.toHaveBeenCalled();
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  // Mirror setProfile's optimization — skip the UPDATE when there's
  // nothing to clear. Without this, every `/model` against a
  // not-currently-cooling-down conversation would write a no-op
  // row version on `conversations`.
  // `clearCooldown` must NOT fire on the name-taken path, even though
  // `clearCooldownForConversation` was passed and the conversation was
  // cooling down.
  it("profile_name_taken returns before clearCooldown", async () => {
    const updateProfile = vi.fn().mockResolvedValue(err({ kind: "profile_name_taken" }));
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-mine",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
      updateProfile,
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { name: "taken" },
      { clearCooldownForConversation: "c1" },
    );
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  it("clearCooldownForConversation: skips the clear write when cooldown_state was already NULL", async () => {
    const clearCooldown = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-mine",
        isPrivate: true,
        cooldownState: null,
      }),
      clearCooldown,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { model: "gpt-4o" },
      { clearCooldownForConversation: "c1" },
    );
    expect(res.isOk()).toBe(true);
    expect(clearCooldown).not.toHaveBeenCalled();
  });

  it("emits cleared with clearedBy=model_switch when a clear happens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-19T11:00:00.000Z"));
    try {
      const agentStore = mockAgentStore({
        getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
        getConversation: vi.fn().mockResolvedValue({
          id: "c1",
          userId: "user-1",
          profileId: "p-mine",
          isPrivate: true,
          cooldownState: {
            lastErroredAt: "2026-05-19T11:00:00.000Z",
            cooldownSeconds: 60,
            consecutiveFailures: 1,
          },
        }),
      });
      const { profiles, inngestSend } = setup({ agentStore });
      await profiles.update(
        "handle",
        "p-mine",
        { model: "gpt-4o" },
        { clearCooldownForConversation: "c1" },
      );
      const clearedCalls = inngestSendCallsForEvent(
        inngestSend.mock.calls,
        "conversation/cooldown/cleared",
      );
      expect(clearedCalls).toHaveLength(1);
      expect(clearedCalls[0]?.[0]).toMatchObject({
        name: "conversation/cooldown/cleared",
        id: "cooldown-cleared-c1-2026-05-19T11:00:00.000Z",
        // now === lastErroredAt → elapsed is exactly 0
        data: {
          conversationId: "c1",
          clearedBy: "model_switch",
          elapsedCooldownSeconds: 0,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Name-taken path: no clear happened. The post-tx emit must NOT fire
  // even though priorCooldownStateForEmit was captured inside the cb.
  it("does NOT emit cleared when updateProfile fails", async () => {
    const updateProfile = vi.fn().mockResolvedValue(err({ kind: "profile_name_taken" }));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      getConversation: vi.fn().mockResolvedValue({
        id: "c1",
        userId: "user-1",
        profileId: "p-mine",
        isPrivate: true,
        cooldownState: {
          lastErroredAt: "2026-05-19T11:00:00.000Z",
          cooldownSeconds: 60,
          consecutiveFailures: 1,
        },
      }),
      updateProfile,
    });
    const { profiles, inngestSend } = setup({ agentStore });
    const res = await profiles.update(
      "handle",
      "p-mine",
      { name: "taken" },
      { clearCooldownForConversation: "c1" },
    );
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_name_taken" });
    expect(
      inngestSendCallsForEvent(inngestSend.mock.calls, "conversation/cooldown/cleared"),
    ).toHaveLength(0);
  });
});

describe("profiles.delete", () => {
  it("returns profile_in_use when deleteProfile finds references (atomic check)", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      deleteProfile: vi.fn().mockResolvedValue(err({ kind: "profile_in_use" })),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.delete("handle", "p-mine");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_in_use" });
  });

  it("rejects deleting an org profile with access_denied", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.delete("handle", "p-org");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("org profiles"),
    });
  });
});

describe("profiles.create", () => {
  it("validates model and returns model_unavailable", async () => {
    const agentStore = mockAgentStore({
      isModelUserSelectable: vi.fn().mockResolvedValue(false),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.create("handle", {
      name: "new",
      basePrompt: "p",
      model: "experimental-1",
      toolSet: [],
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "model_unavailable",
      model: "experimental-1",
    });
  });

  it("forwards memoryScope to agentStore.createProfile when present", async () => {
    const createProfile = vi.fn().mockResolvedValue(ok({}));
    const agentStore = mockAgentStore({ createProfile });
    const { profiles } = setup({ agentStore });
    const memoryScope = {
      compartments: ["work" as const, "technical" as const],
      trust: ["first-party" as const],
    };
    await profiles.create("handle", {
      name: "coder",
      basePrompt: "p",
      model: "claude-sonnet-4-6",
      toolSet: [],
      memoryScope,
    });
    expect(createProfile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memoryScope }),
    );
  });

  it("omits memoryScope from createProfile params when not supplied (store applies its own default)", async () => {
    // The store's `memoryScope` column defaults to null at the DB level. The
    // transport must not coerce undefined → null on the way through, because
    // future store-level defaults (e.g. inheriting from the org profile)
    // must not be silently overwritten by an explicit null.
    const createProfile = vi.fn().mockResolvedValue(ok({}));
    const agentStore = mockAgentStore({ createProfile });
    const { profiles } = setup({ agentStore });
    await profiles.create("handle", {
      name: "open",
      basePrompt: "p",
      model: "claude-sonnet-4-6",
      toolSet: [],
    });
    const args = createProfile.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("memoryScope" in args).toBe(false);
  });
});

describe("profiles.setClass", () => {
  it("rejects org-profile classing with access_denied", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-org", "intimate");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("org profiles"),
    });
  });

  it("rejects another user's profile with access_denied", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-2" }),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-theirs", "intimate");
    expect(res._unsafeUnwrapErr()).toMatchObject({ code: "access_denied" });
  });

  it("returns identity_rejected when resolveUser returns null", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { profiles } = setup({ transportStore });
    const res = await profiles.setClass("handle", "p-1", "intimate");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns profile_not_found when getProfileOwner returns undefined", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue(undefined),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-missing", "intimate");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });

  it("maps unknown_profile_class through with the offending name", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      setProfileClass: vi
        .fn()
        .mockResolvedValue(err({ kind: "unknown_profile_class", name: "nope" })),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-mine", "nope");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "unknown_profile_class", name: "nope" });
  });

  it("forwards className=null (clear) to agentStore.setProfileClass verbatim", async () => {
    const setProfileClass = vi.fn().mockResolvedValue(ok(undefined));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      setProfileClass,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-mine", null);
    expect(res.isOk()).toBe(true);
    expect(setProfileClass).toHaveBeenCalledWith(expect.anything(), "p-mine", null);
  });

  it("happy path forwards a non-null className", async () => {
    const setProfileClass = vi.fn().mockResolvedValue(ok(undefined));
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      setProfileClass,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.setClass("handle", "p-mine", "intimate");
    expect(res.isOk()).toBe(true);
    expect(setProfileClass).toHaveBeenCalledWith(expect.anything(), "p-mine", "intimate");
  });
});

describe("profiles.update memoryScope validation", () => {
  it("rejects an unknown compartment value with compartment_unknown", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      listCustomCompartments: vi.fn().mockResolvedValue([
        {
          id: "cc-1",
          userId: "user-1",
          name: "dnd",
          description: "x",
          createdAt: new Date(),
        },
      ]),
      updateProfile: vi.fn(),
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p1", {
      memoryScope: { compartments: ["work", "music"], trust: ["first-party"] },
    });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "compartment_unknown", name: "music" });
    expect(agentStore.updateProfile).not.toHaveBeenCalled();
  });

  it("accepts core + custom compartment values", async () => {
    const updateProfile = vi.fn().mockResolvedValue(
      ok({
        id: "p1",
        userId: "user-1",
        name: "test",
        basePrompt: "",
        model: "claude-sonnet-4-6",
        summarizationModel: null,
        extractionModel: null,
        autoRecall: "heuristic",
        voiceMode: "auto",
        toolSet: [],
        memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
        profileClass: null,
        streamChunkChars: 4000,
        streamEdits: true,
        codingAutoapproveMode: "off",
      }),
    );
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
      listCustomCompartments: vi.fn().mockResolvedValue([
        {
          id: "cc-1",
          userId: "user-1",
          name: "dnd",
          description: "x",
          createdAt: new Date(),
        },
      ]),
      updateProfile,
    });
    const { profiles } = setup({ agentStore });
    const res = await profiles.update("handle", "p1", {
      memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
    });
    expect(res.isOk()).toBe(true);
    expect(updateProfile).toHaveBeenCalledWith(expect.anything(), "p1", {
      memoryScope: { compartments: ["work", "dnd"], trust: ["first-party"] },
    });
  });
});
