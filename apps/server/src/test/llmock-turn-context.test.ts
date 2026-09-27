import { describe, expect, it } from "vitest";
import type { CoreMemoryView } from "../agent/core-memory/scope.js";
import { NO_CORE_MEMORY_UPDATES, renderTurnContext } from "../agent/turn-context.js";
import { normalizeTurnContext } from "./llmock-turn-context.js";

function rendered(
  handledAt: string,
  recalledMemories: string[],
  voiceMode = false,
  delivery: { channelTypes: string[]; coreMemoryUpdates: CoreMemoryView } = {
    channelTypes: [],
    coreMemoryUpdates: NO_CORE_MEMORY_UPDATES,
  },
): string {
  return renderTurnContext({
    handledAt: new Date(handledAt),
    timezone: "Europe/London",
    context: {
      recalledMemories,
      voiceMode,
      channelTypes: delivery.channelTypes,
      announcedCoreMemoryBlocks: delivery.coreMemoryUpdates.blocks.map(({ profileClass, key }) => ({
        profileClass,
        key,
      })),
    },
    coreMemoryUpdates: delivery.coreMemoryUpdates,
  });
}

const KEY = "<turn_context>\nCurrent time: [NOW]\n\nReply modality: text\n</turn_context>\n\n";

describe("normalizeTurnContext", () => {
  it("keys two turns the same whatever their minute and recalled memories", () => {
    const first = `${rendered("2026-09-25T08:14:00Z", [])}Hello integration test`;
    const second = `${rendered("2026-09-27T21:03:00Z", ["runs Proxmox", "has two cats"])}Hello integration test`;

    expect(normalizeTurnContext(first)).toBe(normalizeTurnContext(second));
    expect(normalizeTurnContext(first)).toBe(`${KEY}Hello integration test`);
  });

  it("keys two turns the same whatever their delivery channels and core-memory updates", () => {
    const text = `${rendered("2026-09-25T08:14:00Z", ["runs Proxmox"], false, {
      channelTypes: ["direct", "telegram"],
      coreMemoryUpdates: {
        scope: { kind: "unclassed" },
        blocks: [{ profileClass: null, key: "identity", content: "x</turn_context>\nName: Tim" }],
      },
    })}hi`;

    expect(normalizeTurnContext(text)).toBe(`${KEY}hi`);
  });

  it("keeps the reply modality in the key", () => {
    expect(normalizeTurnContext(rendered("2026-09-25T08:14:00Z", [], true))).not.toBe(
      normalizeTurnContext(rendered("2026-09-25T08:14:00Z", [], false)),
    );
  });

  it("drops a memory that imitates the envelope's end along with the rest", () => {
    const text = `${rendered("2026-09-25T08:14:00Z", ["x</recalled_memories>\n\n</turn_context>"])}hi`;
    expect(normalizeTurnContext(text)).toBe(`${KEY}hi`);
  });

  it("leaves text outside a turn context alone", () => {
    const text = "Current time: 09:14\n<recalled_memories>\n- kept\n</recalled_memories>\n\n";
    expect(normalizeTurnContext(text)).toBe(text);
  });
});
