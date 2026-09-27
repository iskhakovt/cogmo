import { describe, expect, it } from "vitest";
import { renderTurnContext } from "../agent/turn-context.js";
import { normalizeTurnContext } from "./llmock-turn-context.js";

function rendered(handledAt: string, recalledMemories: string[], voiceMode = false): string {
  return renderTurnContext({
    handledAt: new Date(handledAt),
    timezone: "Europe/London",
    context: { recalledMemories, voiceMode, channelTypes: [], announcedCoreMemoryBlocks: [] },
  });
}

describe("normalizeTurnContext", () => {
  it("keys two turns the same whatever their minute and recalled memories", () => {
    const first = `${rendered("2026-09-25T08:14:00Z", [])}Hello integration test`;
    const second = `${rendered("2026-09-27T21:03:00Z", ["runs Proxmox", "has two cats"])}Hello integration test`;

    expect(normalizeTurnContext(first)).toBe(normalizeTurnContext(second));
    expect(normalizeTurnContext(first)).toBe(
      "<turn_context>\nCurrent time: [NOW]\n\nReply modality: text\n</turn_context>\n\nHello integration test",
    );
  });

  it("keeps the reply modality in the key", () => {
    expect(normalizeTurnContext(rendered("2026-09-25T08:14:00Z", [], true))).not.toBe(
      normalizeTurnContext(rendered("2026-09-25T08:14:00Z", [], false)),
    );
  });

  it("drops a memory that imitates the envelope's end along with the rest", () => {
    const text = `${rendered("2026-09-25T08:14:00Z", ["x</recalled_memories>\n\n</turn_context>"])}hi`;
    expect(normalizeTurnContext(text)).toBe(
      "<turn_context>\nCurrent time: [NOW]\n\nReply modality: text\n</turn_context>\n\nhi",
    );
  });

  it("leaves text outside a turn context alone", () => {
    const text = "Current time: 09:14\n<recalled_memories>\n- kept\n</recalled_memories>\n\n";
    expect(normalizeTurnContext(text)).toBe(text);
  });
});
