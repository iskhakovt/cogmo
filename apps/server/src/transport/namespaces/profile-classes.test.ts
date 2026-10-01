import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { mockAgentStore, mockTransportStore } from "../../test/factories.js";
import { createProfileClasses } from "./profile-classes.js";

const FAKE_TX = { __mockTx: true } as never;
const fakeRunInTx: Transactor = (cb) => cb(FAKE_TX);

function setup(overrides?: {
  transportStore?: ReturnType<typeof mockTransportStore>;
  agentStore?: ReturnType<typeof mockAgentStore>;
}) {
  const transportStore = overrides?.transportStore ?? mockTransportStore();
  const agentStore = overrides?.agentStore ?? mockAgentStore();
  const profileClasses = createProfileClasses({
    channelId: "ch-1",
    runInTx: fakeRunInTx,
    transportStore,
    agentStore,
  });
  return { profileClasses, transportStore, agentStore };
}

describe("profileClasses", () => {
  it("list returns identity_rejected when resolveUser returns null", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const { profileClasses } = setup({ transportStore });
    const res = await profileClasses.list("handle");
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
  });

  it("list scopes to the resolved userId", async () => {
    const listProfileClasses = vi.fn().mockResolvedValue([
      {
        id: "c-1",
        userId: "user-1",
        name: "intimate",
        description: "for emotional / relationship topics",
        restricted: false,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      },
    ]);
    const agentStore = mockAgentStore({ listProfileClasses });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.list("handle");
    expect(res._unsafeUnwrap()).toHaveLength(1);
    expect(listProfileClasses).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("create maps profile_class_name_taken through", async () => {
    const agentStore = mockAgentStore({
      createProfileClass: vi
        .fn()
        .mockResolvedValue(err({ kind: "profile_class_name_taken", name: "intimate" })),
    });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.create("handle", {
      name: "intimate",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_name_taken",
      name: "intimate",
    });
  });

  it("create maps invalid_name to profile_class_name_invalid", async () => {
    const agentStore = mockAgentStore({
      createProfileClass: vi
        .fn()
        .mockResolvedValue(
          err({ kind: "invalid_name", name: "Mixed Case", subject: "profile_class" }),
        ),
    });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.create("handle", {
      name: "Mixed Case",
      description: "x",
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_name_invalid",
      name: "Mixed Case",
    });
  });

  it("create happy path forwards name + description", async () => {
    const createProfileClass = vi.fn().mockResolvedValue(
      ok({
        id: "c-1",
        userId: "user-1",
        name: "intimate",
        description: "for emotional / relationship topics",
        restricted: false,
        createdAt: new Date("2026-04-16T12:00:00Z"),
      }),
    );
    const agentStore = mockAgentStore({ createProfileClass });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.create("handle", {
      name: "intimate",
      description: "for emotional / relationship topics",
    });
    expect(res._unsafeUnwrap().name).toBe("intimate");
    expect(createProfileClass).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      name: "intimate",
      description: "for emotional / relationship topics",
    });
  });

  it("delete returns profile_class_not_found when no row matches", async () => {
    const agentStore = mockAgentStore({
      deleteProfileClass: vi.fn().mockResolvedValue(ok({ deleted: false })),
    });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.delete("handle", "no-such", { confirm: false });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_not_found",
      name: "no-such",
    });
  });

  it("delete maps profile_class_in_use through with refCount", async () => {
    const agentStore = mockAgentStore({
      deleteProfileClass: vi
        .fn()
        .mockResolvedValue(err({ kind: "profile_class_in_use", profileRefs: 2 })),
    });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.delete("handle", "intimate", { confirm: false });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_class_in_use", profileRefs: 2 });
  });

  it("delete happy path returns ok with deleted:true", async () => {
    const deleteProfileClass = vi.fn().mockResolvedValue(ok({ deleted: true }));
    const agentStore = mockAgentStore({ deleteProfileClass });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.delete("handle", "intimate", { confirm: false });
    expect(res.isOk()).toBe(true);
    expect(deleteProfileClass).toHaveBeenCalledWith(expect.anything(), "user-1", "intimate");
  });

  it("delete lists the core-memory blocks it would delete and changes nothing unconfirmed", async () => {
    const deleteProfileClass = vi.fn().mockResolvedValue(ok({ deleted: true }));
    const agentStore = mockAgentStore({
      deleteProfileClass,
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["identity", "preferences"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.delete("handle", "game", { confirm: false });

    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_has_blocks",
      keys: ["identity", "preferences"],
    });
    expect(agentStore.listCoreMemoryKeys).toHaveBeenCalledWith(expect.anything(), "user-1", "game");
    expect(deleteProfileClass).not.toHaveBeenCalled();
  });

  it("delete reports a class in use before its blocks, since that call deletes nothing", async () => {
    const deleteProfileClass = vi.fn();
    const agentStore = mockAgentStore({
      deleteProfileClass,
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["preferences"]),
      listProfiles: vi.fn().mockResolvedValue([
        { id: "p-org", userId: null, profileClass: null },
        { id: "p-1", userId: "user-1", profileClass: "game" },
      ]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.delete("handle", "game", { confirm: false });

    expect(res._unsafeUnwrapErr()).toEqual({ code: "profile_class_in_use", profileRefs: 1 });
    expect(deleteProfileClass).not.toHaveBeenCalled();
  });

  it("delete with confirm deletes a class that has blocks", async () => {
    const deleteProfileClass = vi.fn().mockResolvedValue(ok({ deleted: true }));
    const agentStore = mockAgentStore({
      deleteProfileClass,
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["preferences"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.delete("handle", "game", { confirm: true });

    expect(res.isOk()).toBe(true);
    expect(deleteProfileClass).toHaveBeenCalledWith(expect.anything(), "user-1", "game");
  });

  it("setRestricted forwards (userId, name, restricted) and returns ok on success", async () => {
    const setProfileClassRestricted = vi.fn().mockResolvedValue({ updated: true });
    const agentStore = mockAgentStore({ setProfileClassRestricted });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.setRestricted("handle", "intimate", true, {
      confirm: false,
    });
    expect(res.isOk()).toBe(true);
    expect(setProfileClassRestricted).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "intimate",
      true,
    );
  });

  it("setRestricted returns profile_class_not_found when the row is absent", async () => {
    const agentStore = mockAgentStore({
      setProfileClassRestricted: vi.fn().mockResolvedValue({ updated: false }),
    });
    const { profileClasses } = setup({ agentStore });
    const res = await profileClasses.setRestricted("handle", "no-such", true, {
      confirm: false,
    });
    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_not_found",
      name: "no-such",
    });
  });

  it("setRestricted returns identity_rejected when resolveUser returns null", async () => {
    const transportStore = mockTransportStore({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const setProfileClassRestricted = vi.fn();
    const { profileClasses } = setup({
      transportStore,
      agentStore: mockAgentStore({ setProfileClassRestricted }),
    });
    const res = await profileClasses.setRestricted("handle", "intimate", true, {
      confirm: false,
    });
    expect(res._unsafeUnwrapErr()).toEqual({ code: "identity_rejected" });
    // Identity check fires before the store call — agent store stays untouched.
    expect(setProfileClassRestricted).not.toHaveBeenCalled();
  });

  it("unrestricting a class with an identity override names it and changes nothing unconfirmed", async () => {
    const setProfileClassRestricted = vi.fn().mockResolvedValue({ updated: true });
    const agentStore = mockAgentStore({
      setProfileClassRestricted,
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["identity", "preferences"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.setRestricted("handle", "game", false, {
      confirm: false,
    });

    expect(res._unsafeUnwrapErr()).toEqual({
      code: "profile_class_has_blocks",
      keys: ["identity"],
    });
    expect(setProfileClassRestricted).not.toHaveBeenCalled();
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });

  it("unrestricting with confirm clears the flag and deletes only the identity override", async () => {
    const setProfileClassRestricted = vi.fn().mockResolvedValue({ updated: true });
    const agentStore = mockAgentStore({
      setProfileClassRestricted,
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["identity", "preferences"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.setRestricted("handle", "game", false, {
      confirm: true,
    });

    expect(res._unsafeUnwrap()).toEqual({ overrideDeleted: true });
    expect(setProfileClassRestricted).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      "game",
      false,
    );
    expect(agentStore.deleteCoreMemoryBlock).toHaveBeenCalledTimes(1);
    expect(agentStore.deleteCoreMemoryBlock).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
    });
  });

  it("unrestricting a class without an override needs no confirmation", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["preferences"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.setRestricted("handle", "game", false, {
      confirm: false,
    });

    expect(res._unsafeUnwrap()).toEqual({ overrideDeleted: false });
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });

  it("restricting a class never deletes a block", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["identity"]),
    });
    const { profileClasses } = setup({ agentStore });

    const res = await profileClasses.setRestricted("handle", "game", true, {
      confirm: false,
    });

    expect(res.isOk()).toBe(true);
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });
});
