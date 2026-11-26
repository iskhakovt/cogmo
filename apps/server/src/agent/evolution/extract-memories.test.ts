import { describe, expect, it, vi } from "vitest";
import { ProviderProtocolError } from "../../llm/errors.js";
import type { ChatParams } from "../../llm/types.js";
import { expectDefined } from "../../test/assertions.js";
import { mockProvider } from "../../test/factories.js";
import type { MemoryRule } from "../store/index.js";
import { extractTurnMemories, type MemoryExtractionDeps } from "./extract-memories.js";

const HEALTH_RULE: MemoryRule = {
  rule: "Don't save anything about my health.",
  profileId: null,
  fromUser: true,
};

const HOMELAB = {
  fact: "homelab IP is 10.0.10.10",
  network: "world",
  compartment: "technical",
  trust: "first-party",
  evidence: "My homelab IP is 10.0.10.10",
};

function reply(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    stopReason: "end_turn" as const,
    model: "mock",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function deps(
  answer: { memories: Array<Record<string, unknown>> },
  overrides?: Partial<MemoryExtractionDeps>,
): MemoryExtractionDeps {
  return {
    provider: mockProvider({ chat: vi.fn().mockResolvedValue(reply(JSON.stringify(answer))) }),
    model: "test-model",
    customCompartments: [],
    ...overrides,
  };
}

const TURN = { turn: "User: My homelab IP is 10.0.10.10", context: null };

function sent(d: MemoryExtractionDeps): ChatParams {
  return expectDefined(vi.mocked(d.provider.chat).mock.calls[0], "the extraction call")[0];
}

describe("extractTurnMemories", () => {
  it("returns the model's facts with their evidence", async () => {
    const d = deps({ memories: [{ ...HOMELAB, context: "while setting up DNS" }] });

    expect(await extractTurnMemories(TURN, [], d)).toEqual([
      { ...HOMELAB, context: "while setting up DNS" },
    ]);
  });

  it("sends the turn, after the exchange before it as context", async () => {
    const d = deps({ memories: [] });

    await extractTurnMemories({ turn: "User: and the NAS?", context: "User: hi" }, [], d);

    const { messages } = sent(d);
    expect(messages).toEqual([
      {
        role: "user",
        content:
          "<earlier_conversation>\nUser: hi\n</earlier_conversation>\n\n<turn>\nUser: and the NAS?\n</turn>",
      },
    ]);
  });

  it("lists the memory rules it is given, and the user's compartments, in the system prompt", async () => {
    const d = deps(
      { memories: [] },
      { customCompartments: [{ name: "dnd", description: "tabletop campaign facts" }] },
    );

    await extractTurnMemories(TURN, [HEALTH_RULE], d);

    const { system } = sent(d);
    expect(system).toContain("## Memory Rules");
    expect(system).toContain(HEALTH_RULE.rule);
    expect(system).toContain("**dnd**: tabletop campaign facts");
  });

  it("accepts a custom compartment and refuses one outside core and the user's", async () => {
    const custom = deps(
      { memories: [{ ...HOMELAB, compartment: "dnd" }] },
      { customCompartments: [{ name: "dnd", description: "campaign" }] },
    );
    expect(await extractTurnMemories(TURN, [], custom)).toEqual([
      { ...HOMELAB, compartment: "dnd" },
    ]);

    const unknown = deps({ memories: [{ ...HOMELAB, compartment: "dnd" }] });
    await expect(extractTurnMemories(TURN, [], unknown)).rejects.toThrow();
  });

  it("refuses a fact without evidence", async () => {
    const { evidence: _, ...unquoted } = HOMELAB;

    await expect(extractTurnMemories(TURN, [], deps({ memories: [unquoted] }))).rejects.toThrow();
  });

  it("throws a provider failure for the caller to classify", async () => {
    const d = deps(
      { memories: [] },
      {
        provider: mockProvider({
          chat: vi.fn().mockRejectedValue(new ProviderProtocolError("no tool call", null)),
        }),
      },
    );

    await expect(extractTurnMemories(TURN, [], d)).rejects.toBeInstanceOf(ProviderProtocolError);
  });

  it("recovers a trailing-comma response through chatTyped's repair", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(reply(`{"memories": [${JSON.stringify(HOMELAB)},]}`))
      .mockResolvedValueOnce(reply(JSON.stringify({ memories: [HOMELAB] })));
    const d = deps({ memories: [] }, { provider: mockProvider({ chat }) });

    expect(await extractTurnMemories(TURN, [], d)).toEqual([HOMELAB]);
  });
});
