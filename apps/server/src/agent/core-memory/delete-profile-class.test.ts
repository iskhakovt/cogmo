import { err, ok } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import { mockAgentStore } from "../../test/factories.js";
import { deleteProfileClass } from "./delete-profile-class.js";

const FAKE_TX = { __mockTx: true } as never;
const ARGS = { userId: "user-1", name: "game", confirm: false };

describe("deleteProfileClass", () => {
  it("deletes a class with no blocks without asking for confirmation", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue([]),
      deleteProfileClass: vi.fn().mockResolvedValue(ok({ deleted: true })),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, ARGS);

    expect(res.isOk()).toBe(true);
    expect(agentStore.deleteProfileClass).toHaveBeenCalledWith(FAKE_TX, "user-1", "game");
  });

  it("refuses an unconfirmed delete of a class with blocks, naming them", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["identity", "preferences"]),
      listProfiles: vi.fn().mockResolvedValue([]),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, ARGS);

    expect(res._unsafeUnwrapErr()).toEqual({
      kind: "has_blocks",
      keys: ["identity", "preferences"],
    });
    expect(agentStore.deleteProfileClass).not.toHaveBeenCalled();
  });

  it("reports the class in use before its blocks, counting only the user's own profiles", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["preferences"]),
      listProfiles: vi.fn().mockResolvedValue([
        { id: "p-org", userId: null, profileClass: "game" },
        { id: "p-1", userId: "user-1", profileClass: "game" },
        { id: "p-2", userId: "user-1", profileClass: "work" },
      ]),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, ARGS);

    expect(res._unsafeUnwrapErr()).toEqual({ kind: "in_use", profileRefs: 1 });
    expect(agentStore.deleteProfileClass).not.toHaveBeenCalled();
  });

  it("deletes a class with blocks once confirmed", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue(["preferences"]),
      deleteProfileClass: vi.fn().mockResolvedValue(ok({ deleted: true })),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, { ...ARGS, confirm: true });

    expect(res.isOk()).toBe(true);
    expect(agentStore.listProfiles).not.toHaveBeenCalled();
  });

  it("passes the store's in-use refusal through", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue([]),
      deleteProfileClass: vi
        .fn()
        .mockResolvedValue(err({ kind: "profile_class_in_use", profileRefs: 2 })),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, ARGS);

    expect(res._unsafeUnwrapErr()).toEqual({ kind: "in_use", profileRefs: 2 });
  });

  it("reports not_found when no class matched", async () => {
    const agentStore = mockAgentStore({
      listCoreMemoryKeys: vi.fn().mockResolvedValue([]),
      deleteProfileClass: vi.fn().mockResolvedValue(ok({ deleted: false })),
    });

    const res = await deleteProfileClass(FAKE_TX, agentStore, ARGS);

    expect(res._unsafeUnwrapErr()).toEqual({ kind: "not_found" });
  });
});
