import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createChats } from "./chats.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const chats = createChats({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
  });
  return { chats, transportStore, agentStore };
}

describe("chats.setDefaultProfile", () => {
  it("returns identity_rejected when handle does not resolve", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { chats } = setup({ transportStore });
    const res = await chats.setDefaultProfile("ghost", "addr-1", "p1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("returns profile_not_found when the profile does not exist", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue(null),
    });
    const { chats } = setup({ agentStore });
    const res = await chats.setDefaultProfile("handle", "addr-1", "ghost-profile");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });

  it("rejects pinning another user's profile", async () => {
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-other" }),
    });
    const { chats } = setup({ agentStore });
    const res = await chats.setDefaultProfile("handle", "addr-1", "p-their");
    expect(res._unsafeUnwrapErr()).toMatchObject({
      code: "access_denied",
      reason: expect.stringContaining("not visible"),
    });
  });

  it("allows pinning an org profile (user_id = null)", async () => {
    const setChatDefaultProfile = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: null }),
    });
    const transportStore = mockTransportStore({ setChatDefaultProfile });
    const { chats } = setup({ transportStore, agentStore });
    const res = await chats.setDefaultProfile("handle", "addr-1", "p-org");
    expect(res.isOk()).toBe(true);
    expect(setChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), {
      channelId: "ch-1",
      platformAddress: "addr-1",
      profileId: "p-org",
    });
  });

  it("allows pinning the caller's own profile", async () => {
    const setChatDefaultProfile = vi.fn();
    const agentStore = mockAgentStore({
      getProfileOwner: vi.fn().mockResolvedValue({ userId: "user-1" }),
    });
    const transportStore = mockTransportStore({ setChatDefaultProfile });
    const { chats } = setup({ transportStore, agentStore });
    const res = await chats.setDefaultProfile("handle", "addr-1", "p-mine");
    expect(res.isOk()).toBe(true);
    expect(setChatDefaultProfile).toHaveBeenCalled();
  });
});

describe("chats.getDefaultProfile", () => {
  it("returns null when no default is pinned", async () => {
    const { chats } = setup();
    const res = await chats.getDefaultProfile("handle", "addr-1");
    expect(res._unsafeUnwrap()).toBeNull();
  });

  it("returns the bound profile's id and name when pinned", async () => {
    const transportStore = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "p-pinned" }),
    });
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue({
        id: "p-pinned",
        userId: "user-1",
        name: "doc-mode",
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
      }),
    });
    const { chats } = setup({ transportStore, agentStore });
    const res = await chats.getDefaultProfile("handle", "addr-1");
    expect(res._unsafeUnwrap()).toEqual({ profileId: "p-pinned", profileName: "doc-mode" });
  });

  it("returns profile_not_found when the bound row points at a missing profile", async () => {
    // Defensive: the FK cascade should sweep the binding when the profile
    // disappears, so seeing a row without a profile is an invariant break.
    // The implementation surfaces it as profile_not_found rather than
    // returning a half-populated record.
    const transportStore = mockTransportStore({
      getChatDefaultProfile: vi.fn().mockResolvedValue({ profileId: "p-ghost" }),
    });
    const agentStore = mockAgentStore({
      getProfile: vi.fn().mockResolvedValue(null),
    });
    const { chats } = setup({ transportStore, agentStore });
    const res = await chats.getDefaultProfile("handle", "addr-1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_not_found" });
  });
});

describe("chats.clearDefaultProfile", () => {
  it("delegates to transportStore.clearChatDefaultProfile", async () => {
    const clearChatDefaultProfile = vi.fn().mockResolvedValue(undefined);
    const transportStore = mockTransportStore({ clearChatDefaultProfile });
    const { chats } = setup({ transportStore });
    const res = await chats.clearDefaultProfile("handle", "addr-1");
    expect(res.isOk()).toBe(true);
    expect(clearChatDefaultProfile).toHaveBeenCalledWith(expect.anything(), "ch-1", "addr-1");
  });

  it("returns identity_rejected when handle does not resolve", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { chats } = setup({ transportStore });
    const res = await chats.clearDefaultProfile("ghost", "addr-1");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });
});
