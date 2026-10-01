import { describe, expect, it, vi } from "vitest";
import { ProviderProtocolError } from "../../llm/errors.js";
import type { Message } from "../../llm/types.js";
import { logger } from "../../logger.js";
import { expectDefined } from "../../test/assertions.js";
import { mockProvider } from "../../test/factories.js";
import type { MemoryRule } from "../store/index.js";
import type { ObserverFire } from "./drain-pending-memories.js";
import type { ObserverTranscript } from "./extract-corrections.js";
import { extractMemories, type MemoryExtractionDeps } from "./extract-memories.js";

const HEALTH_RULE: MemoryRule = {
  rule: "Don't save anything about my health.",
  profileId: null,
  fromUser: true,
};

const FIRE: ObserverFire = {
  conversationId: "conv-1",
  userId: "user-1",
  profileId: "profile-1",
  seesUserRules: true,
};
const THIRD_PARTY_FIRE: ObserverFire = { ...FIRE, seesUserRules: false };

function mockExtractionDeps(
  chatTypedResponse: { memories: Array<Record<string, unknown>> },
  overrides?: Partial<MemoryExtractionDeps>,
): MemoryExtractionDeps {
  const provider = mockProvider({
    chat: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify(chatTypedResponse) }],
      stopReason: "end_turn",
      model: "mock",
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  });

  return {
    provider,
    model: "test-model",
    memory: {
      retainBatch: vi.fn().mockResolvedValue(undefined),
    },
    customCompartments: [],
    memoryRules: [],
    fire: FIRE,
    ...overrides,
  };
}

const sampleHistory: Message[] = [
  { role: "user", content: "My homelab IP is 10.0.10.10 and I prefer dark mode." },
  { role: "assistant", content: "Got it! I'll remember your homelab IP and preference." },
  { role: "user", content: "Also, I usually work on infrastructure stuff on weekends." },
  { role: "assistant", content: "Noted — weekends are infrastructure time." },
];

/** A chunk of new messages with nothing before it, ending at `throughMessageId`. */
function chunkOf(
  messages: ReadonlyArray<Message>,
  throughMessageId = "msg-chunk-end",
): ObserverTranscript {
  return { summary: null, context: [], messages, throughMessageId };
}

const sampleChunk = chunkOf(sampleHistory);

describe("extractMemories", () => {
  it("returns zeros for empty transcript", async () => {
    const deps = mockExtractionDeps({ memories: [] });
    const result = await extractMemories(chunkOf([]), "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {}, skippedForUnseenRules: 0 });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(deps.provider.chat).not.toHaveBeenCalled();
  });

  it("returns zeros when no memories extracted", async () => {
    const deps = mockExtractionDeps({ memories: [] });
    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {}, skippedForUnseenRules: 0 });
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("extracts and retains memories with network, compartment, and trust tags", async () => {
    const deps = mockExtractionDeps({
      memories: [
        {
          fact: "homelab IP is 10.0.10.10",
          network: "world",
          compartment: "technical",
          trust: "first-party",
        },
        {
          fact: "prefers dark mode",
          network: "bank",
          compartment: "personal",
          trust: "any",
        },
      ],
    });

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.extracted).toBe(2);
    expect(result.byNetwork).toEqual({ world: 1, bank: 1 });
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "homelab IP is 10.0.10.10",
        documentId: "observer:conv-1:msg-chunk-end:0",
        tags: ["network:world", "compartment:technical", "trust:first-party"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
      {
        content: "prefers dark mode",
        documentId: "observer:conv-1:msg-chunk-end:1",
        tags: ["network:bank", "compartment:personal", "trust:any"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("passes context when provided by extraction", async () => {
    const deps = mockExtractionDeps({
      memories: [
        {
          fact: "wife's birthday is March 15",
          network: "bank",
          compartment: "personal",
          trust: "first-party",
          context: "mentioned while planning a gift",
        },
      ],
    });

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.extracted).toBe(1);
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      {
        content: "wife's birthday is March 15",
        documentId: "observer:conv-1:msg-chunk-end:0",
        context: "mentioned while planning a gift",
        tags: ["network:bank", "compartment:personal", "trust:first-party"],
        metadata: { source: "conversation" },
        observationScopes: "per_tag",
      },
    ]);
  });

  it("counts by network correctly", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "fact 1", network: "world", compartment: "technical", trust: "first-party" },
        { fact: "fact 2", network: "world", compartment: "technical", trust: "first-party" },
        { fact: "fact 3", network: "observation", compartment: "personal", trust: "first-party" },
        { fact: "fact 4", network: "opinion", compartment: "personal", trust: "first-party" },
      ],
    });

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.extracted).toBe(4);
    expect(result.byNetwork).toEqual({ world: 2, observation: 1, opinion: 1 });
  });

  it("names the same documents on a re-run of a chunk, and other documents for another chunk", async () => {
    const answer = {
      memories: [
        { fact: "fact 1", network: "world", compartment: "technical", trust: "first-party" },
        { fact: "fact 2", network: "bank", compartment: "personal", trust: "first-party" },
      ],
    };
    const documentIds = async (chunk: ObserverTranscript) => {
      const deps = mockExtractionDeps(answer);
      await extractMemories(chunk, "user-1", null, deps);
      const [, items] = expectDefined(vi.mocked(deps.memory.retainBatch).mock.calls[0], "retain");
      return items.map((i) => i.documentId);
    };

    const first = await documentIds(chunkOf(sampleHistory, "msg-a"));
    const rerun = await documentIds(chunkOf(sampleHistory, "msg-a"));
    const next = await documentIds(chunkOf(sampleHistory, "msg-b"));

    expect(first).toEqual(["observer:conv-1:msg-a:0", "observer:conv-1:msg-a:1"]);
    expect(rerun).toEqual(first);
    expect(next).toEqual(["observer:conv-1:msg-b:0", "observer:conv-1:msg-b:1"]);
  });

  it("sends the earlier conversation as context and the chunk as the new messages", async () => {
    const deps = mockExtractionDeps({ memories: [] });

    await extractMemories(
      {
        summary: "The user is moving abroad.",
        context: [{ role: "user", content: "My sister lives in Porto." }],
        messages: [{ role: "user", content: "I'm moving near her in May." }],
        throughMessageId: "m",
      },
      "user-1",
      null,
      deps,
    );

    const call = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call")[0];
    const content = expectDefined(call.messages[0], "user message").content;
    expect(content).toContain(
      "<earlier_conversation>\n<summary>\nThe user is moving abroad.\n</summary>",
    );
    expect(content).toContain("<new_messages>\nUser: I'm moving near her in May.\n</new_messages>");
    expect(call.system).toContain("extract nothing from it");
    expect(call.system).toContain("Analyze the new messages below and extract facts");
  });

  it("uses bankId as the Hindsight bank", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleChunk, "ti", null, deps);

    expect(deps.memory.retainBatch).toHaveBeenCalledWith("ti", expect.any(Array));
  });

  it("throws on a failed model call, so the chunk stays unobserved", async () => {
    const deps = mockExtractionDeps(
      { memories: [] },
      {
        provider: mockProvider({
          chat: vi.fn().mockRejectedValue(new Error("LLM timeout")),
        }),
      },
    );

    await expect(extractMemories(sampleChunk, "user-1", null, deps)).rejects.toThrow("LLM timeout");
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("throws when the structured output can't be parsed", async () => {
    // chatTyped surfaces an irrecoverable parse as a ProviderProtocolError;
    // the step's retries, then the phase's failure, handle it.
    const deps = mockExtractionDeps(
      { memories: [] },
      {
        provider: mockProvider({
          chat: vi
            .fn()
            .mockRejectedValue(
              new ProviderProtocolError(
                'structured output for "memory-extraction" failed JSON.parse: empty input',
                new SyntaxError("Unexpected end of JSON input"),
              ),
            ),
        }),
      },
    );

    await expect(extractMemories(sampleChunk, "user-1", null, deps)).rejects.toThrow(
      ProviderProtocolError,
    );
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("appends profile_class tag when profileClass is non-null", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleChunk, "user-1", "intimate", deps);

    const call = vi.mocked(deps.memory.retainBatch).mock.calls[0];
    const items = call?.[1] ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.tags).toContain("profile_class:intimate");
  });

  it("omits profile_class tag when profileClass is null", async () => {
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleChunk, "user-1", null, deps);

    const call = vi.mocked(deps.memory.retainBatch).mock.calls[0];
    const items = call?.[1] ?? [];
    expect(items[0]?.tags).not.toContainEqual(expect.stringMatching(/^profile_class:/));
  });

  it("templates customCompartments names + descriptions into the system prompt", async () => {
    const customs = [
      { name: "dnd", description: "tabletop campaign notes" },
      { name: "music", description: "music production sessions" },
    ];
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ memories: [] }) }],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const deps: MemoryExtractionDeps = {
      provider,
      model: "test-model",
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      customCompartments: customs,
      memoryRules: [],
      fire: FIRE,
    };

    await extractMemories(sampleChunk, "user-1", null, deps);

    // Single chat call; the system prompt is the second positional arg
    // shape on `provider.chat({ system, messages, ... })`. Inspect it
    // directly so the assertion is robust to small wrapper changes.
    const call = vi.mocked(provider.chat).mock.calls[0]?.[0];
    const system = (call as { system?: string } | undefined)?.system ?? "";
    expect(system).toContain("**dnd**: tabletop campaign notes");
    expect(system).toContain("**music**: music production sessions");
    expect(system).toContain("Custom compartments");
  });

  it("lists the memory rules it is given in the system prompt", async () => {
    const deps = mockExtractionDeps({ memories: [] }, { memoryRules: [HEALTH_RULE] });

    await extractMemories(sampleChunk, "user-1", null, deps);

    const call = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call");
    expect(call[0].system).toContain("## Memory Rules");
    expect(call[0].system).toContain("- Don't save anything about my health.");
  });

  it("skips extraction, and counts it, when a user's rule binds a profile that can't see it", async () => {
    const deps = mockExtractionDeps(
      { memories: [{ fact: "x", network: "world", compartment: "misc", trust: "any" }] },
      { memoryRules: [HEALTH_RULE], fire: THIRD_PARTY_FIRE },
    );
    const info = vi.spyOn(logger, "info");

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result).toEqual({ extracted: 0, byNetwork: {}, skippedForUnseenRules: 1 });
    expect(deps.provider.chat).not.toHaveBeenCalled();
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        profileId: "profile-1",
        userId: "user-1",
      }),
      expect.stringContaining("skipped"),
    );
    info.mockRestore();
  });

  it("extracts under an operator's memory rule in a profile that can't see the user's", async () => {
    const deps = mockExtractionDeps(
      { memories: [] },
      { memoryRules: [{ ...HEALTH_RULE, fromUser: false }], fire: THIRD_PARTY_FIRE },
    );

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.skippedForUnseenRules).toBe(0);
    const call = expectDefined(vi.mocked(deps.provider.chat).mock.calls[0], "chat call");
    expect(call[0].system).toContain("- Don't save anything about my health.");
  });

  it("retains memories with a custom compartment value emitted by the LLM", async () => {
    const customs = [{ name: "dnd", description: "tabletop campaign notes" }];
    const deps = mockExtractionDeps(
      {
        memories: [
          {
            fact: "campaign uses Stars Without Number rules",
            network: "world",
            compartment: "dnd",
            trust: "first-party",
          },
        ],
      },
      { customCompartments: customs },
    );

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.extracted).toBe(1);
    expect(deps.memory.retainBatch).toHaveBeenCalledWith("user-1", [
      expect.objectContaining({
        content: "campaign uses Stars Without Number rules",
        tags: ["network:world", "compartment:dnd", "trust:first-party"],
      }),
    ]);
  });

  it("rejects an LLM-emitted compartment value not in core ∪ customs (schema enforcement)", async () => {
    // The structured-output schema is locked to `[...CORE, ...customNames]`
    // — a stale prompt or LLM hallucination producing "music" with no
    // matching custom row fails the parse, and nothing reaches Hindsight.
    // Without per-fire schema construction, the value would slip through as
    // a tag the recall predicate can never match, silently inflating
    // misc-bucket noise.
    const deps = mockExtractionDeps(
      {
        memories: [
          {
            fact: "x",
            network: "world",
            compartment: "music",
            trust: "first-party",
          },
        ],
      },
      { customCompartments: [{ name: "dnd", description: "x" }] },
    );

    await expect(extractMemories(sampleChunk, "user-1", null, deps)).rejects.toThrow();
    expect(deps.memory.retainBatch).not.toHaveBeenCalled();
  });

  it("omits profile_class tag when profileClass is undefined (Inngest replay safety)", async () => {
    // The signature is `string | null`, but Inngest's step memoization
    // can replay this function with a stale shape that drops the arg —
    // arriving as `undefined`. Bare `!== null` would emit
    // `profile_class:undefined`; the typeof guard catches both.
    const deps = mockExtractionDeps({
      memories: [
        { fact: "a fact", network: "world", compartment: "technical", trust: "first-party" },
      ],
    });

    await extractMemories(sampleChunk, "user-1", undefined as unknown as string | null, deps);

    const call = vi.mocked(deps.memory.retainBatch).mock.calls[0];
    const items = call?.[1] ?? [];
    expect(items[0]?.tags).not.toContainEqual(expect.stringMatching(/^profile_class:/));
  });

  it("recovers a trailing-comma extraction response via chatTyped repair", async () => {
    // Regression: extract-memories passes `repair: {}` into chatTyped, so a
    // trailing comma in the structured-output response is fixed by the
    // jsonrepair pre-pass instead of crashing the extraction run.
    const provider = mockProvider({
      chat: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"memories":[{"fact":"homelab IP is 10.0.10.10","network":"world","compartment":"technical","trust":"first-party",},],}',
          },
        ],
        stopReason: "end_turn",
        model: "mock",
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const deps: MemoryExtractionDeps = {
      provider,
      model: "test-model",
      memory: { retainBatch: vi.fn().mockResolvedValue(undefined) },
      customCompartments: [],
      memoryRules: [],
      fire: FIRE,
    };

    const result = await extractMemories(sampleChunk, "user-1", null, deps);

    expect(result.extracted).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });
});
