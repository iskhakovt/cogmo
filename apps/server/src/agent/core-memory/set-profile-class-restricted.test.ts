import { describe, expect, it, vi } from "vitest";
import { mockAgentStore } from "../../test/factories.js";
import { IDENTITY_BLOCK_KEY } from "./scope.js";
import { setProfileClassRestricted } from "./set-profile-class-restricted.js";

const FAKE_TX = { __mockTx: true } as never;

function store(keys: ReadonlyArray<string>, updated = true) {
  return mockAgentStore({
    listCoreMemoryKeys: vi.fn().mockResolvedValue(keys),
    setProfileClassRestricted: vi.fn().mockResolvedValue({ updated }),
    deleteCoreMemoryBlock: vi.fn().mockResolvedValue(undefined),
  });
}

describe("setProfileClassRestricted", () => {
  it("restricting never reads or deletes blocks", async () => {
    const agentStore = store([IDENTITY_BLOCK_KEY]);

    const res = await setProfileClassRestricted(FAKE_TX, agentStore, {
      userId: "user-1",
      name: "game",
      restricted: true,
      confirm: false,
    });

    expect(res._unsafeUnwrap()).toEqual({ overrideDeleted: false });
    expect(agentStore.listCoreMemoryKeys).not.toHaveBeenCalled();
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed unrestrict that would delete the identity override", async () => {
    const agentStore = store([IDENTITY_BLOCK_KEY, "preferences"]);

    const res = await setProfileClassRestricted(FAKE_TX, agentStore, {
      userId: "user-1",
      name: "game",
      restricted: false,
      confirm: false,
    });

    expect(res._unsafeUnwrapErr()).toEqual({ kind: "has_blocks", keys: [IDENTITY_BLOCK_KEY] });
    expect(agentStore.setProfileClassRestricted).not.toHaveBeenCalled();
  });

  it("a confirmed unrestrict clears the flag and deletes only the identity override", async () => {
    const agentStore = store([IDENTITY_BLOCK_KEY, "preferences"]);

    const res = await setProfileClassRestricted(FAKE_TX, agentStore, {
      userId: "user-1",
      name: "game",
      restricted: false,
      confirm: true,
    });

    expect(res._unsafeUnwrap()).toEqual({ overrideDeleted: true });
    expect(agentStore.setProfileClassRestricted).toHaveBeenCalledWith(
      FAKE_TX,
      "user-1",
      "game",
      false,
    );
    expect(agentStore.deleteCoreMemoryBlock).toHaveBeenCalledTimes(1);
    expect(agentStore.deleteCoreMemoryBlock).toHaveBeenCalledWith(FAKE_TX, {
      userId: "user-1",
      profileClass: "game",
      key: IDENTITY_BLOCK_KEY,
    });
  });

  it("unrestricting a class without an override needs no confirmation", async () => {
    const agentStore = store(["preferences"]);

    const res = await setProfileClassRestricted(FAKE_TX, agentStore, {
      userId: "user-1",
      name: "game",
      restricted: false,
      confirm: false,
    });

    expect(res._unsafeUnwrap()).toEqual({ overrideDeleted: false });
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });

  it("reports not_found and deletes nothing when no class matched", async () => {
    const agentStore = store([IDENTITY_BLOCK_KEY], false);

    const res = await setProfileClassRestricted(FAKE_TX, agentStore, {
      userId: "user-1",
      name: "ghost",
      restricted: false,
      confirm: true,
    });

    expect(res._unsafeUnwrapErr()).toEqual({ kind: "not_found" });
    expect(agentStore.deleteCoreMemoryBlock).not.toHaveBeenCalled();
  });
});
