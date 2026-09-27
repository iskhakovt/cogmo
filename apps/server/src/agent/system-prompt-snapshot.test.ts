import { describe, expect, it } from "vitest";
import type { Message } from "../llm/types.js";
import { canonicalKeyOrder } from "../util/canonical-key-order.js";
import type { CoreMemoryScope, CoreMemoryView } from "./core-memory/scope.js";
import {
  configDigest,
  continuesEpoch,
  coreMemoryToAnnounce,
  hasIdentityOverride,
  historyStart,
  stripThinkingBefore,
} from "./system-prompt-snapshot.js";

describe("configDigest", () => {
  const base = {
    configuration: "You are a coder.\n\n# Rules\n\n- Be kind",
    toolTable: '[{"name":"web_search"}]',
    scope: { kind: "classed", profileClass: "game", restricted: true } as CoreMemoryScope,
    identityOverride: false,
  };

  it("is stable for the same inputs", () => {
    expect(configDigest(base)).toBe(configDigest(structuredClone(base)));
  });

  it.each([
    ["the rendered configuration", { configuration: "You are a writer." }],
    ["the tool table", { toolTable: '[{"name":"fetch_url"}]' }],
    ["the profile class", { scope: { kind: "classed", profileClass: "work", restricted: true } }],
    [
      "the restricted flag",
      { scope: { kind: "classed", profileClass: "game", restricted: false } },
    ],
    ["whether the turn has core memory", { scope: { kind: "none" } }],
    ["whether a restricted class has its own identity", { identityOverride: true }],
  ] as const)("changes with %s", (_, change) => {
    expect(configDigest({ ...base, ...change })).not.toBe(configDigest(base));
  });

  it("ignores the key order of the scope, which a replayed step returns sorted", () => {
    const scope: CoreMemoryScope = { restricted: true, profileClass: "game", kind: "classed" };
    expect(configDigest({ ...base, scope })).toBe(
      configDigest({ ...base, scope: canonicalKeyOrder(scope) }),
    );
  });
});

describe("hasIdentityOverride", () => {
  const view = (scope: CoreMemoryScope, profileClass: string | null): CoreMemoryView => ({
    scope,
    blocks: [{ profileClass, key: "identity", content: "Name: Thorin" }],
  });

  it("is true only for a restricted class that sees its own identity", () => {
    const restricted = { kind: "classed", profileClass: "game", restricted: true } as const;
    expect(hasIdentityOverride(view(restricted, "game"))).toBe(true);
    expect(hasIdentityOverride(view(restricted, null))).toBe(false);
    expect(hasIdentityOverride(view({ ...restricted, restricted: false }, "game"))).toBe(false);
    expect(hasIdentityOverride(view({ kind: "unclassed" }, null))).toBe(false);
  });
});

describe("historyStart", () => {
  it("is the first message after the summary entry, or after a cutoff", () => {
    expect(historyStart([null, "m3", "m4", "m5"], null)).toBe("m3");
    expect(historyStart(["m1", "m2", "m3"], null)).toBe("m1");
    expect(historyStart([null, "m3", "m4", "m5"], "m4")).toBe("m5");
  });

  it("refuses a history with nothing after its start", () => {
    expect(() => historyStart([null], null)).toThrow();
    expect(() => historyStart(["m1", "m2"], "m2")).toThrow();
  });
});

describe("continuesEpoch", () => {
  const current = { configDigest: "d1", historyStart: "m1" };

  it("continues only a snapshot with the same digest and the same history start", () => {
    expect(continuesEpoch(current, current)).toBe(true);
    expect(continuesEpoch(null, current)).toBe(false);
    expect(continuesEpoch({ ...current, configDigest: "d0" }, current)).toBe(false);
    expect(continuesEpoch({ ...current, historyStart: "m0" }, current)).toBe(false);
  });
});

describe("stripThinkingBefore", () => {
  const thinking = { type: "thinking", thinking: "hmm", signature: "sig" } as const;
  const history: Message[] = [
    { role: "user", content: "first" },
    {
      role: "assistant",
      content: [thinking, { type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "found" }] },
    { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
    { role: "user", content: "second" },
    { role: "assistant", content: [thinking, { type: "text", text: "kept" }] },
  ];

  it("removes thinking blocks before the position and keeps text and tool calls", () => {
    const stripped = stripThinkingBefore(history, 4);

    expect(stripped.slice(0, 4)).toEqual([
      history[0],
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
      },
      history[2],
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
    expect(stripped.slice(4)).toEqual(history.slice(4));
  });

  it("leaves its input untouched", () => {
    const copy = structuredClone(history);
    stripThinkingBefore(history, history.length);
    expect(history).toEqual(copy);
  });
});

describe("coreMemoryToAnnounce", () => {
  const OPENED_AT = new Date("2026-09-27T10:00:00Z");
  const at = (minute: number) => new Date(OPENED_AT.getTime() + minute * 60_000);
  const view: CoreMemoryView = {
    scope: { kind: "classed", profileClass: "game", restricted: true },
    blocks: [
      { profileClass: null, key: "identity", content: "Name: Tim" },
      { profileClass: "game", key: "identity", content: "Name: Thorin" },
      { profileClass: "game", key: "preferences", content: "Dice" },
    ],
  };
  const updates = (times: Record<string, number>) =>
    view.blocks.map((b) => ({
      profileClass: b.profileClass,
      key: b.key,
      updatedAt: at(times[`${b.profileClass}/${b.key}`] ?? -60),
    }));
  const announce = (
    times: Record<string, number>,
    announcements: Array<{
      minute: number;
      blocks: Array<{ profileClass: string | null; key: string }>;
    }>,
  ) =>
    coreMemoryToAnnounce({
      view,
      updateTimes: updates(times),
      epochOpenedAt: OPENED_AT,
      announcements: announcements.map((a) => ({ createdAt: at(a.minute), blocks: a.blocks })),
    });

  it("announces nothing the snapshot already shows", () => {
    expect(announce({}, [])).toEqual({ scope: view.scope, blocks: [] });
  });

  it("announces a block changed since the snapshot, with its current content and scope", () => {
    expect(announce({ "game/identity": 5 }, [])).toEqual({
      scope: view.scope,
      blocks: [{ profileClass: "game", key: "identity", content: "Name: Thorin" }],
    });
  });

  it("announces a change once, and again after a later change", () => {
    const announced = [{ minute: 6, blocks: [{ profileClass: "game", key: "identity" }] }];
    expect(announce({ "game/identity": 5 }, announced).blocks).toEqual([]);
    expect(announce({ "game/identity": 7 }, announced).blocks.map((b) => b.key)).toEqual([
      "identity",
    ]);
  });

  it("tells the shared block from a class's block of the same key", () => {
    const announced = [{ minute: 6, blocks: [{ profileClass: null, key: "identity" }] }];
    expect(announce({ "game/identity": 5 }, announced).blocks).toEqual([
      { profileClass: "game", key: "identity", content: "Name: Thorin" },
    ]);
  });

  it("announces only blocks the turn sees", () => {
    const result = coreMemoryToAnnounce({
      view,
      updateTimes: [
        ...updates({}),
        { profileClass: null, key: "user_profile", updatedAt: at(5) },
        { profileClass: "work", key: "preferences", updatedAt: at(5) },
      ],
      epochOpenedAt: OPENED_AT,
      announcements: [],
    });
    expect(result.blocks).toEqual([]);
  });
});
