import { describe, expect, it, vi } from "vitest";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import type { CoreMemoryScope } from "./scope.js";
import { type CoreMemoryWriteTarget, writeCoreMemoryBlock } from "./write-core-memory-block.js";

const UNCLASSED: CoreMemoryScope = { kind: "unclassed" };
const CLASSED: CoreMemoryScope = { kind: "classed", profileClass: "coder", restricted: false };
const RESTRICTED: CoreMemoryScope = { kind: "classed", profileClass: "game", restricted: true };

async function write(scope: CoreMemoryScope, key: string) {
  const agentStore = mockAgentStore();
  const result = await writeCoreMemoryBlock(
    { runInTx: fakeRunInTx, agentStore },
    { userId: "user-1", scope, key, content: "text" },
  );
  return { result, upsert: vi.mocked(agentStore.upsertCoreMemoryBlock) };
}

describe("writeCoreMemoryBlock", () => {
  it.each<[string, CoreMemoryScope, string, CoreMemoryWriteTarget, string | null]>([
    ["unclassed identity", UNCLASSED, "identity", { kind: "shared" }, null],
    ["unclassed other key", UNCLASSED, "user_profile", { kind: "unclassed" }, null],
    ["classed identity", CLASSED, "identity", { kind: "shared" }, null],
    [
      "classed other key",
      CLASSED,
      "user_profile",
      { kind: "class", profileClass: "coder" },
      "coder",
    ],
    [
      "restricted identity",
      RESTRICTED,
      "identity",
      { kind: "override", profileClass: "game" },
      "game",
    ],
    [
      "restricted other key",
      RESTRICTED,
      "preferences",
      { kind: "class", profileClass: "game" },
      "game",
    ],
  ])("%s lands in its scope", async (_name, scope, key, target, storedClass) => {
    const { result, upsert } = await write(scope, key);

    expect(result._unsafeUnwrap()).toEqual(target);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: storedClass,
      key,
      content: "text",
    });
  });

  it.each(["identity", "user_profile"])(
    "refuses a %s write in a turn without core memory, writing nothing",
    async (key) => {
      const { result, upsert } = await write({ kind: "none" }, key);

      expect(result._unsafeUnwrapErr()).toEqual({ code: "core_memory_unavailable" });
      expect(upsert).not.toHaveBeenCalled();
    },
  );

  it("matches the identity key exactly", async () => {
    const { result } = await write(RESTRICTED, "Identity");

    expect(result._unsafeUnwrap()).toEqual({ kind: "class", profileClass: "game" });
  });
});
