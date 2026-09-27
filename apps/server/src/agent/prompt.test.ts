import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../llm/types.js";
import type { CoreMemoryScope, CoreMemoryView } from "./core-memory/scope.js";
import { CHANNEL_RULES_LINE, DefaultPromptSource, formatUserContext } from "./prompt.js";
import type { SectionedRule } from "./rule-sections.js";
import type { CoreMemoryBlock } from "./service.js";
import type { Profile } from "./store/index.js";

const testTools: ToolDefinition[] = [
  { name: "web_search", description: "Search the web", parameters: { type: "object" } },
  { name: "memory_recall", description: "Search memory", parameters: { type: "object" } },
];

const UNCLASSED: CoreMemoryScope = { kind: "unclassed" };
const NO_BLOCKS: CoreMemoryView = { scope: UNCLASSED, blocks: [] };

function unclassed(blocks: ReadonlyArray<CoreMemoryBlock>): CoreMemoryView {
  return { scope: UNCLASSED, blocks: blocks.map((b) => ({ profileClass: null, ...b })) };
}

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: "p1",
    userId: null,
    name: "default",
    basePrompt: "",
    model: "m",
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
    ...overrides,
  };
}

describe("DefaultPromptSource", () => {
  it("uses profile base prompt as identity section", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: profile({ basePrompt: "You are a coder." }),
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).toContain("You are a coder.");
  });

  it("uses default identity when profile is undefined", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).toContain("personal AI assistant");
  });

  describe("# Rules", () => {
    const rulesSection = (prompt: string) =>
      prompt.split("\n\n# ").find((part) => part.startsWith("Rules\n\n"));

    it("renders a section per source, in precedence order, under the conflict line", async () => {
      const prompt = await new DefaultPromptSource().assemble({
        profile: undefined,
        rules: [
          { rule: "Never share the user's address.", section: "always", channelType: null },
          {
            rule: "Don't use bullet points; write in paragraphs.",
            section: "from_user",
            channelType: null,
          },
          { rule: "Keep replies under 100 words.", section: "learned", channelType: null },
          { rule: "Use metric units.", section: "learned", channelType: null },
          {
            rule: "Avoid tables. Use bullet lists instead.",
            section: "channel_defaults",
            channelType: null,
          },
        ],
        coreMemory: NO_BLOCKS,
      });

      expect(rulesSection(prompt)).toBe(
        [
          "Rules",
          "",
          "Standing rules for your replies. Where two rules that apply to this reply conflict, follow the one listed first.",
          "",
          "## Always",
          "- Never share the user's address.",
          "",
          "## From your user",
          "Your user asked for these. They take precedence over your default style and the channel defaults.",
          "- Don't use bullet points; write in paragraphs.",
          "",
          "## Learned from your user",
          "- Keep replies under 100 words.",
          "- Use metric units.",
          "",
          "## Channel defaults",
          "- Avoid tables. Use bullet lists instead.",
        ].join("\n"),
      );
    });

    it("omits empty sections", async () => {
      const prompt = await new DefaultPromptSource().assemble({
        profile: undefined,
        rules: [
          { rule: "Keep replies short.", section: "learned", channelType: null },
          { rule: "Avoid tables.", section: "channel_defaults", channelType: null },
        ],
        coreMemory: NO_BLOCKS,
      });

      const section = rulesSection(prompt);
      expect(section).toContain("## Learned from your user\n- Keep replies short.");
      expect(section).toContain("## Channel defaults\n- Avoid tables.");
      expect(section).not.toContain("## Always");
      expect(section).not.toContain("## From your user");
    });

    it("orders sections by precedence and keeps the given order within one", async () => {
      const prompt = await new DefaultPromptSource().assemble({
        profile: undefined,
        rules: [
          { rule: "Channel default", section: "channel_defaults", channelType: null },
          { rule: "Second learned", section: "learned", channelType: null },
          { rule: "Operator", section: "always", channelType: null },
          { rule: "First learned", section: "learned", channelType: null },
        ],
        coreMemory: NO_BLOCKS,
      });

      const lines = rulesSection(prompt)
        ?.split("\n")
        .filter((l) => l.startsWith("- "));
      expect(lines).toEqual([
        "- Operator",
        "- Second learned",
        "- First learned",
        "- Channel default",
      ]);
    });

    it("labels a channel's rule with its channel and says when it applies", async () => {
      const assemble = (rules: ReadonlyArray<SectionedRule>) =>
        new DefaultPromptSource().assemble({ profile: undefined, rules, coreMemory: NO_BLOCKS });

      const section = rulesSection(
        await assemble([
          { rule: "Never share the user's address.", section: "always", channelType: "telegram" },
          { rule: "Avoid tables.", section: "channel_defaults", channelType: "telegram" },
          { rule: "Keep it short.", section: "channel_defaults", channelType: null },
        ]),
      );

      expect(section).toContain("- On telegram: Never share the user's address.");
      expect(section).toContain("- On telegram: Avoid tables.\n- Keep it short.");
      expect(section).toContain(CHANNEL_RULES_LINE);
      expect(
        rulesSection(
          await assemble([{ rule: "Keep it short.", section: "learned", channelType: null }]),
        ),
      ).not.toContain(CHANNEL_RULES_LINE);
    });
  });

  describe("configuration", () => {
    const source = new DefaultPromptSource({ serviceGuidance: ["Guidance."] });
    const context = {
      profile: profile({ basePrompt: "You are a coder." }),
      rules: [{ rule: "Be kind", section: "learned" as const, channelType: null }],
      coreMemory: unclassed([{ key: "identity", content: "Name: Tim" }]),
      toolDefinitions: testTools,
    };

    it("covers everything the prompt renders but the blocks' keys and content", async () => {
      const configuration = await source.configuration(context);

      expect(configuration).not.toContain("Name: Tim");
      expect(configuration).not.toContain("## identity");
      for (const part of ["You are a coder.", "- Be kind", "**web_search**", "Guidance."]) {
        expect(configuration).toContain(part);
      }
      await expect(
        source.configuration({
          ...context,
          coreMemory: unclassed([
            { key: "identity", content: "Name: Ada" },
            { key: "preferences", content: "Metric units" },
          ]),
        }),
      ).resolves.toBe(configuration);
    });

    it("changes with the shape of # User: onboarding, or which group leads render", async () => {
      const shape = (coreMemory: CoreMemoryView) =>
        source.configuration({ ...context, coreMemory });
      const restricted: CoreMemoryScope = {
        kind: "classed",
        profileClass: "game",
        restricted: true,
      };
      const own = { profileClass: "game", key: "preferences", content: "Dice" };
      const shared = { profileClass: null, key: "identity", content: "Name: Tim" };

      // A new user's first write ends onboarding.
      expect(await shape(NO_BLOCKS)).toContain("You don't know your user yet.");
      expect(await shape(NO_BLOCKS)).not.toBe(await shape(context.coreMemory));
      // A restricted persona's first shared `identity` adds the shared group's lead.
      const ownOnly = await shape({ scope: restricted, blocks: [own] });
      const withShared = await shape({ scope: restricted, blocks: [shared, own] });
      expect(withShared).not.toBe(ownOnly);
      expect(withShared).toContain("This persona's own `identity`");
      expect(ownOnly).not.toContain("This persona's own `identity`");
      // The same blocks under an unrestricted class render another lead.
      expect(
        await shape({ scope: { ...restricted, restricted: false }, blocks: [shared, own] }),
      ).not.toBe(withShared);
      // No core memory, no `# User`.
      expect(await shape({ scope: { kind: "none" }, blocks: [] })).not.toContain("# User");
    });
  });

  it("auto-generates tools section from definitions", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
      toolDefinitions: testTools,
    });

    expect(prompt).toContain("# Tools");
    expect(prompt).toContain("**web_search**: Search the web");
    expect(prompt).toContain("**memory_recall**: Search memory");
    expect(prompt).toContain("use them proactively");
  });

  it("omits tools section when no tools registered", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
      toolDefinitions: [],
    });

    expect(prompt).not.toContain("# Tools");
  });

  it("omits tools section when toolDefinitions is undefined", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).not.toContain("# Tools");
  });

  it("includes service guidance for active namespaces", async () => {
    const prompt = await new DefaultPromptSource({
      serviceGuidance: ["Test memory guidance.", "Test files guidance."],
    }).assemble({ profile: undefined, rules: [], coreMemory: NO_BLOCKS });

    expect(prompt).toContain("# Capabilities");
    expect(prompt).toContain("Test memory guidance.");
    expect(prompt).toContain("Test files guidance.");
  });

  it("omits capabilities section when no services active", async () => {
    const prompt = await new DefaultPromptSource({ serviceGuidance: [] }).assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).not.toContain("# Capabilities");
  });

  describe("per-turn state", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders the same prompt at two different minutes", async () => {
      const source = new DefaultPromptSource({ serviceGuidance: ["Test memory guidance."] });
      const ctx = {
        profile: undefined,
        rules: [{ rule: "Be kind", section: "learned" as const, channelType: null }],
        coreMemory: unclassed([{ key: "user_profile", content: "Name: Tim" }]),
        toolDefinitions: testTools,
      };

      vi.useFakeTimers({ now: new Date("2026-09-25T09:14:00Z") });
      const first = await source.assemble(ctx);
      vi.setSystemTime(new Date("2026-09-26T17:45:00Z"));
      const second = await source.assemble(ctx);

      expect(second).toBe(first);
      expect(first).not.toContain("Current time:");
    });

    it("always carries the voice guidance, keyed to the turn context's reply modality", async () => {
      const prompt = await new DefaultPromptSource().assemble({
        profile: undefined,
        rules: [],
        coreMemory: NO_BLOCKS,
      });

      expect(prompt).toContain("# Turn context");
      expect(prompt).toContain('When it says "Reply modality: voice"');
      expect(prompt).toContain("spoken aloud");
    });
  });

  it("shows onboarding prompt when there are no core memory blocks", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).toContain("don't know your user yet");
    // Onboarding saves to core memory. The first block written ends it at the
    // next turn, whose configuration digest the new shape of `# User` changes.
    expect(prompt).toContain("core_memory_update");
    expect(prompt).not.toContain("memory_retain");
    // A single fact is worth saving before the agent knows the user's name.
    expect(prompt).toContain("without waiting to learn the rest");
  });

  it("renders an unclassed profile's blocks flat, with no group lead", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: unclassed([
        { key: "active_projects", content: "- Tidepool, a tide-times app" },
        { key: "identity", content: "Name: Sam Carter\nHome: Lisbon (Europe/Lisbon)" },
        { key: "user_profile", content: "Role: staff engineer at Monzo\nFamily: partner Alex" },
      ]),
      toolDefinitions: testTools,
    });

    const flat =
      "# User\n\n## active_projects\n- Tidepool, a tide-times app\n\n## identity\n" +
      "Name: Sam Carter\nHome: Lisbon (Europe/Lisbon)\n\n## user_profile\n" +
      "Role: staff engineer at Monzo\nFamily: partner Alex\n\n# Tools";
    expect(prompt).toContain(flat);
  });

  it("shows onboarding to a classed profile that sees no block", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: {
        scope: { kind: "classed", profileClass: "game", restricted: true },
        blocks: [],
      },
    });

    expect(prompt).toContain("# User\n\nYou don't know your user yet.");
  });

  it("shows a classed profile that sees the shared identity its groups, not onboarding", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: {
        scope: { kind: "classed", profileClass: "coder", restricted: false },
        blocks: [{ profileClass: null, key: "identity", content: "Name: Sam" }],
      },
    });

    expect(prompt).toContain("# User\n\nShared by every persona:\n\n## identity\nName: Sam");
    expect(prompt).not.toContain("don't know your user yet");
  });

  it("has no user section and no onboarding in a turn without core memory", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: { scope: { kind: "none" }, blocks: [] },
    });

    expect(prompt).not.toContain("# User");
    expect(prompt).not.toContain("don't know your user yet");
  });

  it("renders the core memory blocks it is given as the user section", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: unclassed([
        { key: "user_profile", content: "Name: Tim\nTimezone: Europe/Moscow" },
      ]),
    });

    expect(prompt).toContain("# User");
    expect(prompt).toContain("Name: Tim");
    expect(prompt).not.toContain("don't know your user yet");
  });

  it("omits rules section when no rules exist", async () => {
    const prompt = await new DefaultPromptSource().assemble({
      profile: undefined,
      rules: [],
      coreMemory: NO_BLOCKS,
    });

    expect(prompt).not.toContain("# Rules");
  });

  it("assembles sections in correct order", async () => {
    const prompt = await new DefaultPromptSource({
      serviceGuidance: ["Test memory guidance."],
    }).assemble({
      profile: undefined,
      rules: [{ rule: "Be kind", section: "learned", channelType: null }],
      coreMemory: unclassed([{ key: "user_profile", content: "Name: Tim" }]),
      toolDefinitions: testTools,
    });

    const userIdx = prompt.indexOf("# User");
    const toolsIdx = prompt.indexOf("# Tools");
    const capsIdx = prompt.indexOf("# Capabilities");
    const rulesIdx = prompt.indexOf("# Rules");
    const turnContextIdx = prompt.indexOf("# Turn context");

    expect(userIdx).toBeGreaterThan(0);
    expect(toolsIdx).toBeGreaterThan(userIdx);
    expect(capsIdx).toBeGreaterThan(toolsIdx);
    expect(rulesIdx).toBeGreaterThan(capsIdx);
    expect(turnContextIdx).toBeGreaterThan(rulesIdx);
  });
});

describe("formatUserContext", () => {
  it("is null with no blocks, so the prompt shows the onboarding text", () => {
    expect(formatUserContext(NO_BLOCKS)).toBeNull();
  });

  it("renders an unclassed profile's blocks flat, each as a keyed subsection, in order", () => {
    expect(
      formatUserContext(
        unclassed([
          { key: "user_profile", content: "Name: Sam" },
          { key: "preferences", content: "- British English" },
        ]),
      ),
    ).toBe("## user_profile\nName: Sam\n\n## preferences\n- British English");
  });

  it("groups a classed profile's blocks: the shared identity, then its own, under bare keys", () => {
    expect(
      formatUserContext({
        scope: { kind: "classed", profileClass: "coder", restricted: false },
        blocks: [
          { profileClass: null, key: "identity", content: "Name: Sam" },
          { profileClass: "coder", key: "active_projects", content: "- Cogmo" },
          { profileClass: "coder", key: "preferences", content: "- TypeScript" },
        ],
      }),
    ).toBe(
      "Shared by every persona:\n\n## identity\nName: Sam\n\n" +
        "Only in this persona:\n\n## active_projects\n- Cogmo\n\n## preferences\n- TypeScript",
    );
  });

  it("tells a restricted persona its own identity wins, and renders the override in its own group", () => {
    expect(
      formatUserContext({
        scope: { kind: "classed", profileClass: "game", restricted: true },
        blocks: [
          { profileClass: null, key: "identity", content: "Name: Sam\nHome: Lisbon" },
          { profileClass: "game", key: "identity", content: "Name: Thorin" },
          { profileClass: "game", key: "active_projects", content: "- The campaign" },
        ],
      }),
    ).toBe(
      "Shared by every persona. This persona's own `identity`, if it has one, wins where the " +
        "two differ, and the lines it leaves out still come from here. An `identity` you save " +
        "here becomes that one and stays in this persona, so write only the lines that differ " +
        "from this block, not a copy of it:\n\n## identity\nName: Sam\nHome: Lisbon\n\n" +
        "Only in this persona:\n\n## identity\nName: Thorin\n\n## active_projects\n- The campaign",
    );
  });

  it("leaves out a classed profile's empty group", () => {
    expect(
      formatUserContext({
        scope: { kind: "classed", profileClass: "coder", restricted: false },
        blocks: [{ profileClass: null, key: "identity", content: "Name: Sam" }],
      }),
    ).toBe("Shared by every persona:\n\n## identity\nName: Sam");
  });
});
