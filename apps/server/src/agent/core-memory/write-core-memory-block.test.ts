import { describe, expect, it, vi } from "vitest";
import type { Transactor } from "../../db/index.js";
import { fakeRunInTx, mockAgentStore } from "../../test/factories.js";
import type { CoreMemoryScope, ScopedCoreMemoryBlock } from "./scope.js";
import { type CoreMemoryWrite, writeCoreMemoryBlock } from "./write-core-memory-block.js";

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
  it.each<[string, CoreMemoryScope, string, CoreMemoryWrite, string | null]>([
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
      { kind: "override", profileClass: "game", leftOut: [] },
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

describe("writeCoreMemoryBlock: a restricted class's identity override", () => {
  const SHARED = "Name: Samuel Carter\nLocation: London, UK (Europe/London)\nLanguages: English";

  function shared(content: string): ScopedCoreMemoryBlock {
    return { profileClass: null, key: "identity", content };
  }

  async function writeOverride(content: string, rows: ReadonlyArray<ScopedCoreMemoryBlock>) {
    const agentStore = mockAgentStore({ getCoreMemoryBlocks: vi.fn().mockResolvedValue(rows) });
    let transactions = 0;
    const runInTx: Transactor = (cb) => {
      transactions += 1;
      return fakeRunInTx(cb);
    };
    const result = await writeCoreMemoryBlock(
      { runInTx, agentStore },
      { userId: "user-1", scope: RESTRICTED, key: "identity", content },
    );
    const upsert = vi.mocked(agentStore.upsertCoreMemoryBlock);
    return {
      result: result._unsafeUnwrap(),
      transactions,
      read: vi.mocked(agentStore.getCoreMemoryBlocks),
      upsert,
      /** The content of every upsert, in call order. */
      stored: upsert.mock.calls.map(([, params]) => params.content),
      remove: vi.mocked(agentStore.deleteCoreMemoryBlock),
    };
  }

  it("leaves out the lines the shared block holds, in the write's transaction", async () => {
    const { result, transactions, read, upsert, stored } = await writeOverride(
      "Name: Samuel Carter\nLocation: Lisbon, Portugal (Europe/Lisbon)\nLanguages: English",
      [shared(SHARED)],
    );

    expect(stored).toEqual(["Location: Lisbon, Portugal (Europe/Lisbon)"]);
    expect(upsert).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
      content: "Location: Lisbon, Portugal (Europe/Lisbon)",
    });
    expect(result).toEqual({
      kind: "override",
      profileClass: "game",
      leftOut: ["Name: Samuel Carter", "Languages: English"],
    });
    expect(read).toHaveBeenCalledWith(expect.anything(), "user-1", "game");
    expect(transactions).toBe(1);
  });

  it("counts lines differing only in surrounding or repeated whitespace as the same", async () => {
    const { result, stored } = await writeOverride("  Name:   Samuel\tCarter  \nLocation: Lisbon", [
      shared(SHARED),
    ]);

    expect(stored).toEqual(["Location: Lisbon"]);
    expect(result).toMatchObject({ leftOut: ["Name: Samuel Carter"] });
  });

  it("keeps a line that differs in anything but whitespace", async () => {
    const content = "name: Samuel Carter\nName: Samuel Carter (goes by Sam)\n- Languages: English";
    const { stored } = await writeOverride(content, [shared(SHARED)]);

    expect(stored).toEqual([content]);
  });

  it("keeps the differing lines in order with their blank lines, trimming blank edges", async () => {
    const { stored } = await writeOverride(
      "Name: Samuel Carter\n\nCall him: Sam\n\nLocation: Lisbon\nLanguages: English\n",
      [shared(`${SHARED}\n\n`)],
    );

    expect(stored).toEqual(["Call him: Sam\n\nLocation: Lisbon"]);
  });

  it("never counts a blank line as shared", async () => {
    const content = "Call him: Sam\n\n   \nLocation: Lisbon";
    const { result, stored } = await writeOverride(content, [
      shared("Name: Samuel Carter\n\n   \n"),
    ]);

    expect(stored).toEqual([content]);
    expect(result).toMatchObject({ leftOut: [] });
  });

  it("compares with the shared block, not the class's current override", async () => {
    const { stored } = await writeOverride("Name: Samuel Carter\nCall him: Sam\nLocation: Lisbon", [
      shared(SHARED),
      { profileClass: "game", key: "identity", content: "Call him: Sam" },
    ]);

    expect(stored).toEqual(["Call him: Sam\nLocation: Lisbon"]);
  });

  it("stores nothing and deletes the override when every line is shared", async () => {
    const { result, stored, remove, transactions } = await writeOverride(
      "Location: London, UK (Europe/London)\n\nName: Samuel Carter\n",
      [shared(SHARED), { profileClass: "game", key: "identity", content: "Location: Lisbon" }],
    );

    expect(result).toEqual({ kind: "override-matches-shared", profileClass: "game" });
    expect(stored).toEqual([]);
    expect(remove).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
    });
    expect(transactions).toBe(1);
  });

  it("lists a left-out line once, however often the override repeats it", async () => {
    const { result, stored } = await writeOverride(
      "Name: Samuel Carter\nLocation: Lisbon\nName:  Samuel Carter",
      [shared(SHARED)],
    );

    expect(stored).toEqual(["Location: Lisbon"]);
    expect(result).toMatchObject({ leftOut: ["Name: Samuel Carter"] });
  });

  it.each<[string, ReadonlyArray<ScopedCoreMemoryBlock>]>([
    ["with a shared identity", [shared(SHARED)]],
    ["without a shared identity", []],
  ])("stores nothing and deletes the override for a blank write %s", async (_name, rows) => {
    const { result, stored, remove } = await writeOverride("  \n\n\t\n", rows);

    expect(result).toEqual({ kind: "override-matches-shared", profileClass: "game" });
    expect(stored).toEqual([]);
    expect(remove).toHaveBeenCalledWith(expect.anything(), {
      userId: "user-1",
      profileClass: "game",
      key: "identity",
    });
  });

  it("stores every line when there is no shared identity, trimming blank edges", async () => {
    const { result, stored, remove } = await writeOverride(
      "\nName: Samuel Carter\nLocation: Lisbon\n",
      [{ profileClass: "game", key: "preferences", content: "Name: Samuel Carter" }],
    );

    expect(stored).toEqual(["Name: Samuel Carter\nLocation: Lisbon"]);
    expect(result).toEqual({ kind: "override", profileClass: "game", leftOut: [] });
    expect(remove).not.toHaveBeenCalled();
  });

  it("stores the override as written when only the class's own identity exists", async () => {
    const content = "Name: Samuel Carter\nLocation: Lisbon";
    const { stored } = await writeOverride(content, [
      { profileClass: "game", key: "identity", content: "Name: Samuel Carter" },
    ]);

    expect(stored).toEqual([content]);
  });
});
